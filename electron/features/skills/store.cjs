const fs = require('node:fs');
const path = require('node:path');
const { monitorActivity } = require('../../codex-activity.cjs');
const { SkillHistory, safeId } = require('./history.cjs');
const { metadata, draftText, readJson, writeFile, checkedPath, readText, listFolder, folderSignature, importFiles } = require('./files.cjs');
const { skillInstructions } = require('./delivery.cjs');
const { builtinMetadata, TRIGGERS } = require('./builtin-format.cjs');
const { projectSkillTargets, projectSkillNames, projectSkillSignature } = require('./project-skills.cjs');
const MAX_SSH_BUNDLE_BYTES = 512 * 1024;

const defaults = entry => ({ enabled: true, trigger: entry.source === 'builtin' ? entry.trigger : 'auto', autoOptimize: entry.source !== 'builtin', confirmChanges: false, createdByAgent: false, reviewed: false, lastUsed: null });
const triggerWhen = { always: '每个任务开始前', auto: '描述匹配时', 'first-open': '首次打开项目时' };
const canonical = file => {
  const resolved = path.resolve(file);
  return process.platform === 'win32' ? resolved.replace(/\\/g, '/').toLowerCase() : resolved;
};

class SkillsStore {
  constructor({ dataDir, builtinDir, getProjects = () => [], getAgents = () => ({}), activeProjects = () => [], changed = () => {}, report = () => {} }) {
    Object.assign(this, { dataDir, builtinDir, getProjects, getAgents, activeProjects, changed, report });
    this.globalFolder = path.join(dataDir, 'skills');
    this.optionsFile = path.join(dataDir, 'skills.json');
    this.options = readJson(this.optionsFile, {}, report, value => value && !Array.isArray(value) && typeof value === 'object'
      && Object.values(value).every(item => item && typeof item === 'object' && !Array.isArray(item)));
    this.history = new SkillHistory(dataDir, report);
    this.entries = new Map(); this.watchers = new Map(); this.writers = new Map();
    this.projectSkills = new Map();
    this.knownRoots = new Set(); this.baselines = new Set(); this.dirtyRoots = new Set(); this.deliveries = new Map();
    const deliveryFolder = path.join(dataDir, 'skill-delivery');
    try {
      for (const entry of fs.readdirSync(deliveryFolder, { withFileTypes: true })) {
        if (entry.isFile() && /^[a-f0-9]{64}\.md$/.test(entry.name)) fs.rmSync(path.join(deliveryFolder, entry.name), { force: true });
      }
    } catch (error) { if (error.code !== 'ENOENT') report(error); }
    for (const folder of [this.globalFolder, path.join(dataDir, 'skill-pending')]) {
      try { fs.mkdirSync(folder, { recursive: true }); } catch (error) { report(error); }
    }
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
    const active = [...new Set(this.activeProjects())];
    const file = canonical(entry.path), evidence = this.writers.get(file);
    if (evidence && Date.now() - evidence.at < 60000 && evidence.hash === safeId(entry.text)) {
      this.writers.delete(file); return evidence.project;
    }
    if (entry.projectId) return active.includes(entry.projectId) ? entry.projectId : null;
    return active.length === 1 ? active[0] : null;
  }

  projectName(id, fallback = null) { return this.getProjects().find(project => project.id === id)?.name || fallback; }
  record(entry, text, by, projectId = null) { return this.history.record(entry.id, text, by, this.projectName(projectId), Date.now(), projectId); }
  invalidateDelivery() { this.deliveries.clear(); }

  pruneProjects() {
    const projects = new Set(this.getProjects().map(project => project.id));
    let modified = false;
    for (const options of Object.values(this.options)) {
      for (const id of Object.keys(options.firstOpenedProjects || {})) if (!projects.has(id)) { delete options.firstOpenedProjects[id]; modified = true; }
    }
    return modified;
  }

  refreshProjectSkills(selected) {
    const projects = this.getProjects().filter(project => project.kind !== 'ssh');
    let modified = false;
    for (const id of this.projectSkills.keys()) if (!projects.some(project => project.id === id)) { this.projectSkills.delete(id); modified = true; }
    for (const project of projects) {
      const previous = this.projectSkills.get(project.id);
      if (previous?.path === project.path && selected && !projectSkillTargets(project).some(target => selected.has(target))) continue;
      const names = projectSkillNames(project, [...this.entries.values()].filter(entry => entry.source === 'builtin').map(entry => entry.path));
      modified ||= previous?.path !== project.path || JSON.stringify([...names]) !== JSON.stringify([...previous.names]);
      this.projectSkills.set(project.id, { path: project.path, names });
    }
    return modified;
  }

  yields(entry, project, agent = null) {
    const copies = entry.source === 'builtin' && project.kind !== 'ssh' && this.projectSkills.get(project.id)?.names.get(entry.name);
    return copies && (agent ? copies[agent] : copies.claude || copies.codex) || null;
  }

  refresh(initial = false, selected = null) {
    if (this.mutating) return this.infos();
    const roots = this.roots(), rootPaths = new Set(roots.map(item => item.root));
    const knownRoots = new Set([...this.knownRoots].filter(root => rootPaths.has(root)));
    const entries = new Map([...this.entries].filter(([, entry]) => rootPaths.has(entry.root)));
    let modified = entries.size !== this.entries.size;
    for (const { root, source, scope, project } of roots) {
      if (selected && !selected.has(root)) continue;
      const baseline = initial || !this.knownRoots.has(root);
      const idFor = folder => scope === 'builtin' ? `builtin:${folder}` : scope === 'global' ? `user:${folder}` : `project:${project.id}:${folder}`;
      const previousEntries = [...this.entries.values()].filter(entry => entry.root === root);
      for (const entry of previousEntries) entries.delete(entry.id);
      let readable = true;
      const report = error => { if (source === 'builtin') console.warn(`Skipping invalid built-in skill: ${error.message}`); this.report(error); };
      const files = listFolder(root, report, folder => {
        if (folder === null) readable = false;
        else if (baseline) this.baselines.add(idFor(folder));
        if (source !== 'builtin') for (const entry of previousEntries) if (folder === null || entry.folder === folder) entries.set(entry.id, entry);
      }, source === 'builtin' ? builtinMetadata : metadata);
      for (const file of files) {
        const id = idFor(file.folder), appBaseline = this.baselines.delete(id) || baseline;
        const entry = { ...file, id, root, source, scope, projectId: project?.id || null, projectName: project?.name || null };
        const previous = this.entries.get(id);
        modified ||= !previous || previous.text !== entry.text || previous.path !== entry.path;
        try {
          if (!this.history.unchanged(id, entry.text)) {
            const latest = this.history.latest(id), projectId = this.projectFor(entry);
            const by = source === 'builtin' || appBaseline ? 'app' : projectId ? 'agent' : 'user';
            this.record(entry, entry.text, by, by === 'app' ? null : projectId);
            if (by === 'agent' && !latest) this.options[id] = { ...this.options[id], createdByAgent: true, reviewed: false };
          }
          if (appBaseline && this.options[id]?.createdByAgent) this.options[id] = { ...this.options[id], createdByAgent: false };
        } catch (error) { this.report(error); }
        entries.set(id, entry);
      }
      if (previousEntries.some(entry => !entries.has(entry.id))) modified = true;
      if (readable) knownRoots.add(root);
    }
    this.entries = entries;
    this.knownRoots = knownRoots;
    const pruned = this.pruneProjects();
    if (this.refreshProjectSkills(selected) || pruned || modified) this.invalidateDelivery();
    this.persistOptions();
    return this.infos();
  }

  persistOptions() {
    const text = JSON.stringify(this.options);
    if (this.optionsText === text) return;
    try { writeFile(this.optionsFile, text); this.optionsText = text; } catch (error) { this.report(error); }
  }

  pendingText(entry) { try { return readText(this.pendingPath(entry)); } catch (error) { this.report(error); return null; } }

  info(entry) {
    const latest = this.history.latest(entry.id), options = { ...defaults(entry), ...this.options[entry.id] };
    const agents = this.getAgents(), required = entry.source === 'builtin' ? entry.requires : 'none';
    const lastUsed = options.lastUsed && { at: options.lastUsed.at, project: this.projectName(options.lastUsedProjectId || options.lastUsed.project, options.lastUsed.project), agent: options.lastUsed.agent };
    return { id: entry.id, name: entry.name, description: entry.description, title: entry.source === 'builtin' ? entry.title : entry.name,
      summary: entry.source === 'builtin' ? entry.summary : entry.description, source: entry.source, scope: entry.scope,
      when: entry.source === 'builtin' ? entry.when : triggerWhen[options.trigger],
      yieldsTo: this.getProjects().filter(project => this.yields(entry, project)).map(project => project.name),
      projectId: entry.projectId, projectName: this.projectName(entry.projectId), path: entry.path,
      enabled: options.enabled, trigger: options.trigger, autoOptimize: entry.source !== 'builtin' && options.autoOptimize,
      confirmChanges: entry.source !== 'builtin' && options.confirmChanges,
      version: latest?.version || 0, updatedAt: latest?.at || null, updatedBy: latest?.by || null, updatedIn: this.projectName(latest?.projectId || latest?.project, latest?.project || null),
      createdByAgent: options.createdByAgent, pending: entry.source !== 'builtin' && this.pendingText(entry) !== null,
      requires: required === 'none' ? null : { codex: required === 'claude' ? null : !!agents.codex?.installed, claude: required === 'codex' ? null : !!agents.claude?.installed },
      lastUsed: lastUsed || null };
  }

  infos() { return [...this.entries.values()].map(entry => this.info(entry)); }
  publish(deliveryChanged = true) { const infos = this.infos(); this.published = JSON.stringify(infos); this.changed(infos, { deliveryChanged }); return infos; }
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
    return { text: entry.text, versions: this.history.versions(id).map(({ projectId, ...item }) => ({ ...item, project: this.projectName(projectId || item.project, item.project) })), pending: entry.source === 'builtin' ? null : this.pendingText(entry) };
  }

  async save(id, draft, assets = []) {
    this.refresh();
    const root = this.target(draft?.scope, draft?.projectId), text = draftText(draft);
    const file = checkedPath(root, draft.name), old = id === null ? null : this.entry(id, true);
    const nextId = draft.scope === 'global' ? `user:${draft.name}` : `project:${draft.projectId}:${draft.name}`;
    const moved = old && old.id !== nextId, folderMoved = old && canonical(old.path) !== canonical(file);
    if ((!old || folderMoved) && fs.existsSync(path.dirname(file))) throw new Error('此作用范围已存在同名技能。');
    this.mutating = (this.mutating || 0) + 1;
    try {
      if (moved) {
        if (folderMoved) {
          await fs.promises.mkdir(root, { recursive: true });
          try { await fs.promises.rename(path.dirname(old.path), path.dirname(file)); }
          catch (error) {
            if (error.code !== 'EXDEV') throw error;
            await fs.promises.cp(path.dirname(old.path), path.dirname(file), { recursive: true });
            await fs.promises.rm(path.dirname(old.path), { recursive: true });
          }
        } else if (old.folder !== draft.name) fs.renameSync(path.dirname(old.path), path.dirname(file));
        this.history.move(old.id, nextId);
        this.options[nextId] = this.options[old.id];
        delete this.options[old.id]; this.entries.delete(old.id);
      }
      for (const asset of assets) if (asset.relative !== 'SKILL.md') writeFile(path.join(path.dirname(file), asset.relative), await fs.promises.readFile(asset.file));
      writeFile(file, text);
      this.record({ id: nextId }, text, 'user', draft.projectId);
      this.options[nextId] = { ...this.options[nextId], createdByAgent: false, reviewed: true };
      if (old) fs.rmSync(this.pendingPath(old), { force: true });
      this.entries.set(nextId, { ...metadata(text), folder: draft.name, id: nextId, root, source: 'user', scope: draft.scope,
        projectId: draft.projectId, projectName: this.projectName(draft.projectId), path: file, text });
      this.invalidateDelivery();
    } finally { this.mutating--; }
    this.refresh(); this.syncWatchers(); this.publish();
    return this.info(this.entry(nextId));
  }

  delete(id) {
    this.refresh();
    const entry = this.entry(id, true);
    fs.rmSync(path.dirname(entry.path), { recursive: true, force: true });
    fs.rmSync(this.pendingPath(entry), { force: true });
    delete this.options[id]; this.entries.delete(id);
    this.history.delete(id); this.invalidateDelivery();
    this.persistOptions(); this.publish();
    return true;
  }

  setOptions(id, patch) {
    this.refresh();
    const entry = this.entry(id);
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('技能选项无效。');
    for (const [key, value] of Object.entries(patch)) {
      if (key === 'trigger' ? !TRIGGERS.includes(value) : !['enabled', 'autoOptimize', 'confirmChanges'].includes(key) || typeof value !== 'boolean') throw new Error('技能选项无效。');
      if (entry.source === 'builtin' && ['autoOptimize', 'confirmChanges'].includes(key) && value) throw new Error('系统自带技能为只读。');
    }
    this.options[id] = { ...this.options[id], ...patch };
    this.invalidateDelivery();
    this.persistOptions(); this.publish();
    return this.info(entry);
  }

  replace(entry, text, by, project) {
    metadata(text);
    writeFile(entry.path, text);
    this.record(entry, text, by, project);
    entry.text = text;
    this.invalidateDelivery();
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

  async import(folder, scope, projectId) {
    this.target(scope, projectId);
    const assets = await importFiles(folder), text = readText(path.join(folder, 'SKILL.md'));
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
      if (!action.done) return;
      for (const file of action.files || []) {
        if (path.basename(file.path).toLowerCase() !== 'skill.md') continue;
        const absolute = canonical(path.resolve(action.cwd || cwd, file.path));
        try {
          const text = readText(absolute);
          if (text !== null) this.writers.set(absolute, { at: Date.now(), project, hash: safeId(text) });
        } catch (error) { this.report(error); }
      }
      return;
    }
    if (action.kind !== 'skill' || !action.done) return;
    for (const file of action.skillFiles || [action.skillFile]) {
      const entry = this.matchFile(file, action.cwd || cwd, project, remotePaths);
      const at = action.at + clockOffset, previous = entry && this.options[entry.id]?.lastUsed;
      if (!entry || previous && (previous.at > at || previous.at === at && this.options[entry.id].lastUsedProjectId === project && previous.agent === agent)) continue;
      this.options[entry.id] = { ...this.options[entry.id], lastUsed: { at, project: this.projectName(project, project), agent }, lastUsedProjectId: project };
      this.persistOptions(); this.publish(false);
    }
  }

  delivery(project, remote = false, sessionId = null, { agent = null, started = false } = {}) {
    // A newly added or moved project can start a session before its watcher's first debounced scan.
    if (!remote && project.kind !== 'ssh' && this.projectSkills.get(project.id)?.path !== project.path
      && this.refreshProjectSkills(new Set())) this.invalidateDelivery();
    const agents = this.getAgents(), key = JSON.stringify([project.id, remote, sessionId, agent, started, !!agents.claude?.installed, !!agents.codex?.installed]);
    if (this.deliveries.has(key)) return this.deliveries.get(key);
    const entries = [...this.entries.values()].filter(entry => entry.scope !== 'project' || !remote && entry.projectId === project.id);
    const remotePath = entry => `{AGENTRIX_SKILLS}/${entry.scope === 'builtin' ? 'builtin' : 'global'}/${entry.folder}/SKILL.md`;
    // No remote project-skill discovery is available; SSH sessions never use host-side yield detection.
    const infos = entries.map(entry => ({ ...this.info(entry), override: !remote && this.yields(entry, project, agent) }));
    const yielded = infos.filter(info => info.override);
    let skills = infos.filter(info => !info.override).map(({ override, ...info }) => {
      if (info.enabled && info.trigger === 'first-open') {
        const firstSession = this.options[info.id]?.firstOpenedProjects?.[project.id];
        if (firstSession && firstSession !== sessionId) info.trigger = 'auto';
      }
      return { ...info, ...(remote ? { path: remotePath(this.entries.get(info.id)) } : {}) };
    });
    const manifest = remote ? '{AGENTRIX_SKILLS}/instructions.md' : path.join(this.dataDir, 'skill-delivery', `${safeId(JSON.stringify([project.id, sessionId]))}.md`);
    const delivery = { skills, yielded: yielded.filter(info => info.enabled).map(info => ({ name: info.name, path: info.override })), remote, agents, globalFolder: remote ? '{AGENTRIX_SKILLS}/global' : this.globalFolder,
      pendingPath: skill => remote ? `{AGENTRIX_SKILLS}/pending/${this.entry(skill.id).folder}/SKILL.md` : this.pendingPath(this.entry(skill.id)), manifest };
    let bundle = null;
    if (remote) {
      const files = [], included = [], enabled = skills.filter(skill => skill.enabled);
      const skippedNote = count => count ? `${count} enabled skills were omitted to keep the SSH bundle within its size limit.` : '';
      // Measure escaped JSON, including the manifest and omission notice, with ample room for the open envelope.
      for (const skill of enabled) {
        const entry = this.entries.get(skill.id), file = { id: entry.id, name: entry.folder, scope: entry.scope, text: entry.text };
        const candidate = { ...delivery, skills: [...included, skill], skippedNote: skippedNote(enabled.length) };
        if (Buffer.byteLength(JSON.stringify({ files: [...files, file], instructions: skillInstructions(candidate), key: '0'.repeat(64) })) > MAX_SSH_BUNDLE_BYTES) continue;
        files.push(file); included.push(skill);
      }
      skills = included;
      Object.assign(delivery, { skills, skippedNote: skippedNote(enabled.length - included.length) });
      bundle = { files, instructions: skillInstructions(delivery) };
      bundle.key = safeId(JSON.stringify(bundle));
    } else {
      try { writeFile(manifest, skillInstructions(delivery)); } catch (error) { this.report(error); }
    }
    if (started && sessionId) {
      let recorded = false;
      for (const skill of skills.filter(skill => skill.enabled && skill.trigger === 'first-open')) {
        const runs = this.options[skill.id]?.firstOpenedProjects || {};
        if (runs[project.id]) continue;
        // Only an observed agent launch claims first-open, synchronously: simultaneous starts are first-wins.
        // Keep the agent session identity so another CLI in the same terminal receives auto.
        this.options[skill.id] = { ...this.options[skill.id], firstOpenedProjects: { ...runs, [project.id]: sessionId } };
        recorded = true;
      }
      if (recorded) { this.invalidateDelivery(); this.persistOptions(); }
    }
    const result = { ...delivery, bundle };
    this.deliveries.set(key, result);
    return result;
  }

  endSession(projectId, sessionId) {
    if (!sessionId) return;
    try { fs.rmSync(path.join(this.dataDir, 'skill-delivery', `${safeId(JSON.stringify([projectId, sessionId]))}.md`), { force: true }); }
    catch (error) { this.report(error); }
    for (const key of this.deliveries.keys()) {
      const [project, , session] = JSON.parse(key);
      if (project === projectId && session === sessionId) this.deliveries.delete(key);
    }
  }

  queueRefresh(root) {
    this.dirtyRoots.add(root);
    if (this.scanTimer || this.closed) return;
    this.scanTimer = setTimeout(() => {
      this.scanTimer = null;
      if (this.mutating) { this.queueRefresh(root); return; }
      const roots = this.dirtyRoots; this.dirtyRoots = new Set();
      try { if (JSON.stringify(this.refresh(false, roots)) !== this.published) this.publish(); } catch (error) { this.report(error); }
    }, 150);
    this.scanTimer.unref?.();
  }

  syncWatchers() {
    if (this.closed) return;
    if (this.pruneProjects()) { this.invalidateDelivery(); this.persistOptions(); }
    const projectTargets = new Set(this.getProjects().filter(project => project.kind !== 'ssh').flatMap(projectSkillTargets));
    const roots = new Set([...this.roots().filter(entry => entry.source === 'user').map(entry => entry.root), ...projectTargets, path.join(this.dataDir, 'skill-pending')]);
    for (const [root, watcher] of this.watchers) if (!roots.has(root)) { watcher.stop(); this.watchers.delete(root); }
    for (const root of roots) if (!this.watchers.has(root)) {
      // Missing project skills folders are polled until created; never recursively watch the whole repo.
      // All directory events share one debounce, so N project watchers do not cause N full scans.
      const watcher = monitorActivity(async () => ({ signature: await (projectTargets.has(root) ? projectSkillSignature(root) : folderSignature(root, root === path.join(this.dataDir, 'skill-pending') ? 2 : 1)) }), () => this.queueRefresh(root),
        { interval: 2000, recursive: true, watch: () => {
          try { return fs.lstatSync(root, { throwIfNoEntry: false })?.isDirectory() ? root : null; } catch { return null; }
        } });
      this.watchers.set(root, watcher);
    }
  }

  close() { this.closed = true; clearTimeout(this.scanTimer); for (const watcher of this.watchers.values()) watcher.stop(); this.watchers.clear(); }
}

module.exports = { SkillsStore, MAX_SSH_BUNDLE_BYTES };
