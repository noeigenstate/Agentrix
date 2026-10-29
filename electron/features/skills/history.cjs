const path = require('node:path');
const { createHash } = require('node:crypto');
const { readJson, readText, writeFile } = require('./files.cjs');

const safeId = id => createHash('sha256').update(id).digest('hex');

class SkillHistory {
  constructor(dataDir) { this.root = path.join(dataDir, 'skill-history'); this.indexes = new Map(); }
  folder(id) { return path.join(this.root, safeId(id)); }
  index(id) {
    if (!this.indexes.has(id)) this.indexes.set(id, readJson(path.join(this.folder(id), 'index.json'), []));
    return this.indexes.get(id);
  }
  latest(id) { return this.index(id).at(-1) || null; }
  text(id, version) {
    if (!Number.isInteger(version) || !this.index(id).some(item => item.version === version)) throw new Error('技能版本不存在。');
    return readText(path.join(this.folder(id), `v${version}.md`));
  }
  record(id, text, by, project, at = Date.now()) {
    const index = this.index(id), version = (index.at(-1)?.version || 0) + 1;
    const item = { version, at, by, project };
    writeFile(path.join(this.folder(id), `v${version}.md`), text);
    const next = [...index, item];
    writeFile(path.join(this.folder(id), 'index.json'), JSON.stringify(next));
    this.indexes.set(id, next);
    return item;
  }
  versions(id) { return this.index(id).map(item => ({ ...item, text: this.text(id, item.version) })); }
}

module.exports = { SkillHistory, safeId };
