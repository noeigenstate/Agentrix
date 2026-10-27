const fs = require('node:fs/promises');
const { watch: watchFile } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { interactiveSession } = require('./session-restore.cjs');
const { rolloutFiles, sessionMeta } = require('./session-files.cjs');
const { transcriptWindow, LIVE_READ_LIMIT, codexMetadata } = require('./transcript-window.cjs');
const { readTranscriptChunk } = require('./oversized-record.cjs');
const { sameThread } = require('./terminal-title.cjs');
const { promptText } = require('./prompt-queue.cjs');
const { CompletionHistory } = require('./completion-history.cjs');

// Only interactive rollout files can own a project card. A child agent can
// inherit notify, but its completion does not end the interactive parent turn.
class CodexActivityReader {
  constructor(cwd, home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), since = Date.now(), options = {}) {
    this.cwd = cwd; this.directory = path.join(home, 'sessions'); this.since = since;
    this.options = options; this.boundThread = null;
    this.offset = 0; this.buffer = Buffer.alloc(0); this.skipping = false; this.oversized = null;
    this.snapshot = null; this.nextDiscovery = 0;
  }
  async discover() {
    if (Date.now() < this.nextDiscovery) return;
    this.nextDiscovery = Date.now() + 2000;
    // The listing is shared with the other terminals and kept current by a watcher (session-files.cjs).
    const candidates = (await rolloutFiles(this.directory)).filter(item => this.boundThread ? item.name.includes(this.boundThread) : item.modified >= this.since - 2000);
    candidates.sort((a, b) => b.modified - a.modified);
    for (const item of candidates) {
      if (item.filename === this.filename) return;
      try {
        const meta = await sessionMeta(item.filename);
        if (interactiveSession(meta, this.cwd) && (!this.boundThread || sameThread(meta.id, this.boundThread))) {
          this.filename = item.filename;
          this.fileIdentity = null;
          this.snapshot = { threadId: meta.id, turnId: null, state: 'unknown', updatedAt: 0 };
          this.historyPending = true;
          if (!this.historyOpened) this.options.onHistory?.(false);
          this.historyOpened = true;
          return;
        }
      } catch {}
    }
  }
  record(record) {
    // Every record also goes to whoever follows the agent's steps (agent-actions.cjs).
    this.options.onRecord?.(record);
    if (record.type !== 'event_msg') return;
    const item = record.payload || {}, turn = item.turn_id;
    // The prompt of the round, so its completion can be announced by what it worked on.
    if (item.type === 'user_message' || item.type === 'item_completed' && item.item?.type === 'UserMessage') {
      const prompt = item.type === 'user_message' ? promptText(item.message, { ...record, ...item }) : promptText(item.item.content, { ...record, ...item, ...item.item });
      if (prompt !== null) this.snapshot = { ...this.snapshot, prompt };
      return;
    }
    if (['task_started', 'turn_started'].includes(item.type)) {
      if (typeof turn !== 'string' || !turn) return;
      this.snapshot = { ...this.snapshot, turnId: turn, state: 'working', updatedAt: Date.parse(record.timestamp) || 0 };
    } else if (['task_complete', 'turn_completed', 'turn_aborted', 'turn_interrupted'].includes(item.type)) {
      if (!this.snapshot.turnId || turn && turn !== this.snapshot.turnId) return;
      this.snapshot = { ...this.snapshot, state: ['task_complete', 'turn_completed'].includes(item.type) ? 'complete' : 'interrupted', updatedAt: Date.parse(record.timestamp) || 0 };
    }
  }
  async read() {
    const threadId = this.options.threadId?.() || null;
    if (threadId !== this.boundThread) {
      const hadScope = this.boundThread != null || this.filename;
      this.boundThread = threadId; this.filename = null; this.snapshot = null; this.fileIdentity = null; this.nextDiscovery = 0;
      // A new title can precede its rollout file. Invalidate the old account now,
      // even if discovery cannot yet recover the new conversation's metadata.
      if (hadScope) { this.options.onHistory?.(false); this.historyOpened = true; }
    }
    if (this.options.requireBinding?.() && !threadId) return null;
    if (!this.filename || this.snapshot.state !== 'working') await this.discover();
    if (!this.filename) return null;
    const file = await fs.open(this.filename, 'r');
    try {
      // NTFS file IDs can exceed Number's exact range; keep their identity as bigint.
      const stat = await file.stat({ bigint: true }), size = Number(stat.size);
      const identity = `${stat.dev}:${stat.ino}`;
      if (this.fileIdentity !== identity || size < this.fileSize) {
        const rebinding = this.fileIdentity != null;
        Object.assign(this, transcriptWindow(size)); this.buffer = Buffer.alloc(0); this.oversized = null;
        this.workHistory = this.options.onWorkRecord ? new CompletionHistory(this.offset) : null;
        this.snapshot = { threadId: this.snapshot.threadId, turnId: null, state: 'unknown', updatedAt: 0 };
        this.historyPending = true;
        if (rebinding) { this.options.onHistory?.(false); this.historyOpened = true; }
        if (this.offset > 0) {
          const meta = await codexMetadata(file, this.snapshot.threadId);
          this.options.onRecord?.(meta || { type: 'session_meta', payload: {} });
        }
      }
      this.fileIdentity = identity; this.fileSize = size;
      if (this.workHistory && !await this.workHistory.read(file, this.options.onWorkRecord)) return null;
      // Catch up the bounded history in one poll; live growth keeps its smaller budget.
      const end = this.historyPending ? size : Math.min(size, this.offset + LIVE_READ_LIMIT);
      while (this.offset < end) {
        const chunk = Buffer.alloc(Math.min(65536, end - this.offset));
        const { bytesRead } = await file.read(chunk, 0, chunk.length, this.offset);
        if (!bytesRead) break;
        this.offset += bytesRead;
        readTranscriptChunk(this, chunk.subarray(0, bytesRead), record => this.record(record));
      }
      if (this.historyPending && this.offset >= size) { this.historyPending = false; this.historyOpened = false; this.options.onHistory?.(true); }
      return this.offset >= size ? { ...this.snapshot } : null;
    } finally { await file.close(); }
  }
}

// One asynchronous read at a time, with cancellation even when a remote read
// finishes after the terminal has exited or been replaced.
// interval: ms to the next read, or a function giving it (shorter while the agent works). watch: the file the records
// go to, once known: each write to it is read at once instead of at the next poll (the system tells a write within
// milliseconds), so the reading view keeps up with the agent; the polls go on underneath in case a change is missed.
function monitorActivity(read, onChange, { interval = 1000, watch = null } = {}) {
  let stopped = false, timer = null, pending = null, queued = null, last = '', watcher = null, watched = null, soon = null;
  const follow = () => {
    const file = stopped ? null : watch?.() || null;
    if (file === watched) return;
    watcher?.close(); watcher = null; watched = file;
    if (!file) return;
    try {
      watcher = watchFile(file, { persistent: false }, () => { if (!soon && !stopped) soon = setTimeout(() => { soon = null; void poll(); }, 25); });
      watcher.on('error', () => { watcher?.close(); watcher = null; });
    } catch { watcher = null; }
  };
  const poll = () => {
    if (stopped) return Promise.resolve(null);
    // Asked while a read runs (a write told meanwhile, a hook): another read follows it, and whoever asked waits for
    // that one, which sees what was there when they asked.
    if (pending) return queued ||= pending.then(() => { queued = null; return poll(); });
    clearTimeout(timer);
    pending = Promise.resolve().then(read).then(snapshot => {
      if (stopped || !snapshot) return null;
      const signature = JSON.stringify(snapshot);
      if (signature !== last) { last = signature; onChange(snapshot); }
      return snapshot;
    }).catch(() => null).finally(() => {
      pending = null;
      if (stopped) return;
      follow();
      timer = setTimeout(poll, typeof interval === 'function' ? interval() : interval); timer.unref?.();
    });
    return pending;
  };
  void poll();
  return { poll, stop() { stopped = true; clearTimeout(timer); clearTimeout(soon); watcher?.close(); watcher = null; } };
}

module.exports = { CodexActivityReader, monitorActivity };
