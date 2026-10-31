const fs = require('node:fs/promises');
const path = require('node:path');
const { runRecord, gradeRecord, quotaWindows, quotaScope } = require('./records-values.cjs');
const { readJsonl, FILE_LIMIT, LINE_LIMIT, READ_LIMIT } = require('./jsonl.cjs');

const KINDS = ['runs', 'grades', 'quota'];
const QUOTA_INTERVAL = 10 * 60 * 1000, QUIT_DRAIN_MS = 2000;

// Each store has one ordered I/O queue. Recording never propagates a disk failure to its caller.
class DashboardRecords {
  constructor(userData, { now = Date.now, log = message => console.warn(message) } = {}) {
    this.directory = path.join(userData, 'dashboard'); this.now = now; this.log = log;
    this.pending = new Map(); this.quotas = new Map(); this.warned = false;
    this.listeners = new Set();
    this.quitAttempted = false; this.quitDrain = null;
  }
  file(kind, previous = false) {
    if (!KINDS.includes(kind)) throw new Error('Unknown dashboard record kind');
    return path.join(this.directory, `${kind}${previous ? '.1' : ''}.jsonl`);
  }
  append(kind, record) {
    let file, line;
    try {
      file = this.file(kind);
      line = JSON.stringify({ ...record, v: 1, at: this.now() }) + '\n';
      if (Buffer.byteLength(line) > LINE_LIMIT) return Promise.resolve(false);
    } catch { return Promise.resolve(false); }
    const pending = (this.pending.get(kind) || Promise.resolve()).then(async () => {
      await fs.mkdir(this.directory, { recursive: true });
      const size = await fs.stat(file).then(stat => stat.size, error => { if (error.code === 'ENOENT') return 0; throw error; });
      if (size + Buffer.byteLength(line) > FILE_LIMIT) {
        await fs.rm(this.file(kind, true), { force: true });
        if (size) await fs.rename(file, this.file(kind, true));
      }
      await fs.appendFile(file, line, { mode: 0o600 });
      for (const listener of this.listeners) { try { listener(kind); } catch {} }
      return true;
    }).catch(() => {
      if (!this.warned) { this.warned = true; try { this.log('Dashboard records could not be written.'); } catch {} }
      return false;
    });
    this.pending.set(kind, pending);
    void pending.then(() => { if (this.pending.get(kind) === pending) this.pending.delete(kind); });
    return pending;
  }
  run(project, call, event) { void this.append('runs', runRecord(project, call, event)); }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  grade(grade, project, session) { void this.append('grades', gradeRecord(grade, project, session)); }
  quota(provider, limits, scope = quotaScope(provider, { kind: 'local' }, {})) {
    if (this.quitAttempted || !['claude', 'codex'].includes(provider)) return;
    const windows = quotaWindows(limits);
    if (!windows.length) return;
    const key = `${provider}:${scope}`, signature = JSON.stringify(windows), previous = this.quotas.get(key);
    if (!previous) {
      const state = { provider, scope };
      this.quotas.set(key, state); this.writeQuota(state, windows);
      return;
    }
    if (previous.signature === signature) {
      clearTimeout(previous.timer); previous.timer = null; previous.trailing = null;
      return;
    }
    const remaining = QUOTA_INTERVAL - (this.now() - previous.at);
    if (remaining <= 0) { this.writeQuota(previous, windows); return; }
    previous.trailing = windows;
    previous.timer ??= setTimeout(() => this.writeQuota(previous, previous.trailing), remaining);
    previous.timer.unref?.();
  }
  writeQuota(state, windows) {
    clearTimeout(state.timer); state.timer = null; state.trailing = null;
    state.signature = JSON.stringify(windows); state.at = this.now();
    void this.append('quota', { provider: state.provider, scope: state.scope, windows });
  }
  get busy() { return this.pending.size > 0; }
  async flush() { await Promise.all(this.pending.values()); }
  // A quit may wait once. Late appends cannot re-arm the wait, and a stalled disk cannot hold the process open.
  waitForQuit(capMs = QUIT_DRAIN_MS) {
    if (this.quitAttempted) return null;
    this.quitAttempted = true;
    for (const state of this.quotas.values()) {
      clearTimeout(state.timer); state.timer = null;
      if (state.trailing) this.writeQuota(state, state.trailing);
    }
    if (!this.busy) return null;
    let timer;
    this.quitDrain = Promise.race([this.flush(), new Promise(resolve => { timer = setTimeout(resolve, capMs); })])
      .catch(() => {}).finally(() => { clearTimeout(timer); this.quitDrain = null; });
    return this.quitDrain;
  }
  async read(kind, { since = 0 } = {}) {
    const files = [this.file(kind, true), this.file(kind)];
    if (!Number.isFinite(since) || since < 0) return [];
    await this.flush();
    const records = await Promise.all(files.map(filename => readJsonl(filename, { since })));
    return records.flat().slice(-READ_LIMIT);
  }
}

module.exports = { DashboardRecords, quotaScope, FILE_LIMIT, LINE_LIMIT, READ_LIMIT, QUOTA_INTERVAL, QUIT_DRAIN_MS };
