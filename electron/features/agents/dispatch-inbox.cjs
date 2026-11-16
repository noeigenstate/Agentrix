const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { validDispatch, dispatchKeyId, dispatchFrame, verifyDispatchFrame } = require('./dispatch-events.cjs');

const uuid = value => typeof value === 'string' && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value);
// Open only a regular file with the identity inspected before opening. This also rejects link swaps on Windows.
async function readFrame(file) {
  const before = await fs.lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size > 16384) throw new Error('dispatch.outbox_unreadable');
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev || opened.size > 16384) throw new Error('dispatch.outbox_unreadable');
    const bytes = Buffer.alloc(16385), { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 16384) throw new Error('dispatch.oversize_event');
    return JSON.parse(bytes.toString('utf8', 0, bytesRead));
  } finally { await handle.close(); }
}

class DispatchInbox {
  constructor({ directory = null, projectId, sessionKey, apply, refused = () => {}, interval = 60000 }) {
    Object.assign(this, { directory, projectId, sessionKey, apply, refused });
    this.runs = new Map(); this.work = Promise.resolve(); this.disposed = false;
    if (directory) { this.timer = setInterval(() => { void this.sweep(); }, interval); this.timer.unref?.(); }
  }
  refuse(frame, code) {
    const result = { accepted: false, id: uuid(frame?.id) ? frame.id : null, seq: Number.isSafeInteger(frame?.seq) ? frame.seq : null, code };
    this.refused(result); return result;
  }
  enqueue(action) {
    const pending = this.work.then(() => this.disposed ? { accepted: false } : action());
    this.work = pending.catch(() => {}); return pending;
  }
  accept(frame) { return this.enqueue(() => this.receive(frame)); }
  async rotate(key) {
    return this.enqueue(async () => { await this.scan(); this.sessionKey = key; });
  }
  async receive(frame) {
    if (this.disposed) return { accepted: false };
    if (!uuid(frame?.id) || !Number.isSafeInteger(frame.seq) || frame.seq < 1 || frame.version !== 1) return this.refuse(frame, 'dispatch.invalid_event');
    if (frame.projectId !== this.projectId) return this.refuse(frame, 'dispatch.project_mismatch');
    if (Buffer.byteLength(JSON.stringify(frame)) > 16384) return this.refuse(frame, 'dispatch.oversize_event');
    let run = this.runs.get(frame.id);
    const key = run?.admitted ? run.key : this.sessionKey;
    if (!key || frame.keyId !== dispatchKeyId(key)) return this.refuse(frame, 'dispatch.session_mismatch');
    if (!verifyDispatchFrame(frame, key) || !validDispatch(frame)) return this.refuse(frame, 'dispatch.invalid_event');
    if (!run) { run = { key, seq: 0, pending: new Map(), admitted: false, ended: false }; this.runs.set(frame.id, run); }
    if (run.ended && frame.seq > run.seq) return this.refuse(frame, 'dispatch.late_after_end');
    if (frame.seq > run.seq) {
      const previous = run.pending.get(frame.seq);
      if (previous && previous.mac !== frame.mac) return this.refuse(frame, 'dispatch.invalid_event');
      run.pending.set(frame.seq, frame);
      for (;;) {
        const next = run.pending.get(run.seq + 1);
        if (!next) break;
        if (!run.admitted && !(next.type === 'dispatch-declared' || next.type === 'dispatch-start' && next.unconfirmed === true)) {
          return this.refuse(next, 'dispatch.unknown_run');
        }
        if (run.ended) return this.refuse(next, 'dispatch.late_after_end');
        if (this.disposed) return { accepted: false };
        // The callback may decline an already represented fact; it is still consumed. A thrown application retries.
        await this.apply(next, run.key);
        run.admitted = true; run.seq = next.seq; run.pending.delete(next.seq);
        if (next.type === 'dispatch-end') run.ended = true;
      }
    }
    if (run.seq && this.directory) {
      try {
        const folder = path.join(this.directory, frame.id), stat = await fs.lstat(folder);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('dispatch.outbox_unreadable');
        const ack = dispatchFrame({ type: 'dispatch-ack', id: frame.id }, { projectId: this.projectId, sessionKey: run.key, seq: run.seq });
        const temporary = path.join(folder, `ack-${randomUUID()}.tmp`);
        try {
          const handle = await fs.open(temporary, 'wx', 0o600);
          try { await handle.writeFile(JSON.stringify(ack)); await handle.sync(); } finally { await handle.close(); }
          await fs.rename(temporary, path.join(folder, 'ack.json'));
        }
        finally { await fs.rm(temporary, { force: true }); }
        // A helper may already have exited. Main also reclaims acknowledged frames, so sweeps do not reread old runs.
        for (let seq = (run.reclaimed || 0) + 1; seq <= run.seq; seq++) await fs.rm(path.join(folder, `${seq}.json`), { force: true });
        run.reclaimed = run.seq;
      } catch { return this.refuse(frame, 'dispatch.outbox_unreadable'); }
    }
    return { accepted: true, seq: run.seq };
  }
  sweep() { return this.enqueue(() => this.scan()); }
  async scan() {
    if (!this.directory) return;
    let folders;
    try {
      const stat = await fs.lstat(this.directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('dispatch.outbox_unreadable');
      folders = await fs.readdir(this.directory, { withFileTypes: true });
    } catch (error) { if (error.code !== 'ENOENT') this.refuse(null, 'dispatch.outbox_unreadable'); return; }
    for (const folder of folders) {
      if (this.disposed) return;
      if (!uuid(folder.name) || !folder.isDirectory() || folder.isSymbolicLink()) continue;
      const directory = path.join(this.directory, folder.name);
      try {
        const files = (await fs.readdir(directory)).filter(file => /^[1-9]\d*\.json$/.test(file))
          .sort((a, b) => Number(a.slice(0, -5)) - Number(b.slice(0, -5)));
        for (const file of files) {
          try {
            const frame = await readFrame(path.join(directory, file));
            if (frame.id !== folder.name || frame.seq !== Number(file.slice(0, -5))) this.refuse(frame, 'dispatch.invalid_event');
            else await this.receive(frame);
          } catch (error) { if (error.code !== 'ENOENT') this.refuse({ id: folder.name }, 'dispatch.outbox_unreadable'); }
        }
      } catch (error) { if (error.code !== 'ENOENT') this.refuse({ id: folder.name }, 'dispatch.outbox_unreadable'); }
    }
  }
  dispose() { this.disposed = true; clearInterval(this.timer); }
}

module.exports = { DispatchInbox };
