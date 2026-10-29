const path = require('node:path');
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { readJson, readText, writeFile } = require('./files.cjs');

const safeId = id => createHash('sha256').update(id).digest('hex');
const MAX_VERSIONS = 20, TEXT_VERSIONS = 3;
const validVersions = versions => Array.isArray(versions) && versions.every(item => item && Number.isInteger(item.version) && item.version > 0
  && Number.isFinite(item.at) && ['agent', 'user', 'app'].includes(item.by) && (item.project === null || typeof item.project === 'string'));

class SkillHistory {
  constructor(dataDir, report = () => {}) { this.root = path.join(dataDir, 'skill-history'); this.indexes = new Map(); this.report = report; }
  folder(id) { return path.join(this.root, safeId(id)); }
  state(id) {
    if (!this.indexes.has(id)) {
      const data = readJson(path.join(this.folder(id), 'index.json'), { versions: [], lastSeenHash: null }, this.report,
        value => validVersions(Array.isArray(value) ? value : value?.versions));
      this.indexes.set(id, Array.isArray(data) ? { versions: data, lastSeenHash: null } : data);
      const state = this.indexes.get(id), expired = state.versions.slice(0, -MAX_VERSIONS);
      if (expired.length) {
        state.versions = state.versions.slice(-MAX_VERSIONS);
        try {
          writeFile(path.join(this.folder(id), 'index.json'), JSON.stringify(state));
          for (const item of expired) fs.rmSync(path.join(this.folder(id), 'v' + item.version + '.md'), { force: true });
        } catch (error) { this.report(error); }
      }
    }
    return this.indexes.get(id);
  }
  index(id) { return this.state(id).versions; }
  latest(id) { return this.index(id).at(-1) || null; }
  text(id, version) {
    if (!Number.isInteger(version) || !this.index(id).some(item => item.version === version)) throw new Error('技能版本不存在。');
    return readText(path.join(this.folder(id), `v${version}.md`));
  }
  record(id, text, by, project, at = Date.now(), projectId = null) {
    const index = this.index(id), version = (index.at(-1)?.version || 0) + 1;
    const item = { version, at, by, project, projectId };
    writeFile(path.join(this.folder(id), `v${version}.md`), text);
    const versions = [...index, item], next = { versions: versions.slice(-MAX_VERSIONS), lastSeenHash: safeId(text) };
    writeFile(path.join(this.folder(id), 'index.json'), JSON.stringify(next));
    this.indexes.set(id, next);
    for (const expired of versions.slice(0, -MAX_VERSIONS)) fs.rmSync(path.join(this.folder(id), `v${expired.version}.md`), { force: true });
    return item;
  }
  unchanged(id, text) {
    const state = this.state(id);
    if (!state.lastSeenHash && this.latest(id)) {
      state.lastSeenHash = safeId(this.text(id, this.latest(id).version) || '');
      writeFile(path.join(this.folder(id), 'index.json'), JSON.stringify(state));
    }
    return state.lastSeenHash === safeId(text);
  }
  // SkillDetail keeps its shape; old versions carry metadata and an empty text, and remain revertible on disk.
  versions(id) { const index = this.index(id); return index.map((item, i) => ({ ...item, text: i < index.length - TEXT_VERSIONS ? '' : this.text(id, item.version) })); }
  move(id, nextId) {
    const state = this.state(id);
    this.delete(nextId);
    fs.mkdirSync(this.root, { recursive: true });
    if (fs.existsSync(this.folder(id))) fs.renameSync(this.folder(id), this.folder(nextId));
    this.indexes.set(nextId, state); this.indexes.delete(id);
  }
  delete(id) { fs.rmSync(this.folder(id), { recursive: true, force: true }); this.indexes.delete(id); }
}

module.exports = { SkillHistory, safeId, MAX_VERSIONS, TEXT_VERSIONS };
