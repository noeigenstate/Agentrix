const fs = require('node:fs');
const { OversizedLine } = require('./oversized-record.cjs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { transcriptWindow } = require('./transcript-window.cjs');

const ROLLOUT = /^rollout-.*\.jsonl$/;
// Without a watcher every file is looked at again this often. With one, only the files it reports are;
// a walk of the folder names and a rarer full walk remain as a safety net for events that never arrive
// (some network folders).
const WALK_INTERVAL = 2000, NAMES_INTERVAL = 10000, WATCHED_WALK_INTERVAL = 5 * 60000, IDLE_CLOSE = 60000, META_LIMIT = 5000;

async function* records(filename, { historyWindow = false } = {}) {
  const window = historyWindow ? transcriptWindow((await fsp.stat(filename)).size) : { offset: 0, skipping: false };
  let buffer = Buffer.alloc(0); let skipping = window.skipping, oversized = null;
  for await (const chunk of fs.createReadStream(filename, { start: window.offset, highWaterMark: 64 * 1024 })) {
    buffer = Buffer.concat([buffer, chunk]);
    let index;
    while ((index = buffer.indexOf(10)) >= 0) {
      const line = buffer.subarray(0, index);
      buffer = buffer.subarray(index + 1);
      // An oversized line ends here: a generated picture's record is rebuilt from its two ends.
      const long = oversized ?? (!skipping && line.length > 1024 * 1024 ? new OversizedLine(Buffer.alloc(0)) : null);
      if (long) { long.add(line); const record = long.record(); if (record) yield record; }
      else if (!skipping) { try { yield JSON.parse(line.toString('utf8')); } catch { } }
      skipping = false; oversized = null;
    }
    if (buffer.length > 1024 * 1024) {
      if (oversized) oversized.add(buffer); else if (!skipping) oversized = new OversizedLine(buffer);
      buffer = Buffer.alloc(0); skipping = true;
    }
  }
  if (buffer.length && !skipping) { try { yield JSON.parse(buffer.toString('utf8')); } catch { } }
}

// libuv can abort on Windows 8.3 aliases. Resolve only the OS watch path, keeping caller-visible paths intact.
function nativeWatchPath(filename) {
  try { return fs.realpathSync.native(filename); } catch { return filename; }
}

// Codex keeps every conversation as sessions/<year>/<month>/<day>/rollout-*.jsonl, thousands of files
// after a few months. Each terminal needs their modification times to find its own conversation, so one
// listing per sessions folder is shared by all terminals and kept current by a directory watcher.
class SessionFiles {
  constructor(directory) { this.directory = directory; this.files = new Map(); this.changed = new Set(); this.namesAt = 0; this.walkedAt = 0; this.missed = false; }
  watch() {
    if (this.watcher) return;
    // Node 24 watches a missing folder without an error and never reports anything from it. Until the folder
    // exists, every listing walks it; the first listing after it appears starts the watcher.
    if (!fs.existsSync(this.directory)) return;
    const watchDirectory = nativeWatchPath(this.directory);
    try {
      this.watcher = fs.watch(watchDirectory, { recursive: true, persistent: false }, (_type, name) => {
        // When the watched folder itself is deleted, Windows reports its own absolute path without end.
        // Stop watching at once; the next listing starts a new watcher if the folder is there again.
        // macOS reports only the folder's own name, once, and nothing for the files that went with it.
        const reported = String(name);
        const ownName = reported === path.basename(this.directory) || reported === path.basename(watchDirectory);
        if (name && (path.isAbsolute(reported) || ownName && !fs.existsSync(this.directory))) { this.unwatch(); this.missed = true; }
        else if (name) this.changed.add(path.join(this.directory, reported));
        // Linux reports an empty name once when the watched folder itself is deleted, and the watcher then
        // stays open on a folder that no longer exists.
        else { this.missed = true; if (!fs.existsSync(this.directory)) this.unwatch(); }
      });
      this.watcher.on('error', () => this.unwatch());
      // Changes made before the watcher started are unknown.
      this.missed = true;
    } catch { this.watcher = null; }
  }
  unwatch() { try { this.watcher?.close(); } catch { } this.watcher = null; }
  // full: read every file's modification time again. Otherwise only files not seen before are read.
  async walk(full) {
    const files = new Map();
    const visit = async (folder, depth) => {
      let entries; try { entries = await fsp.readdir(folder, { withFileTypes: true }); } catch { return; }
      await Promise.all(entries.map(async entry => {
        const filename = path.join(folder, entry.name);
        if (entry.isDirectory()) { if (depth < 8) await visit(filename, depth + 1); }
        else if (entry.isFile() && ROLLOUT.test(entry.name)) {
          const known = !full && this.files.get(filename);
          try { files.set(filename, known || { filename, name: entry.name, modified: (await fsp.stat(filename)).mtimeMs }); } catch { }
        }
      }));
    };
    await visit(this.directory, 0);
    this.files = files;
  }
  async update() {
    const changed = [...this.changed]; this.changed.clear();
    await Promise.all(changed.map(async filename => {
      const name = path.basename(filename);
      if (!ROLLOUT.test(name)) return;
      try {
        const stat = await fsp.stat(filename);
        if (stat.isFile()) this.files.set(filename, { filename, name, modified: stat.mtimeMs }); else this.files.delete(filename);
      } catch { this.files.delete(filename); }
    }));
  }
  async refresh() {
    // Nothing asks once the last Codex session has closed; release the watcher then.
    clearTimeout(this.idle);
    this.idle = setTimeout(() => { this.unwatch(); if (listings.get(this.directory) === this) listings.delete(this.directory); }, IDLE_CLOSE);
    this.idle.unref?.();
    // A watched folder that is gone is not always reported (macOS drops the event now and then): its listing is stale.
    if (this.watcher && !fs.existsSync(this.directory)) { this.unwatch(); this.missed = true; }
    this.watch();
    const full = !this.walkedAt || this.missed || Date.now() - this.walkedAt >= (this.watcher ? WATCHED_WALK_INTERVAL : WALK_INTERVAL);
    if (full || Date.now() - this.namesAt >= NAMES_INTERVAL) {
      if (full) { this.missed = false; this.changed.clear(); }
      await this.walk(full);
      this.namesAt = Date.now(); if (full) this.walkedAt = this.namesAt;
    }
    if (this.changed.size) await this.update();
    return [...this.files.values()];
  }
  // Terminals asking at the same time share one read.
  list() {
    if (this.pending) return this.pending;
    const pending = this.pending = this.refresh().finally(() => { if (this.pending === pending) this.pending = null; });
    return pending;
  }
}

const listings = new Map();
// Every rollout file under a sessions folder as { filename, name, modified }, in no particular order.
function rolloutFiles(directory) {
  let listing = listings.get(directory);
  if (!listing) listings.set(directory, listing = new SessionFiles(directory));
  return listing.list();
}

// A rollout file opens with its session_meta record, which never changes, so it is read once per file.
// Gives { id, cwd, source }, or null when the file does not start with one (or is still empty).
const metas = new Map();
async function sessionMeta(filename) {
  if (metas.has(filename)) return metas.get(filename);
  for await (const record of records(filename)) {
    const payload = record.type === 'session_meta' && record.payload ? record.payload : null;
    const meta = payload ? { id: payload.id, cwd: payload.cwd, source: payload.source } : null;
    if (metas.size >= META_LIMIT) metas.delete(metas.keys().next().value);
    metas.set(filename, meta);
    return meta;
  }
  return null;
}

module.exports = { records, rolloutFiles, sessionMeta, nativeWatchPath };
