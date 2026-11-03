const fs = require('node:fs/promises');
const path = require('node:path');
const { validId } = require('./values.cjs');
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
        if (value.id === entry.name && Array.isArray(value.runs) && value.runs.length <= 200 && Array.isArray(value.tasks)) experiments.push(value);
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
}

module.exports = { LabStore, MAX_EXPERIMENTS };
