const fs = require('node:fs');
const path = require('node:path');
// The same module runs beside the source helper, beside the packaged helper, and inside its carried electron runtime.
// The lab's private bundle runs from memory with nothing on disk to find: it carries the runtime beside this module.
const runtime = [__dirname, path.join(__dirname, 'electron'), path.join(__dirname, '../electron')]
  .find(folder => fs.existsSync(path.join(folder, 'features/agents/dispatch-events.cjs'))) ?? __dirname;
const { dispatchFrame, verifyDispatchFrame, readEnvelope, WIRE_FIELDS } = require(path.join(runtime, 'features/agents/dispatch-events.cjs'));
const receiptFormat = 'agentrix.detached-run';
const receiptVersion = WIRE_FIELDS.files[receiptFormat].version;
const receiptTypes = { started: 'dispatch.started', waiting: 'dispatch.waiting', startFailed: 'dispatch.start-failed', ended: 'dispatch.ended' };

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
  constructor(directory, { rename = fs.promises.rename, delay = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
    Object.assign(this, { directory, rename, delay });
    this.cache = new Map(); this.writes = new Map(); this.latest = new Map();
  }
  file(id) {
    if (!/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(id)) throw new Error('Expected a run id');
    return path.join(this.directory, id + '.json');
  }
  read(id, { fresh = false } = {}) {
    try {
      const file = this.file(id), stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error('Unreadable detached run');
      const { value: entry, legacy } = readEnvelope(fs.readFileSync(file, 'utf8'), { format: receiptFormat });
      if (entry.id !== id) throw new Error('Invalid detached run');
      Object.defineProperty(entry, 'legacy', { value: legacy, enumerable: false });
      for (const [key, type] of Object.entries(receiptTypes)) {
        if (entry[key] == null) continue;
        const event = entry[key];
        readEnvelope(event, { channel: receiptFormat + '.' + key, legacy: false });
        if (typeof event !== 'object' || event.type !== type || event.id !== id || !WIRE_FIELDS.dispatch[type].required.every(field => Object.hasOwn(event, field))) {
          throw new Error(`Invalid detached run event ${key}`);
        }
      }
      this.cache.set(id, entry); return entry;
    } catch (error) {
      if (error instanceof SyntaxError || ['ENOENT', 'EPERM', 'EACCES', 'EBUSY'].includes(error.code)) {
        return (!fresh && this.cache.get(id)) || (error.code === 'ENOENT' && !fs.existsSync(this.file(id) + '.log') ? null : undefined);
      }
      throw error;
    }
  }
  create(entry) {
    entry = { ...entry, format: receiptFormat, version: receiptVersion };
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(this.directory).isSymbolicLink()) throw new Error('Unreadable detached directory');
    fs.writeFileSync(this.file(entry.id), JSON.stringify(entry), { flag: 'wx', mode: 0o600 });
    this.cache.set(entry.id, entry);
  }
  update(id, changes, { unlessEnded = false } = {}) {
    const pending = (this.writes.get(id) || Promise.resolve()).catch(() => {}).then(async () => {
      const previous = unlessEnded ? this.read(id, { fresh: true }) : this.latest.get(id) || this.read(id);
      if (unlessEnded && (!previous || this.isEnded(previous))) return previous;
      if (!previous) throw new Error(`unknown run ${id}`);
      const entry = { ...previous, ...changes }, file = this.file(id), temporary = file + '.' + process.pid + '.tmp';
      if (previous.legacy) Object.defineProperty(entry, 'legacy', { value: true });
      // Keep all changes after an exhausted retry; a later successful update also persists them.
      this.latest.set(id, entry);
      try {
        fs.writeFileSync(temporary, JSON.stringify(entry), { flag: 'wx', mode: 0o600 });
        for (let attempt = 0; ; attempt++) {
          if (unlessEnded) {
            const current = this.read(id, { fresh: true });
            if (!current || this.isEnded(current)) {
              if (current) this.latest.set(id, current);
              return current;
            }
          }
          try { await this.rename(temporary, file); break; }
          catch (error) {
            if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt === 7) throw error;
            await this.delay(5 * 2 ** attempt);
          }
        }
        this.cache.set(id, entry);
        return entry;
      } finally { fs.rmSync(temporary, { force: true }); }
    });
    this.writes.set(id, pending);
    return pending;
  }
  isEnded(entry) {
    return entry.settled || entry.ended || entry.legacy && entry.endedLine;
  }
  claimStart(id) {
    try { fs.closeSync(fs.openSync(this.file(id) + '.announced', 'wx', 0o600)); return true; }
    catch (error) { if (error.code === 'EEXIST') return false; throw error; }
  }
  prune(now = Date.now()) {
    for (const name of fs.readdirSync(this.directory)) {
      if (/^[a-f\d-]{36}\.json\.[1-9]\d*\.tmp$/i.test(name)) {
        const file = path.join(this.directory, name), stat = fs.lstatSync(file, { throwIfNoEntry: false });
        if (stat?.isFile() && !stat.isSymbolicLink() && now - stat.mtimeMs >= 7 * 86400000) {
          try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        continue;
      }
      if (!/^[a-f\d-]{36}\.json$/i.test(name)) continue;
      const id = name.slice(0, -5), entry = this.read(id);
      if (!entry?.settled || now - (entry.activityAt || entry.createdAt) < 7 * 86400000) continue;
      for (const suffix of ['.log', '.announced', '']) {
        try { fs.unlinkSync(this.file(id) + suffix); } catch (error) { if (error.code !== 'ENOENT') break; }
      }
      if (!fs.existsSync(this.file(id))) { this.cache.delete(id); this.latest.delete(id); this.writes.delete(id); }
    }
  }
  // Watch before reading so an atomic receipt replacement cannot fall between read and subscribe.
  observe(check, timeout, { watch = fs.watch, schedule = setTimeout, cancel = clearTimeout, signal } = {}) {
    return new Promise((resolve, reject) => {
      let watcher, timer, polling, settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true; watcher?.close(); cancel(timer); clearInterval(polling); signal?.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(value);
      };
      let inspecting;
      const inspect = () => {
        if (settled) return Promise.resolve();
        if (inspecting) return inspecting;
        inspecting = Promise.resolve().then(check).then(value => { if (value !== undefined) finish(null, value); }, error => finish(error))
          .finally(() => { inspecting = null; });
        return inspecting;
      };
      const abort = () => finish(null, null);
      try {
        if (signal?.aborted) { finish(null, null); return; }
        signal?.addEventListener('abort', abort, { once: true });
        try {
          watcher = watch(this.directory, inspect);
          watcher.on('error', () => { watcher?.close(); watcher = undefined; });
        } catch { /* The polling fallback also covers failure to subscribe. */ }
        timer = schedule(() => { void inspect().then(() => finish(null, null)); }, timeout);
        // A killed helper may leave no final filesystem event; periodically probe its liveness too.
        polling = setInterval(inspect, 1000);
        inspect();
      } catch (error) { finish(error); }
    });
  }
}

module.exports = { DispatchOutbox, DetachedRuns };
