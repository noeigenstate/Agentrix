const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { readJsonl } = require('./jsonl.cjs');

const execute = promisify(execFile);
async function gitCommon(projectPath) {
  try {
    const cwd = await fs.promises.realpath(projectPath);
    const { stdout } = await execute('git', ['rev-parse', '--git-common-dir'], { cwd, windowsHide: true, timeout: 5000, maxBuffer: 8192 });
    return await fs.promises.realpath(path.resolve(cwd, stdout.trim()));
  } catch { return null; }
}

class DashboardJournals {
  constructor({ getProjects, changed, resolveCommon = gitCommon, watch = fs.watch }) {
    this.getProjects = getProjects; this.changed = changed; this.resolveCommon = resolveCommon; this.watch = watch;
    this.cache = new Map(); this.watchers = new Map(); this.projects = []; this.active = false; this.syncing = null; this.resync = false;
  }
  async start() {
    this.active = true;
    // Explicit opens retry missed repositories; broadcasts and successful probes keep their cache.
    for (const [filename, pending] of [...this.cache]) {
      if (!await pending && this.cache.get(filename) === pending) this.cache.delete(filename);
    }
    return this.sync();
  }
  async sync() {
    this.resync = true;
    if (!this.syncing) this.syncing = (async () => {
      do { this.resync = false; await this.refresh(); } while (this.resync);
    })().finally(() => { this.syncing = null; });
    await this.syncing;
  }
  async refresh() {
    const projects = this.getProjects().filter(project => project.kind !== 'ssh' && typeof project.path === 'string');
    const selected = [];
    // Keep Git probes bounded even when the workspace contains many projects.
    for (let offset = 0; offset < projects.length; offset += 4) {
      const batch = await Promise.all(projects.slice(offset, offset + 4).map(async project => {
        if (!this.cache.has(project.path)) this.cache.set(project.path, this.resolveCommon(project.path));
        const common = await this.cache.get(project.path);
        if (!common) return null;
        return { id: project.id, name: project.name, common, directory: path.join(common, 'agentrix') };
      }));
      selected.push(...batch.filter(Boolean));
    }
    this.projects = selected;
    for (const filename of this.cache.keys()) if (!projects.some(project => project.path === filename)) this.cache.delete(filename);
    const wanted = new Map();
    if (this.active) for (const project of selected) {
      wanted.set(project.common, 'common'); wanted.set(project.directory, 'journal');
    }
    for (const [directory, watcher] of this.watchers) if (!wanted.has(directory)) { watcher.close(); this.watchers.delete(directory); }
    for (const [directory, kind] of wanted) {
      if (this.watchers.has(directory)) continue;
      try {
        // libuv aborts on Windows 8.3 aliases; every watched path must use its native long spelling.
        const native = fs.realpathSync.native(directory);
        const watcher = this.watch(native, { persistent: false }, (_event, filename) => {
          const name = filename == null ? null : String(filename);
          if (kind === 'journal' && (name === null || name === 'journal.jsonl')) this.changed();
          if (name === null || kind === 'common' && name === 'agentrix') { this.changed(); void this.sync(); }
        });
        watcher.on('error', () => { watcher.close(); this.watchers.delete(directory); });
        this.watchers.set(directory, watcher);
      } catch {}
    }
  }
  async read() {
    await this.sync();
    const histories = new Map();
    for (const project of this.projects) if (!histories.has(project.common)) {
      histories.set(project.common, readJsonl(path.join(project.directory, 'journal.jsonl'), { version: null, timeKey: 'time' }));
    }
    return Promise.all(this.projects.map(async project => ({ projectId: project.id, project: project.name, key: project.common,
      entries: await histories.get(project.common) })));
  }
  stop() {
    this.active = false;
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
  }
}

module.exports = { DashboardJournals };
