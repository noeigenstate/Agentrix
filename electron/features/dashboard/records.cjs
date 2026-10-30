const fs = require('node:fs/promises');
const path = require('node:path');
const { runRecord, gradeRecord, quotaWindows } = require('./records-values.cjs');

const KINDS = ['runs', 'grades', 'quota'];
const FILE_LIMIT = 20 * 1024 * 1024, LINE_LIMIT = 16 * 1024;
const READ_LIMIT = 10000, QUOTA_INTERVAL = 10 * 60 * 1000;

// Each store has one ordered I/O queue. Recording never propagates a disk failure to its caller.
class DashboardRecords {
  constructor(userData, { now = Date.now, log = message => console.warn(message) } = {}) {
    this.directory = path.join(userData, 'dashboard'); this.now = now; this.log = log;
    this.pending = new Map(); this.quotas = new Map(); this.warned = false;
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
  grade(grade, project, session) { void this.append('grades', gradeRecord(grade, project, session)); }
  quota(provider, limits) {
    if (!['claude', 'codex'].includes(provider)) return;
    const windows = quotaWindows(limits);
    if (!windows.length) return;
    const signature = JSON.stringify(windows), at = this.now(), previous = this.quotas.get(provider);
    if (previous && (previous.signature === signature || at - previous.at < QUOTA_INTERVAL)) return;
    this.quotas.set(provider, { signature, at });
    void this.append('quota', { provider, windows });
  }
  async flush() { await Promise.all(this.pending.values()); }
  async read(kind, { since = 0 } = {}) {
    const files = [this.file(kind, true), this.file(kind)];
    if (!Number.isFinite(since) || since < 0) return [];
    await this.flush();
    const records = [];
    // At most two bounded file tails, 10000 returned records and 16 KiB per line.
    for (const filename of files) {
      let file;
      try {
        file = await fs.open(filename, 'r');
        const { size } = await file.stat(), start = Math.max(0, size - FILE_LIMIT);
        const buffer = Buffer.alloc(Math.min(size, FILE_LIMIT));
        let offset = 0;
        while (offset < buffer.length) {
          const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, start + offset);
          if (!bytesRead) break;
          offset += bytesRead;
        }
        const lines = buffer.subarray(0, offset).toString('utf8').split('\n');
        if (start) lines.shift();
        // A torn last write is not a record, even if its prefix happens to parse.
        lines.pop();
        for (const line of lines) {
          if (Buffer.byteLength(line) > LINE_LIMIT) continue;
          let record; try { record = JSON.parse(line); } catch { continue; }
          if (record?.v !== 1 || !Number.isFinite(record.at) || record.at < since) continue;
          records.push(record);
          if (records.length > READ_LIMIT * 2) records.splice(0, READ_LIMIT);
        }
      } catch {} finally { await file?.close().catch(() => {}); }
    }
    return records.slice(-READ_LIMIT);
  }
}

module.exports = { DashboardRecords, FILE_LIMIT, LINE_LIMIT, READ_LIMIT, QUOTA_INTERVAL };
