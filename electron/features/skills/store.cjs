const fs = require('node:fs');
const path = require('node:path');
const { monitorActivity } = require('../../codex-activity.cjs');
const { SkillHistory, safeId } = require('./history.cjs');
const { metadata, draftText, readJson, writeFile, checkedPath, readText, listFolder, importFiles } = require('./files.cjs');
const { skillInstructions } = require('./delivery.cjs');

const defaults = source => ({ enabled: true, trigger: source === 'builtin' ? 'always' : 'auto', autoOptimize: source !== 'builtin', confirmChanges: false, createdByAgent: false, reviewed: false, lastUsed: null });
const canonical = file => {
  const resolved = path.resolve(file);
  return process.platform === 'win32' ? resolved.replace(/\\/g, '/').toLowerCase() : resolved;
};

class SkillsStore {
  constructor({ dataDir, builtinDir, getProjects = () => [], getAgents = () => ({}), activeProjects = () => [], changed = () => {}, report = () => {} }) {
    Object.assign(this, { dataDir, builtinDir, getProjects, getAgents, activeProjects, changed, report });
    this.globalFolder = path.join(dataDir, 'skills');
    this.optionsFile = path.join(dataDir, 'skills.json');
    this.options = readJson(this.optionsFile, {});
    this.history = new SkillHistory(dataDir);
    this.entries = new Map(); this.watchers = new Map(); this.writers = new Map();
    fs.mkdirSync(this.globalFolder, { recursive: true });
    fs.mkdirSync(path.join(dataDir, 'skill-pending'), { recursive: true });
    this.refresh(true);
  }

  roots() {
    return [{ root: this.builtinDir, source: 'builtin', scope: 'builtin', project: null },
      { root: this.globalFolder, source: 'user', scope: 'global', project: null },
      // Project-scoped skills are local only. SSH projects get built-in/global copies at session start.
      ...this.getProjects().filter(project => project.kind !== 'ssh').map(project => ({ root: path.join(project.path, 'skills'), source: 'user', scope: 'project', project }))];
  }

  target(scope, projectId) {
    if (scope === 'global' && projectId === null) return this.globalFolder;
    const project = scope === 'project' && this.getProjects().find(item => item.id === projectId && item.kind !== 'ssh');
    if (!project) throw new Error('请选择一个本地项目或全部项目。');
    return path.join(project.path, 'skills');
  }

  pendingPath(skill) {
    // A project may use the same name as a global skill; proposals must not overwrite one another.
    const root = skill.scope === 'project' ? path.join(this.dataDir, 'skill-pending', safeId(`project:${skill.projectId}`)) : path.join(this.dataDir, 'skill-pending');
    return checkedPath(root, skill.folder || skill.name);
  }

  projectFor(entry) {
    const evidence = this.writers.get(canonical(entry.path));
    if (evidence && Date.now() - evidence.at < 60000) return evidence.project;
    if (entry.projectId) return entry.projectId;
    const active = [...new Set(this.activeProjects())];
    return active.length === 1 ? active[0] : null;
  }

  refresh(initial = false) {
    const entries = new Map();
    for (const { root, source, scope, project } of this.roots()) {
      for (const file of listFolder(root)) {
        const id = scope === 'builtin' ? `builtin:${file.folder}` : scope === 'global' ? `user:${file.folder}` : `project:${project.id}:${file.folder}`;
        const entry = { ...file, id, source, scope, projectId: project?.id || null, projectName: project?.name || null };
        const previous = this.entries.get(id), latest = this.history.latest(id);
        const oldText = previous?.text ?? (latest ? this.history.text(id, latest.version) : null);
        if (oldText !== entry.text || !initial && !previous) {
          const by = source === 'builtin' || initial && !latest ? 'app' : 'agent';
          this.history.record(id, entry.text, by, by === 'agent' ? this.projectFor(entry) : null);
          if (by === 'agent' && !previous) this.options[id] = { ...this.options[id], createdByAgent: true, reviewed: false };
        }
        entries.set(id, entry);
      }
    }
    this.entries = entries;
    this.persistOptions();
    return this.infos();
  }

  persistOptions() {
    const text = JSON.stringify(this.options);
    if (this.optionsText === text) return;
    writeFile(this.optionsFile, text); this.optionsText = text;
  }

  info(entry) {
    const latest = this.history.latest(entry.id), options = { ...defaults(entry.source), ...this.options[entry.id] };
    const agents = entry.id === 'builtin:model-routing' ? this.getAgents() : null;
    return { id: entry.id, name: entry.name, description: entry.description, source: entry.source, scope: entry.scope,
      projectId: entry.projectId, projectName: entry.projectName, path: entry.path,
      enabled: options.enabled, trigger: options.trigger, autoOptimize: entry.source !== 'builtin' && options.autoOptimize,
      confirmChanges: entry.source !== 'builtin' && options.confirmChanges,
      version: latest?.version || 0, updatedAt: latest?.at || null, updatedBy: latest?.by || null, updatedIn: latest?.project || null,
      createdByAgent: options.createdByAgent, pending: entry.source !== 'builtin' && readText(this.pendingPath(entry)) !== null,
      requires: entry.id === 'builtin:model-routing' ? { codex: !!agents.codex?.installed, claude: !!agents.claude?.installed } : null,
      lastUsed: options.lastUsed };
  }

  infos() { return [...this.entries.values()].map(entry => this.info(entry)); }
  publish() { const infos = this.infos(); this.published = JSON.stringify(infos); this.changed(infos); return infos; }
  list() { const infos = this.refresh(); this.syncWatchers(); return infos; }
  entry(id, writable = false) {
    if (typeof id !== 'string') throw new Error('无效的技能。');
    const entry = this.entries.get(id);
    if (!entry) throw new Error('技能不存在。');
    if (writable && entry.source === 'builtin') throw new Error('系统自带技能为只读。');
    checkedPath(path.dirname(path.dirname(entry.path)), entry.folder);
    return entry;
  }

  read(id) {
    this.refresh();
    const entry = this.entry(id);
    return { text: entry.text, versions: this.history.versions(id), pending: entry.source === 'builtin' ? null : readText(this.pendingPath(entry)) };
  }

  save(id, draft, assets = []) {
    this.refresh();
    const root = this.target(draft?.scope, draft?.projectId), text = draftText(draft);
    const file = checkedPath(root, draft.name), old = id === null ? null : this.entry(id, true);
    const nextId = draft.scope === 'global' ? `user:${draft.name}` : `project:${draft.projectId}:${draft.name}`;
    const moved = old && old.id !== nextId, folderMoved = old && canonical(old.path) !== canonical(file);
    if ((!old || folderMoved) && fs.existsSync(path.dirname(file))) throw new Error('此作用范围已存在同名技能。');
    if (moved) {
      if (folderMoved) {
        const files = importFiles(path.dirname(old.path));
        for (const asset of files) writeFile(path.join(path.dirname(file), asset.relative), fs.readFileSync(asset.file));
        fs.rmSync(path.dirname(old.path), { recursive: true });
      } else if (old.folder !== draft.name) fs.renameSync(path.dirname(old.path), path.dirname(file));
      for (const version of this.history.versions(old.id)) this.history.record(nextId, version.text, version.by, version.project, version.at);
      this.options[nextId] = this.options[old.id];
      delete this.options[old.id]; this.entries.delete(old.id);
    }
    for (const asset of assets) if (asset.relative !== 'SKILL.md') writeFile(path.join(path.dirname(file), asset.relative), fs.readFileSync(asset.file));
    writeFile(file, text);
    this.history.record(nextId, text, 'user', draft.projectId);
    this.options[nextId] = { ...this.options[nextId], createdByAgent: false, reviewed: true };
    if (old) fs.rmSync(this.pendingPath(old), { force: true });
    this.entries.set(nextId, { ...(old || {}), id: nextId, path: file, text }); // Ignore this app's own write on the next scan.
    this.refresh(); this.syncWatchers(); this.publish();
    return this.info(this.entry(nextId));
  }

  delete(id) {
    this.refresh();
    const entry = this.entry(id, true);
    fs.rmSync(path.dirname(entry.path), { recursive: true, force: true });
    fs.rmSync(this.pendingPath(entry), { force: true });
    delete this.options[id]; this.entries.delete(id);
    this.persistOptions(); this.publish();
    return true;
  }

  setOptions(id, patch) {
    this.refresh();
    const entry = this.entry(id);
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('技能选项无效。');
    for (const [key, value] of Object.entries(patch)) {
      if (key === 'trigger' ? !['always', 'auto'].includes(value) : !['enabled', 'autoOptimize', 'confirmChanges'].includes(key) || typeof value !== 'boolean') throw new Error('技能选项无效。');
      if (entry.source === 'builtin' && ['autoOptimize', 'confirmChanges'].includes(key) && value) throw new Error('系统自带技能为只读。');
    }
    this.options[id] = { ...this.options[id], ...patch };
    this.persistOptions(); this.publish();
    return this.info(entry);
  }

  replace(entry, text, by, project) {
    metadata(text);
    writeFile(entry.path, text);
    this.history.record(entry.id, text, by, project);
    entry.text = text;
    this.refresh(); this.publish();
    return this.info(this.entry(entry.id));
  }

  revert(id, version) {
    this.refresh();
    const entry = this.entry(id, true);
    this.options[id] = { ...this.options[id], createdByAgent: false, reviewed: true };
    return this.replace(entry, this.history.text(id, version), 'user', entry.projectId);
  }

  resolveChange(id, accept) {
    if (typeof accept !== 'boolean') throw new Error('技能确认选项无效。');
    this.refresh();
    const entry = this.entry(id, true), pendingFile = this.pendingPath(entry), pending = readText(pendingFile);
    if (!accept && pending === null && this.options[id]?.createdByAgent) { this.delete(id); return null; }
    if (accept && pending !== null) this.replace(entry, pending, 'agent', this.projectFor(entry));
    fs.rmSync(pendingFile, { force: true });
    if (accept) this.options[id] = { ...this.options[id], createdByAgent: false, reviewed: true };
    this.persistOptions(); this.publish();
    return this.info(this.entry(id));
  }

  import(folder, scope, projectId) {
    this.target(scope, projectId);
    const assets = importFiles(folder), text = readText(path.join(folder, 'SKILL.md'));
    if (text === null) throw new Error('所选文件夹没有 SKILL.md。');
    const fields = metadata(text);
    return this.save(null, { ...fields, text, scope, projectId }, assets);
  }

  matchFile(file, cwd, projectId, remotePaths) {
    if (!file || typeof file !== 'string') return null;
    if (remotePaths) {
      const absolute = path.posix.resolve(cwd, file.replace(/\\/g, '/'));
      return this.entries.get(Object.keys(remotePaths).find(id => remotePaths[id] === absolute)) || null;
    }
    const absolute = canonical(path.resolve(cwd || '.', file));
    return [...this.entries.values()].find(entry => canonical(entry.path) === absolute && (entry.scope !== 'project' || entry.projectId === projectId)) || null;
  }

  recordAction(action, { cwd, project, agent, since = 0, clockOffset = 0, remotePaths = null }) {
    if (!action || !['claude', 'codex'].includes(agent) || action.at + clockOffset < since || action.failed) return;
    if (action.kind === 'edit') {
      for (const file of action.files || []) this.writers.set(canonical(path.resolve(action.cwd || cwd, file.path)), { at: Date.now(), project });
      return;
    }
    if (action.kind !== 'skill' || !action.done) return;
    for (const file of action.skillFiles || [action.skillFile]) {
      const entry = this.matchFile(file, action.cwd || cwd, project, remotePaths);
      const at = action.at + clockOffset, previous = entry && this.options[entry.id]?.lastUsed;
      if (!entry || previous && (previous.at > at || previous.at === at && previous.project === project && previous.agent === agent)) continue;
      this.options[entry.id] = { ...this.options[entry.id], lastUsed: { at, project, agent } };
      this.persistOptions(); this.publish();
    }
  }

  delivery(project, remote = false) {
    this.refresh();
    const entries = [...this.entries.values()].filter(entry => entry.scope !== 'project' || !remote && entry.projectId === project.id);
    const remotePath = entry => `{AGENTRIX_SKILLS}/${entry.scope === 'builtin' ? 'builtin' : 'global'}/${entry.folder}/SKILL.md`;
    const skills = entries.map(entry => ({ ...this.info(entry), ...(remote ? { path: remotePath(entry) } : {}) }));
    const manifest = remote ? '{AGENTRIX_SKILLS}/instructions.md' : path.join(this.dataDir, 'skill-delivery', `${safeId(project.id)}.md`);
    const delivery = { skills, remote, agents: this.getAgents(), globalFolder: remote ? '{AGENTRIX_SKILLS}/global' : this.globalFolder,
      pendingPath: skill => remote ? `{AGENTRIX_SKILLS}/pending/${this.entry(skill.id).folder}/SKILL.md` : this.pendingPath(this.entry(skill.id)), manifest };
    const instructions = skillInstructions(delivery);
    if (!remote) writeFile(manifest, instructions);
    let bytes = 0;
    const bundle = remote ? { instructions, files: entries.filter(entry => this.info(entry).enabled).map(entry => {
      bytes += Buffer.byteLength(entry.text);
      const assets = importFiles(path.dirname(entry.path)).filter(asset => asset.relative !== 'SKILL.md').map(asset => {
        bytes += fs.statSync(asset.file).size;
        if (bytes > 8 * 1024 * 1024) throw new Error('SSH 技能文件合计超过 8 MB，请精简技能附件。');
        return { path: asset.relative.split(path.sep).join('/'), data: fs.readFileSync(asset.file).toString('base64') };
      });
      if (bytes > 8 * 1024 * 1024) throw new Error('SSH 技能文件合计超过 8 MB，请精简技能附件。');
      return { id: entry.id, name: entry.folder, scope: entry.scope, text: entry.text, assets };
    }) } : null;
    return { ...delivery, bundle };
  }

  queueRefresh() {
    if (this.scanTimer || this.closed) return;
    this.scanTimer = setTimeout(() => {
      this.scanTimer = null;
      try { if (JSON.stringify(this.refresh()) !== this.published) this.publish(); } catch (error) { this.report(error); }
    }, 150);
    this.scanTimer.unref?.();
  }

  syncWatchers() {
    if (this.closed) return;
    const roots = new Set([...this.roots().filter(entry => entry.source === 'user').map(entry => entry.root), path.join(this.dataDir, 'skill-pending')]);
    for (const [root, watcher] of this.watchers) if (!roots.has(root)) { watcher.stop(); this.watchers.delete(root); }
    for (const root of roots) if (!this.watchers.has(root)) {
      // Missing project skills folders are polled until created; never recursively watch the whole repo.
      // All directory events share one debounce, so N project watchers do not cause N full scans.
      const watcher = monitorActivity(() => { this.queueRefresh(); return null; }, () => {},
        { interval: 2000, recursive: true, watch: () => {
          try { return fs.lstatSync(root, { throwIfNoEntry: false })?.isDirectory() ? root : null; } catch { return null; }
        } });
      this.watchers.set(root, watcher);
    }
  }

  close() { this.closed = true; clearTimeout(this.scanTimer); for (const watcher of this.watchers.values()) watcher.stop(); this.watchers.clear(); }
}

module.exports = { SkillsStore };
