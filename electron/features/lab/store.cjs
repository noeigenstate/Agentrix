const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { validId, upgradeExperiment } = require('./values.cjs');
const { removePath } = require('./disk.cjs');

const MAX_EXPERIMENTS = 100, MAX_STATE = 16 * 1024 * 1024;

class LabStore {
  constructor(userData) { this.directory = path.join(userData, 'lab'); this.pending = Promise.resolve(); }
  folder(id) {
    if (!validId(id)) throw new Error('无效的实验编号。');
    return path.join(this.directory, id);
  }
  async list() {
    await this.pending;
    let names;
    try { names = await fs.readdir(this.directory, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const experiments = [];
    for (const entry of names) {
      if (!entry.isDirectory() || !validId(entry.name)) continue;
      const filename = path.join(this.folder(entry.name), 'experiment.json');
      try {
        if ((await fs.lstat(filename)).size > MAX_STATE) continue;
        const value = JSON.parse(await fs.readFile(filename, 'utf8'));
        if (value.id === entry.name && Array.isArray(value.runs) && value.runs.length <= 600 && Array.isArray(value.tasks)) {
          experiments.push(upgradeExperiment(value));
        }
      } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code) && !(error instanceof SyntaxError)) throw error; }
    }
    return experiments.sort((a, b) => b.createdAt - a.createdAt);
  }
  save(experiment) {
    const folder = this.folder(experiment.id), data = JSON.stringify(experiment);
    if (Buffer.byteLength(data) > MAX_STATE) return Promise.reject(new Error('实验记录超过大小限制。'));
    const operation = this.pending.then(async () => {
      await fs.mkdir(folder, { recursive: true, mode: 0o700 });
      const temporary = path.join(folder, 'experiment.json.tmp');
      await fs.writeFile(temporary, data, { mode: 0o600 });
      await fs.rename(temporary, path.join(folder, 'experiment.json'));
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
  async remove(id) {
    await this.pending;
    await removePath(this.folder(id));
  }
  async installId() {
    const file = path.join(this.directory, 'install-id');
    const read = async () => {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.size !== 36) throw new Error('Invalid lab installation identity.');
      const id = await fs.readFile(file, 'utf8');
      if (!validId(id)) throw new Error('Invalid lab installation identity.');
      return id;
    };
    try { return await read(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = file + '-' + randomUUID(), handle = await fs.open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(randomUUID()); await handle.sync(); await handle.close();
      // Publish a complete identity without replacing one another engine has already published.
      try { await fs.link(temporary, file); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      return await read();
    } finally { await handle.close(); await fs.rm(temporary, { force: true }); }
  }
  async readCleanup() {
    await this.pending;
    const file = path.join(this.directory, 'pending-cleanup.json');
    let stat;
    try { stat = await fs.lstat(file); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    if (!stat.isFile() || stat.size > MAX_STATE) throw new Error('Invalid lab cleanup record.');
    const entries = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!Array.isArray(entries) || entries.some(entry => !validId(entry.experimentId) || !validId(entry.runId) ||
      !['history', 'oss', 'aa'].includes(entry.source) || typeof entry.worktrees !== 'boolean')) {
      throw new Error('Invalid lab cleanup record.');
    }
    return entries;
  }
  writeCleanup(entries) {
    const operation = this.pending.then(async () => {
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      const file = path.join(this.directory, 'pending-cleanup.json'), temporary = file + '.tmp';
      const handle = await fs.open(temporary, 'w', 0o600);
      try { await handle.writeFile(JSON.stringify(entries)); await handle.sync(); } finally { await handle.close(); }
      await fs.rename(temporary, file);
    });
    this.pending = operation.catch(() => {}); return operation;
  }
  async readAaKey(storage) {
    if (!storage?.isEncryptionAvailable?.()) return null;
    try {
      const file = path.join(this.directory, 'secrets', 'aa.key');
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.size > 16384) return null;
      const value = storage.decryptString(await fs.readFile(file));
      return typeof value === 'string' && /^[\x21-\x7e]{1,4096}$/.test(value) ? value : null;
    } catch { return null; }
  }
  async writeAaKey(value, storage) {
    const directory = path.join(this.directory, 'secrets'), file = path.join(directory, 'aa.key');
    if (value === null) { await fs.rm(file, { force: true }); return; }
    if (!storage?.isEncryptionAvailable?.()) throw new Error('安全密钥存储不可用。');
    try {
      const encrypted = storage.encryptString(value);
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await fs.writeFile(file + '.tmp', encrypted, { mode: 0o600 });
      await fs.rename(file + '.tmp', file);
    } catch { throw new Error('无法保存实验室密钥。'); }
  }
}

module.exports = { LabStore, MAX_EXPERIMENTS };
