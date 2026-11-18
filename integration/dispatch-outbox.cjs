const fs = require('node:fs');
const path = require('node:path');
// The same module runs beside the source helper, beside the packaged helper, and inside its carried electron runtime.
// The lab's private bundle runs from memory with nothing on disk to find: it carries the runtime beside this module.
const runtime = [__dirname, path.join(__dirname, 'electron'), path.join(__dirname, '../electron')]
  .find(folder => fs.existsSync(path.join(folder, 'features/agents/dispatch-events.cjs'))) ?? __dirname;
const { dispatchFrame, verifyDispatchFrame } = require(path.join(runtime, 'features/agents/dispatch-events.cjs'));

class DispatchOutbox {
  constructor({ directory, id, projectId, sessionKey, wake = () => {} }) {
    if (!/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(id)) throw new Error('dispatch.invalid_event');
    Object.assign(this, { id, projectId, sessionKey, wake });
    this.directory = path.join(directory, id); this.seq = 0; this.ack = 0;
    for (const folder of [directory, this.directory]) {
      fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
      const stat = fs.lstatSync(folder);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('dispatch.outbox_unreadable');
    }
  }
  append(event) {
    if (event.id !== this.id) throw new Error('dispatch.invalid_event');
    this.acknowledged();
    const frame = dispatchFrame(event, { projectId: this.projectId, sessionKey: this.sessionKey, seq: this.seq + 1 });
    const bytes = JSON.stringify(frame);
    if (Buffer.byteLength(bytes) > 16384) throw new Error('dispatch.oversize_event');
    // The file is complete and flushed before a wake. A lost pipe write never deletes an event.
    const temporary = path.join(this.directory, `${frame.seq}.tmp`), destination = path.join(this.directory, `${frame.seq}.json`);
    const file = fs.openSync(temporary, 'wx', 0o600);
    try {
      try { fs.writeFileSync(file, bytes); fs.fsyncSync(file); } finally { fs.closeSync(file); }
      fs.renameSync(temporary, destination); this.seq = frame.seq;
    } finally { fs.rmSync(temporary, { force: true }); }
    try { this.wake(frame); } catch { /* Main's sweep reads the durable copy. */ }
    return frame;
  }
  acknowledged() {
    try {
      const file = path.join(this.directory, 'ack.json'), stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) return this.ack;
      const ack = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (ack.type !== 'dispatch-ack' || ack.id !== this.id || ack.projectId !== this.projectId || ack.seq > this.seq
        || !verifyDispatchFrame(ack, this.sessionKey)) return this.ack;
      for (let seq = this.ack + 1; seq <= ack.seq; seq++) fs.rmSync(path.join(this.directory, `${seq}.json`), { force: true });
      this.ack = Math.max(this.ack, ack.seq);
    } catch { /* An unreadable or invalid acknowledgment never discards a pending event or blocks a new one. */ }
    return this.ack;
  }
  pending() {
    this.acknowledged();
    return fs.readdirSync(this.directory).filter(file => /^[1-9]\d*\.json$/.test(file))
      .sort((a, b) => Number(a.slice(0, -5)) - Number(b.slice(0, -5)))
      .map(file => JSON.parse(fs.readFileSync(path.join(this.directory, file), 'utf8')));
  }
}

// Detached helpers retain their receipts independently of main's acknowledged event outbox.
class DetachedRuns {
  constructor(directory) { this.directory = directory; }
  file(id) {
    if (!/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(id)) throw new Error('Expected a run id');
    return path.join(this.directory, id + '.json');
  }
  read(id) {
    const file = this.file(id), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error('Unreadable detached run');
    const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (entry.id !== id) throw new Error('Invalid detached run');
    return entry;
  }
  create(entry) {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(this.directory).isSymbolicLink()) throw new Error('Unreadable detached directory');
    fs.writeFileSync(this.file(entry.id), JSON.stringify(entry), { flag: 'wx', mode: 0o600 });
  }
  update(id, changes) {
    const file = this.file(id), temporary = file + '.' + process.pid + '.tmp';
    try {
      fs.writeFileSync(temporary, JSON.stringify({ ...this.read(id), ...changes }), { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, file);
    } finally { fs.rmSync(temporary, { force: true }); }
  }
  // Watch before reading so an atomic receipt replacement cannot fall between read and subscribe.
  observe(check, timeout, { watch = fs.watch, schedule = setTimeout, cancel = clearTimeout } = {}) {
    return new Promise((resolve, reject) => {
      let watcher, timer, polling, settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true; watcher?.close(); cancel(timer); clearInterval(polling);
        if (error) reject(error); else resolve(value);
      };
      const inspect = () => { try { const value = check(); if (value !== undefined) finish(null, value); } catch (error) { finish(error); } };
      try {
        watcher = watch(this.directory, inspect);
        watcher.on('error', error => finish(error));
        timer = schedule(() => { inspect(); finish(null, null); }, timeout);
        // A killed helper may leave no final filesystem event; periodically probe its liveness too.
        polling = setInterval(inspect, 1000);
        inspect();
      } catch (error) { finish(error); }
    });
  }
}

module.exports = { DispatchOutbox, DetachedRuns };
