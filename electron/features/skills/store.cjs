const fs = require('node:fs');
const path = require('node:path');
const { monitorActivity } = require('../../codex-activity.cjs');
const { SkillHistory, safeId } = require('./history.cjs');
const { metadata, draftText, readJson, writeFile, checkedPath, readText, listFolder, folderSignature, importFiles } = require('./files.cjs');
const { skillInstructions } = require('./delivery.cjs');
const { digest, assertUserSkillName } = require('./session.cjs');
const { pruneDeliveryFiles } = require('./delivery-cleanup.cjs');
const { builtinMetadata, TRIGGERS } = require('./builtin-format.cjs');
const modelSeats = require('./model-seats.cjs');
const { familyOf } = require('./seat-rules.mjs');
const { cleanConfig, compactConfig, emptyConfig, resolveTeam, validateTeam } = require('./team-roles.cjs');
const { readRouting, writeRouting, routingState, reviewFile, routingWatch } = require('./project-routing.cjs');
const { renderRoutingSkill } = require('./skill-render.cjs');
const { ModelCatalog, trackModelRuntime } = require('./model-catalog.cjs');
const { probeCodex, probeClaude } = require('./model-probe.cjs');
const { projectSkillTargets, replaceProjectSkills, projectSkillSignature, linkedSkillParent, extensionBase } = require('./project-skills.cjs');
const MAX_SSH_BUNDLE_BYTES = 512 * 1024;
// Closing a library watcher does not end its CLI sessions. Keep their references across store recreation in this process.
const liveSessionSnapshots = new Map();

const ROUTING_ID = 'builtin:model-routing';
const defaults = entry => ({ enabled: true,
  trigger: entry.id === ROUTING_ID ? 'always' : entry.source === 'builtin' ? entry.trigger : 'auto', firstOpenRun: false,
  autoOptimize: entry.source !== 'builtin', confirmChanges: false, createdByAgent: false, reviewed: false, lastUsed: null });
const triggerWhen = { always: '每个任务开始前', auto: '描述匹配时' };
const migrateTrigger = options => options.trigger === 'first-open' ? { ...options, trigger: 'auto', firstOpenRun: true } : options;
const runsOnFirstOpen = skill => skill.id !== ROUTING_ID && (skill.trigger === 'always' || skill.trigger === 'auto' && skill.firstOpenRun);
const replacementHistory = value => Array.isArray(value) ? value.filter(item => item && ['project', 'name', 'from', 'backup'].every(key => typeof item[key] === 'string') && Number.isFinite(item.at)).slice(0, 20) : [];
const canonical = file => {
  const resolved = path.resolve(file);
  return process.platform === 'win32' ? resolved.replace(/\\/g, '/').toLowerCase() : resolved;
};

function launchSeatMap(map, catalog) {
  if (!map) return null;
  return Object.fromEntries(Object.entries(map).map(([id, choice]) => [id, {
    ...choice, agentModel: choice.model === 'fable' ? 'fable'
      : choice.model.includes('[') ? null : modelSeats.agentAlias(choice.model, catalog || []),
  }]));
}

const routingFailure = (code, error = {}) => ({
  ok: false, code, message: error.message ?? code,
  ...(error.role && { role: error.role }), ...(error.seat && { seat: error.seat }),
});

function stripOperationConfig(config) {
  if (!config || !Object.hasOwn(config, 'operations')) return;
  delete config.operations;
}

function migrateRoutingOptions(options) {
  const routing = options[ROUTING_ID];
  if (!routing) return;
  for (const key of ['enabled', 'trigger', 'firstOpenRun', 'firstOpenedProjects', 'operations']) delete routing[key];
  const saved = routing.routing;
  if (!saved) return;
  stripOperationConfig(saved.template);
  for (const config of Object.values(saved.local || {})) stripOperationConfig(config);
  for (const record of Object.values(saved.trust || {})) stripOperationConfig(record?.config);
}

class SkillsStore {
  constructor({ dataDir, builtinDir, getProjects = () => [], getAgents = () => ({}), routingNote = () => '', activeProjects = () => [], changed = () => {}, report = () => {},
    getModels = () => [], modelProbes = {}, now = Date.now, seatSession = () => null }) {
    Object.assign(this, { dataDir, builtinDir, getProjects, getAgents, routingNote, activeProjects, changed, report, getModels, seatSession, now });
    this.globalFolder = path.join(dataDir, 'skills');
    this.optionsFile = path.join(dataDir, 'skills.json');
    const stored = readJson(this.optionsFile, {}, report, value => value && !Array.isArray(value) && typeof value === 'object'
      && Object.values(value).every(item => item && typeof item === 'object' && !Array.isArray(item)));
    this.options = Object.fromEntries(Object.entries(stored).map(([id, options]) => [id, migrateTrigger(options)]));
    migrateRoutingOptions(this.options);
    this.history = new SkillHistory(dataDir, report);
    this.entries = new Map(); this.watchers = new Map(); this.writers = new Map();
    this.routingWatchers = new Map(); this.routingSeen = new Set(); this.routingReviews = new Map();
    this.projectSkills = new Map(); this.replacementFailures = new Set();
    this.knownRoots = new Set(); this.baselines = new Set(); this.dirtyRoots = new Set(); this.deliveries = new Map();
    this.pruneDeliveryFiles();
    for (const folder of [this.globalFolder, path.join(dataDir, 'skill-pending')]) {
      try { fs.mkdirSync(folder, { recursive: true }); } catch (error) { report(error); }
    }
    this.modelCatalog = new ModelCatalog({ dataDir, probes: modelProbes, now, report, changed: () => { this.invalidateDelivery(); this.publish(); } });
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
  invalidateDelivery() {
    this.deliveries.clear();
    for (const [key, session] of liveSessionSnapshots) {
      if (!session.current || JSON.parse(key)[0] !== canonical(this.dataDir)) continue;
      const project = this.getProjects().find(item => item.id === session.projectId && item.kind !== 'ssh');
      if (project) this.writeCurrentSnapshot(session.current, this.deliveryInfo(project, false, session.sessionId, 'claude'), project.id, session.sessionId);
    }
  }

  builtinNames() { return [...this.entries.values()].filter(entry => entry.source === 'builtin').map(entry => entry.name); }

  writeCurrentSnapshot(file, delivery, projectId, sessionId) {
    const skills = delivery.skills.map(skill => {
      const firstRun = runsOnFirstOpen(skill) && this.options[skill.id]?.firstOpenedProjects?.[projectId] === sessionId;
      return { ...skill, firstRun };
    });
    try { writeFile(file, skillInstructions({ ...delivery, skills })); } catch (error) { this.report(error); }
  }

  pruneDeliveryFiles(now = Date.now()) {
    pruneDeliveryFiles(path.join(this.dataDir, 'skill-delivery'), new Set([...liveSessionSnapshots.values()].flatMap(session => [...session.files])), this.report, now);
  }

  migrateTeams() {
    for (const entry of this.entries.values()) {
      let options = this.options[entry.id];
      if (entry.source !== 'builtin' || !entry.seats?.length || !options || options.routing) continue;
      if (options.team?.version !== 2 && (options.seats || options.seatDefaultModels)) options = this.migrateLegacySeats(entry, options);
      const { team, ...rest } = options;
      if (!team) continue;
      const roles = modelSeats.cleanStoredSeats(team?.global, entry.seats);
      const template = { roles };
      const local = Object.fromEntries(this.getProjects().flatMap(({ id }) => {
        const seatOverride = Object.hasOwn(team?.projects || {}, id);
        if (!seatOverride) return [];
        const projectRoles = modelSeats.cleanStoredSeats(team.projects[id], entry.seats);
        return [[id, { roles: { ...roles, ...projectRoles } }]];
      }));
      this.options[entry.id] = { ...rest, routing: { template, local, trust: {} } };
    }
  }

  migrateLegacySeats(entry, options) {
    const legacy = options.seats || {}, global = modelSeats.migrateSeats(legacy.global);
    const notices = global.notice ? [global.notice] : [];
    const projects = Object.fromEntries(Object.entries(legacy.projects || {}).flatMap(([id, map]) => {
      const project = this.getProjects().find(project => project.id === id);
      if (!project) return [];
      const migrated = modelSeats.migrateSeats(map);
      if (migrated.notice) notices.push(project.name + ': ' + migrated.notice);
      return [[id, migrated.map]];
    }));
    return { ...options, team: { version: 2, global: global.map, projects },
      seatDefaultModels: modelSeats.migrateDefaultModels(options.seatDefaultModels, entry.seats),
      ...(notices.length ? { seatMigrationNotice: notices.join('\n') } : {}) };
  }

  pruneProjects() {
    const projects = new Set(this.getProjects().map(project => project.id));
    const retained = new Set([...projects].flatMap(id => [safeId(id), safeId(id).slice(0, 32)])), folder = path.join(this.dataDir, 'skill-delivery');
    if (!this.deliveryProjects || retained.size !== this.deliveryProjects.size || [...retained].some(id => !this.deliveryProjects.has(id))) {
      try {
        for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
          const match = /^([a-f0-9]{32}|[a-f0-9]{64})-(?:claude|codex|preview|[a-f0-9]{32}|[a-f0-9]{64})\.md(?:\.json)?$/.exec(entry.name);
          if (entry.isFile() && match && !retained.has(match[1])) fs.rmSync(path.join(folder, entry.name), { force: true });
        }
        this.deliveryProjects = retained;
      } catch (error) { if (error.code === 'ENOENT') this.deliveryProjects = retained; else this.report(error); }
    }
    let modified = false;
    for (const id of this.routingSeen) if (!projects.has(id)) this.routingSeen.delete(id);
    for (const id of this.routingReviews.keys()) if (!projects.has(id)) this.routingReviews.delete(id);
    for (const options of Object.values(this.options)) {
      for (const scoped of [options.firstOpenedProjects, options.routing?.local, options.routing?.trust]) {
        for (const id of Object.keys(scoped || {})) if (!projects.has(id)) { delete scoped[id]; modified = true; }
      }
    }
    return modified;
  }

  refreshProjectSkills(selected) {
    const projects = this.getProjects().filter(project => project.kind !== 'ssh');
    const names = this.builtinNames(), signature = JSON.stringify(names);
    let modified = false;
    for (const id of this.projectSkills.keys()) if (!projects.some(project => project.id === id)) { this.projectSkills.delete(id); modified = true; }
    for (const project of projects) {
      const previous = this.projectSkills.get(project.id);
      if (previous?.path === project.path && previous.signature === signature && selected && !projectSkillTargets(project).some(target => selected.has(target))) continue;
      const replaced = replaceProjectSkills(project, names, this.dataDir, this.replacementFailures, this.report);
      for (const replacement of replaced) {
        const entry = [...this.entries.values()].find(item => item.source === 'builtin' && item.name === replacement.name);
        const options = this.options[entry.id] || {};
        this.options[entry.id] = { ...options, replaced: [replacement, ...replacementHistory(options.replaced)].slice(0, 20) };
      }
      modified ||= previous?.path !== project.path || previous.signature !== signature || replaced.length > 0;
      this.projectSkills.set(project.id, { path: project.path, signature });
    }
    return modified;
  }

  refresh(initial = false, selected = null) {
    if (this.mutating) return this.infos();
    const roots = this.roots(), rootPaths = new Set(roots.map(item => item.root));
    const knownRoots = new Set([...this.knownRoots].filter(root => rootPaths.has(root)));
    const entries = new Map([...this.entries].filter(([, entry]) => rootPaths.has(entry.root)));
    let modified = entries.size !== this.entries.size;
    let scannedProjects = false;
    for (const { root, source, scope, project } of roots) {
      if (source !== 'builtin' && !scannedProjects) {
        this.entries = entries;
        if (this.refreshProjectSkills(selected)) modified = true;
        scannedProjects = true;
      }
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
      }, source === 'builtin' ? builtinMetadata : metadata, folder => scope !== 'project' || !this.builtinNames().includes(folder));
      for (const file of files) {
        if (scope === 'project' && this.builtinNames().includes(file.name)) continue;
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
    this.migrateTeams();
    const pruned = this.pruneProjects();
    if (pruned || modified) this.invalidateDelivery();
    this.persistOptions();
    return this.infos();
  }

  persistOptions() {
    const text = JSON.stringify(this.options);
    if (this.optionsText === text) return true;
    try { writeFile(this.optionsFile, text); this.optionsText = text; return true; }
    catch (error) { this.report(error); return false; }
  }

  pendingText(entry) { try { return readText(this.pendingPath(entry)); } catch (error) { this.report(error); return null; } }

  info(entry) {
    const latest = this.history.latest(entry.id), options = { ...defaults(entry), ...this.options[entry.id] };
    const agents = this.getAgents(), required = entry.source === 'builtin' ? entry.requires : 'none';
    const lastUsed = options.lastUsed && { at: options.lastUsed.at, project: this.projectName(options.lastUsedProjectId || options.lastUsed.project, options.lastUsed.project), agent: options.lastUsed.agent };
    return { id: entry.id, name: entry.name, description: entry.description, title: entry.source === 'builtin' ? entry.title : entry.name,
      summary: entry.source === 'builtin' ? entry.summary : entry.description, source: entry.source, scope: entry.scope,
      when: entry.source === 'builtin' ? entry.when : triggerWhen[options.trigger],
      extends: entry.source === 'builtin' ? null : extensionBase(entry.name, this.builtinNames()),
      replaced: entry.source === 'builtin' ? replacementHistory(options.replaced).map(item => ({ ...item })) : [],
      projectId: entry.projectId, projectName: this.projectName(entry.projectId), path: entry.path,
      enabled: options.enabled, trigger: options.trigger, firstOpenRun: options.firstOpenRun === true,
      ...(entry.id === ROUTING_ID && { hiddenInSettings: true }),
      autoOptimize: entry.source !== 'builtin' && options.autoOptimize,
      confirmChanges: entry.source !== 'builtin' && options.confirmChanges,
      version: latest?.version || 0, updatedAt: latest?.at || null, updatedBy: latest?.by || null, updatedIn: this.projectName(latest?.projectId || latest?.project, latest?.project || null),
      createdByAgent: options.createdByAgent, pending: entry.source !== 'builtin' && this.pendingText(entry) !== null,
      requires: required === 'none' ? null : { codex: required === 'claude' ? null : !!agents.codex?.installed, claude: required === 'codex' ? null : !!agents.claude?.installed },
      lastUsed: lastUsed || null };
  }

  infos() { return [...this.entries.values()].map(entry => this.info(entry)); }
  publish(deliveryChanged = true) {
    const infos = this.infos();
    this.published = JSON.stringify(infos);
    const refreshed = this.changed(infos, { deliveryChanged });
    if (deliveryChanged) this.deliveryRefresh = refreshed;
    return infos;
  }
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
    const old = id === null ? null : this.entry(id, true);
    assertUserSkillName(draft?.name, this.builtinNames());
    const root = this.target(draft?.scope, draft?.projectId), text = draftText(draft);
    const file = checkedPath(root, draft.name);
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
    if (id === ROUTING_ID) throw new Error('系统自带技能为只读。');
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('技能选项无效。');
    for (const [key, value] of Object.entries(patch)) {
      if (key === 'trigger' ? value !== 'first-open' && !TRIGGERS.includes(value)
        : !['enabled', 'firstOpenRun', 'autoOptimize', 'confirmChanges'].includes(key) || typeof value !== 'boolean') throw new Error('技能选项无效。');
      if (entry.source === 'builtin' && ['autoOptimize', 'confirmChanges'].includes(key) && value) throw new Error('系统自带技能为只读。');
    }
    this.options[id] = { ...this.options[id], ...migrateTrigger(patch) };
    this.invalidateDelivery();
    this.persistOptions(); this.publish();
    return this.info(entry);
  }

  sessionSnapshot(projectId, sessionId) {
    return sessionId ? liveSessionSnapshots.get(JSON.stringify([canonical(this.dataDir), projectId, sessionId])) : null;
  }

  leadOptions(projectId, agent, { remote = false } = {}) {
    const info = this.seatsInfo(projectId);
    if (!info || !remote) return info?.leads[agent] ?? null;
    // The SSH shell resolves the CLI on its own host.
    return modelSeats.leadOptions(info.effective, agent, { ...info.installed, [agent]: true }, info.catalog, info.lead);
  }

  terminalLead(projectId, { remote = false } = {}) {
    const seat = this.leadOptions(projectId, 'claude', { remote });
    if (!seat) return null;
    return { ...seat, seatsMap: this.dispatchSeats(projectId) };
  }

  dispatchSeats(projectId) {
    const info = this.seatsInfo(projectId);
    return launchSeatMap(info?.effective, info?.catalog);
  }

  leadAgent(projectId) { return this.seatsInfo(projectId)?.leadAgent ?? null; }

  observeModels(family, rows) { this.modelCatalog.accept(family, rows); }

  trackModelRuntime(runtime, { family, local, runtimes }) {
    return trackModelRuntime(runtime, { local, runtimes, observe: rows => this.observeModels(family, rows) });
  }

  async refreshSeats(projectId = null, terminalId = null, reason = 'manual') {
    await this.modelCatalog.refresh(reason);
    const info = this.seatsInfo(projectId, terminalId, true);
    if (!info) return null;
    const options = this.options[info.skill] || {}, { seatMigrationNotice: migrated, seatDefaultModels: prior = {} } = options;
    const next = {}, moved = [];
    for (const [id, seat] of Object.entries(info.defaults)) {
      next[id] = seat.model;
      const oldSolDefault = options.seatDefaultModels === undefined && /^gpt-\d+(?:\.\d+)?-sol$/.test(seat.model);
      const from = prior[id] || (oldSolDefault ? 'gpt-6.1-sol' : seat.model);
      if (from !== seat.model) moved.push({ seat: id, from, to: seat.model });
    }
    if (migrated || JSON.stringify(prior) !== JSON.stringify(next)) {
      this.options[info.skill] = { ...options, seatDefaultModels: next };
      delete this.options[info.skill].seatMigrationNotice;
      this.persistOptions();
    }
    return { ...info, ...(moved.length ? { defaultsMoved: moved } : {}), ...(migrated ? { migrated } : {}) };
  }

  routingContext() {
    const entry = [...this.entries.values()].find(entry => entry.source === 'builtin' && entry.seats?.length);
    if (!entry) return null;
    const agents = this.getAgents(), installed = { claude: !!agents.claude?.installed, codex: !!agents.codex?.installed };
    const catalog = modelSeats.catalog(installed, [...(this.modelCatalog?.rows() || []), ...this.getModels()]);
    const defaults = modelSeats.defaultsFor(installed, catalog, entry.seats);
    const stored = this.options[entry.id]?.routing || {};
    const restore = raw => {
      if (raw === undefined || raw === null) return null;
      try {
        const { config } = cleanConfig(raw, entry, catalog, true);
        return validateTeam(resolveTeam(entry, config, defaults), entry) ? null : config;
      } catch { return null; }
    };
    const template = restore(stored.template);
    return { entry, installed, catalog, defaults, stored, restore, template: template ?? emptyConfig(), invalidTemplate: stored.template != null && !template };
  }

  routingSelection(context, project, review = false) {
    const { entry, catalog, defaults, stored, restore, template } = context;
    const file = project && project.kind !== 'ssh' ? readRouting(project.path, entry, catalog, defaults) : { digest: null };
    if (file.digest && project) this.routingSeen.add(project.id);
    const { config, source, reason } = routingState(project, file, stored, this.routingSeen.has(project?.id));
    const active = source.layer === 'file' ? config : restore(config);
    if (config != null && !active) {
      source.layer = 'template';
      source.notice = 'invalid-local';
    }
    if (!active && context.invalidTemplate && !source.notice) source.notice = 'invalid-template';
    if (review && file.config && source.state !== 'trusted') {
      source.review = this.routingReview(project, file, reason, active ?? template, context);
    }
    return { config: active, source, file };
  }

  routingReview(project, file, reason, active, { entry, defaults, catalog }) {
    const key = JSON.stringify([routingWatch(project.path).signature, file.digest, reason, file.config, active, catalog]);
    const cached = this.routingReviews.get(project.id);
    if (cached?.entry === entry && cached.key === key) return structuredClone(cached.review);
    const next = resolveTeam(entry, file.config, defaults), previous = resolveTeam(entry, active, defaults);
    const review = reviewFile(file, reason, next, previous, catalog);
    this.routingReviews.set(project.id, { entry, key, review });
    return structuredClone(review);
  }

  seatsInfo(projectId = null, terminalId = null, includeTemplateCount = false) {
    const context = this.routingContext();
    if (!context) return null;
    const { entry, installed, catalog, defaults, template } = context, lead = entry.seats[0];
    const binding = terminalId ? this.seatSession(terminalId) : null;
    const projects = this.getProjects(), project = projects.find(item => item.id === (projectId ?? binding?.projectId));
    const { config, source } = this.routingSelection(context, project, includeTemplateCount);
    if (includeTemplateCount) source.templateProjects = projects.filter(item =>
      (item === project ? source : this.routingSelection(context, item).source).layer === 'template').length;
    const team = resolveTeam(entry, config ?? template, defaults), effective = team.effective;
    const snapshot = binding && (!projectId || binding.projectId === projectId) ? this.sessionSnapshot(binding.projectId, binding.sessionId) : null;
    const roles = team.team.map(item => item.row);
    const leadConfig = modelSeats.leadConfiguration(effective, lead, installed, catalog);
    const runningLead = snapshot?.seatsMap?.[lead];
    const agent = runningLead && familyOf(runningLead.model), remote = project?.kind === 'ssh';
    const restartLead = agent && (remote && agent === 'claude'
      ? modelSeats.leadOptions(effective, agent, { ...installed, claude: true }, catalog, lead) : leadConfig.leads[agent]);
    const applied = snapshot && binding.appliedRouting;
    const current = runningLead ? { ...(applied?.effective ?? effective), [lead]: restartLead || runningLead } : null;
    return { skill: entry.id, seats: team.seats, roles, lead, authors: team.authors, fresh: team.fresh,
      ...leadConfig, defaults, template, config, routing: source,
      effective, current, currentRoles: current ? applied?.roles ?? roles : null,
      catalog, installed, issues: modelSeats.seatIssues(effective, catalog),
      catalogAt: this.modelCatalog?.timestamps() || { claude: null, codex: null } };
  }

  sessionRoles(projectId, sessionId) {
    const snapshot = this.sessionSnapshot(projectId, sessionId);
    if (snapshot && Object.hasOwn(snapshot, 'roles')) return structuredClone(snapshot.roles);
    return this.seatsInfo(projectId)?.roles.sort((a, b) => Number(b.enabled) - Number(a.enabled)) ?? null;
  }

  applyRoutingOptions(id, routing) {
    const old = this.options[id];
    this.options[id] = { ...old, routing };
    const restore = () => {
      if (old) this.options[id] = old;
      else delete this.options[id];
      this.persistOptions();
    };
    if (!this.persistOptions()) { restore(); throw new Error('Routing options are unwritable.'); }
    return restore;
  }

  saveRoutingOptions(context, patch) {
    try { this.applyRoutingOptions(context.entry.id, { ...context.stored, ...patch }); }
    catch { return routingFailure('file-unwritable'); }
    return this.routingChanged();
  }

  routingChanged() {
    this.invalidateDelivery(); this.publish();
    return { ok: true };
  }

  writeProjectRouting(context, project, config, base) {
    const { entry, catalog, defaults, stored } = context, id = project.id;
    const local = { ...stored.local }; delete local[id];
    const result = writeRouting(project.path, config, base, [entry, catalog, defaults], (digest, cleaned) => {
      const trust = { ...stored.trust, [id]: { digest, config: cleaned, at: this.now() } };
      return this.applyRoutingOptions(entry.id, { ...stored, local, trust });
    });
    if (!result.ok) return result;
    this.routingWatchers.get(project.path)?.accept(routingWatch(project.path).signature);
    return this.routingChanged();
  }

  setRouting(scope, projectId, raw, base) {
    const project = this.getProjects().find(item => item.id === projectId);
    if (scope !== 'template' && (scope !== 'project' || !project)) throw new Error('Invalid routing scope or project.');
    const context = this.routingContext();
    if (!context) return routingFailure('unknown-seat');
    const { entry, catalog, defaults, stored } = context;
    if (scope === 'project' && project.kind !== 'ssh' && readRouting(project.path, entry, catalog, defaults).digest !== base) {
      return routingFailure('file-changed');
    }
    let config, team;
    try {
      ({ config } = cleanConfig(raw, entry, catalog));
      team = resolveTeam(entry, config, defaults);
      const invalid = validateTeam(team, entry);
      if (invalid) return invalid;
      config = compactConfig(entry, config);
    } catch (error) {
      const code = ['unknown-key', 'bad-format'].includes(error.code) ? 'invalid-role' : error.code || 'invalid-role';
      return routingFailure(code, error);
    }
    if (scope === 'template') return this.saveRoutingOptions(context, { template: config });
    if (project.kind === 'ssh') return this.saveRoutingOptions(context, { local: { ...stored.local, [project.id]: config } });
    return this.writeProjectRouting(context, project, config, base);
  }

  resolveRouting(projectId, action, digest) {
    const project = this.getProjects().find(item => item.id === projectId), context = this.routingContext();
    if (!project || project.kind === 'ssh' || !context) return routingFailure('action-unavailable');
    const { entry, stored, template } = context;
    const { config, source, file } = this.routingSelection(context, project);
    if (file.digest !== digest) return routingFailure('file-changed');
    if (action === 'overwrite' && ['link', 'not-file'].includes(file.error?.code)) return routingFailure('file-unwritable');
    if (!source.actions.includes(action)) return routingFailure('action-unavailable');
    if (action === 'overwrite') {
      return this.writeProjectRouting(context, project, compactConfig(entry, config ?? template), digest);
    }
    const trust = stored.trust || {};
    if (action === 'keep') {
      const previous = Object.hasOwn(trust, projectId) ? trust[projectId] : {};
      return this.saveRoutingOptions(context, { trust: { ...trust, [projectId]: { ...previous, rejected: digest, at: this.now() } } });
    }
    const local = { ...stored.local }; delete local[projectId];
    return this.saveRoutingOptions(context, { trust: { ...trust, [projectId]: { digest, config: file.config, at: this.now() } }, local });
  }

  replace(entry, text, by, project) {
    assertUserSkillName(metadata(text).name, this.builtinNames());
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
    const renderedRoot = canonical(path.join(this.dataDir, 'skill-delivery', 'rendered'));
    if (absolute.startsWith(renderedRoot + '/')) {
      const match = /^([a-f0-9]{32})\/([a-z][a-z0-9-]*)\/SKILL\.md$/i.exec(absolute.slice(renderedRoot.length + 1));
      const entry = match && this.entries.get(`builtin:${match[2]}`);
      if (entry?.seats?.length) return entry;
    }
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

  renderedSkill(seats, map, leadAgent, remote) {
    const entry = this.entries.get(seats.skill);
    const text = renderRoutingSkill(entry.text, { ...seats, map, leadAgent });
    if (remote || text === entry.text) return { path: entry.path, text };
    try {
      const root = path.join(this.dataDir, 'skill-delivery', 'rendered');
      if (fs.lstatSync(root, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('技能目录不能使用符号链接。');
      const file = checkedPath(path.join(root, digest(text).slice(0, 32)), entry.folder);
      if (readText(file) !== text) writeFile(file, text);
      else {
        const now = new Date();
        try { fs.utimesSync(file, now, now); } catch (error) { this.report(error); }
      }
      try { fs.chmodSync(file, 0o444); } catch { /* A read-only mode is best effort. */ }
      return { path: file, text };
    } catch (error) {
      this.report(error);
      return { path: entry.path, text: entry.text };
    }
  }

  deliveryInfo(project, remote, sessionId, agent) {
    const agents = this.getAgents(), routingNote = String(this.routingNote() || '').slice(0, 8192);
    const frozen = this.sessionSnapshot(project.id, sessionId), seats = this.seatsInfo(project.id);
    const roles = frozen && Object.hasOwn(frozen, 'roles') ? frozen.roles : seats?.roles.slice().sort((a, b) => Number(b.enabled) - Number(a.enabled)) ?? null;
    const leadAgent = agent || seats?.leadAgent;
    const leadSeat = seats && remote && leadAgent === 'claude'
      ? modelSeats.leadOptions(seats.effective, leadAgent, { ...seats.installed, claude: true }, seats.catalog, seats.lead) : seats?.leads[leadAgent];
    const seatsMap = frozen && Object.hasOwn(frozen, 'seatsMap') ? frozen.seatsMap : seats
      ? { ...seats.effective, ...(leadSeat && { [seats.lead]: leadSeat }) } : null;
    const agentSeats = frozen && Object.hasOwn(frozen, 'agentSeats') ? frozen.agentSeats : launchSeatMap(seatsMap, seats?.catalog);
    const rendered = frozen?.rendered || (seats && seatsMap ? { [seats.skill]: this.renderedSkill(seats, seatsMap, leadAgent, remote) } : {});
    const names = this.builtinNames();
    // Routing is not delivered as an instruction: the lead works its own way and the seats stay an app-side toolbox.
    const entries = [...this.entries.values()].filter(entry => entry.id !== ROUTING_ID && (entry.scope !== 'project' || !remote && entry.projectId === project.id)
      && (entry.source === 'builtin' || !names.includes(entry.name) && !names.includes(entry.folder)));
    const remotePath = entry => `{AGENTRIX_SKILLS}/${entry.scope === 'builtin' ? 'builtin' : 'global'}/${entry.folder}/SKILL.md`;
    const infos = entries.map(entry => this.info(entry));
    const ordered = infos.flatMap(info => info.source === 'builtin' ? [info, ...infos.filter(item => item.extends === info.name)] : info.extends ? [] : [info]);
    const skills = ordered.map(info => {
      if (info.enabled && runsOnFirstOpen(info)) {
        const firstSession = this.options[info.id]?.firstOpenedProjects?.[project.id];
        info.firstRun = !firstSession || firstSession === sessionId;
      }
      return { ...info, path: remote ? remotePath(this.entries.get(info.id)) : rendered[info.id]?.path || info.path };
    });
    const manifest = remote ? '{AGENTRIX_SKILLS}/instructions.md' : path.join(this.dataDir, 'skill-delivery',
      `${safeId(project.id).slice(0, 32)}-${agent === 'claude' || agent === 'codex' ? agent : 'preview'}.md`);
    return { skills, remote, agents, globalFolder: remote ? '{AGENTRIX_SKILLS}/global' : this.globalFolder,
      pendingPath: skill => remote ? `{AGENTRIX_SKILLS}/pending/${this.entry(skill.id).folder}/SKILL.md` : this.pendingPath(this.entry(skill.id)),
      manifest, routingNote, seatsMap, agentSeats, rendered, roles };
  }

  delivery(project, remote = false, sessionId = null, { agent = null, started = false } = {}) {
    // A newly added or moved project can launch before its first watcher scan.
    if (!remote && project.kind !== 'ssh' && this.projectSkills.get(project.id)?.path !== project.path
      && this.refreshProjectSkills(new Set())) { this.invalidateDelivery(); this.persistOptions(); }
    const agents = this.getAgents(), routingNote = String(this.routingNote() || '').slice(0, 8192);
    const signature = remote || project.kind === 'ssh' ? '' : routingWatch(project.path).signature;
    const key = JSON.stringify([project.id, remote, sessionId, agent, started, !!agents.claude?.installed, !!agents.codex?.installed, routingNote, signature]);
    if (this.deliveries.has(key)) return this.deliveries.get(key);
    const delivery = this.deliveryInfo(project, remote, sessionId, agent), { manifest } = delivery;
    if (started && sessionId) this.freezeDelivery(project.id, sessionId, delivery);
    let { skills } = delivery;
    let bundle = null;
    if (remote) {
      const files = [], included = [], enabled = skills.filter(skill => skill.enabled);
      const skippedNote = count => count ? `${count} enabled skills were omitted to keep the SSH bundle within its size limit.` : '';
      // Measure escaped JSON, including the manifest and omission notice, with ample room for the open envelope.
      for (const skill of enabled) {
        if (skill.extends && !included.some(base => base.source === 'builtin' && base.name === skill.extends)) continue;
        const entry = this.entries.get(skill.id), file = { id: entry.id, name: entry.folder, scope: entry.scope, text: delivery.rendered[skill.id]?.text ?? entry.text };
        const candidate = { ...delivery, skills: [...included, skill], skippedNote: skippedNote(enabled.length) };
        if (Buffer.byteLength(JSON.stringify({ files: [...files, file], instructions: skillInstructions(candidate), key: '0'.repeat(64) })) > MAX_SSH_BUNDLE_BYTES) continue;
        files.push(file); included.push(skill);
      }
      skills = included;
      Object.assign(delivery, { skills, skippedNote: skippedNote(enabled.length - included.length) });
      bundle = { files, instructions: skillInstructions(delivery) };
      bundle.key = safeId(JSON.stringify(bundle));
    } else {
      const instructions = skillInstructions(delivery);
      delivery.fingerprint = digest(JSON.stringify([instructions, skills.filter(skill => skill.enabled)
        .map(skill => [skill.id, delivery.rendered[skill.id]?.text ?? this.entries.get(skill.id)?.text])]));
      // Hooks need the launch's first-run details even if another session has already rewritten the current manifest.
      // Like receipts, the launch hash keeps 128 bits so PowerShell 5.1 can read snapshots under a long profile path.
      delivery.sessionManifest = path.join(path.dirname(manifest), `${safeId(project.id).slice(0, 32)}-${safeId(JSON.stringify([sessionId, agent, delivery.fingerprint])).slice(0, 32)}.md`);
      try {
        const current = agent === 'claude' && sessionId ? path.join(path.dirname(manifest), `${safeId(project.id).slice(0, 32)}-${digest(JSON.stringify([sessionId, agent, 'current'])).slice(0, 32)}.md`) : null;
        writeFile(delivery.sessionManifest, instructions);
        writeFile(`${delivery.sessionManifest}.json`, JSON.stringify({ fingerprint: delivery.fingerprint, projectRoot: project.path, roots: [this.builtinDir, this.globalFolder], builtinRoot: this.builtinDir, builtinNames: this.builtinNames(), current }));
        if (sessionId) {
          const sessionKey = JSON.stringify([canonical(this.dataDir), project.id, sessionId]);
          if (!liveSessionSnapshots.has(sessionKey)) liveSessionSnapshots.set(sessionKey, { files: new Set() });
          const session = liveSessionSnapshots.get(sessionKey);
          session.files.add(delivery.sessionManifest);
          if (current) {
            this.writeCurrentSnapshot(current, delivery, project.id, sessionId);
            session.files.add(current);
            if (started) Object.assign(session, { projectId: project.id, sessionId, current });
          }
        }
      } catch (error) { this.report(error); }
    }
    if (started && sessionId) {
      let recorded = false;
      for (const skill of skills.filter(skill => skill.firstRun)) {
        const runs = this.options[skill.id]?.firstOpenedProjects || {};
        if (runs[project.id]) continue;
        // Only an observed agent launch claims a first run, synchronously: simultaneous starts are first-wins.
        // Keep the agent session identity so another CLI in the same terminal is a later run.
        this.options[skill.id] = { ...this.options[skill.id], firstOpenedProjects: { ...runs, [project.id]: sessionId } };
        recorded = true;
      }
      if (recorded) { this.invalidateDelivery(); this.persistOptions(); }
    }
    if (!remote && (!agent || started && sessionId || !fs.existsSync(manifest))) {
      // Resumed Codex replays its original developer note. Keep its current-project path alive, without replaying first-open claims.
      const currentSkills = skills.map(skill => this.options[skill.id]?.firstOpenedProjects?.[project.id]
        ? { ...skill, firstRun: false } : skill);
      try { writeFile(manifest, skillInstructions({ ...delivery, skills: currentSkills })); } catch (error) { this.report(error); }
    }
    const result = { ...delivery, bundle };
    this.deliveries.set(key, result);
    return result;
  }

  freezeDelivery(projectId, sessionId, delivery) {
    const key = JSON.stringify([canonical(this.dataDir), projectId, sessionId]);
    let snapshot = liveSessionSnapshots.get(key);
    if (!snapshot) { snapshot = { files: new Set() }; liveSessionSnapshots.set(key, snapshot); }
    for (const field of ['seatsMap', 'agentSeats', 'rendered', 'roles']) {
      if (!Object.hasOwn(snapshot, field)) snapshot[field] = structuredClone(delivery[field]);
    }
    for (const { path: file } of Object.values(snapshot.rendered)) snapshot.files.add(file);
  }

  endSession(projectId, sessionId) {
    if (!sessionId) return;
    liveSessionSnapshots.delete(JSON.stringify([canonical(this.dataDir), projectId, sessionId]));
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

  syncRoutingWatchers() {
    const roots = new Set(this.getProjects().filter(project => project.kind !== 'ssh').map(project => project.path));
    for (const [root, watcher] of this.routingWatchers) if (!roots.has(root)) {
      watcher.stop(); this.routingWatchers.delete(root);
    }
    for (const root of roots) if (!this.routingWatchers.has(root)) {
      let signature = routingWatch(root).signature, timer;
      const watcher = monitorActivity(() => routingWatch(root), state => {
        if (signature === state.signature) return;
        signature = state.signature;
        clearTimeout(timer);
        timer = setTimeout(() => {
          if (this.closed) return;
          try { this.routingChanged(); } catch (error) { this.report(error); }
        }, 300);
        timer.unref?.();
      }, { interval: 2000, recursive: false, watch: () => routingWatch(root).folder });
      this.routingWatchers.set(root, {
        poll: watcher.poll,
        accept(next) { signature = next; clearTimeout(timer); },
        stop() { clearTimeout(timer); watcher.stop(); },
      });
    }
  }

  syncWatchers() {
    if (this.closed) return;
    this.syncRoutingWatchers();
    if (this.pruneProjects()) { this.invalidateDelivery(); this.persistOptions(); }
    const projectTargets = new Set(this.getProjects().filter(project => project.kind !== 'ssh').flatMap(projectSkillTargets));
    const roots = new Set([...this.roots().filter(entry => entry.source === 'user').map(entry => entry.root), ...projectTargets, path.join(this.dataDir, 'skill-pending')]);
    for (const [root, watcher] of this.watchers) if (!roots.has(root)) { watcher.stop(); this.watchers.delete(root); }
    for (const root of roots) if (!this.watchers.has(root)) {
      // Missing project skills folders are polled until created; never recursively watch the whole repo.
      // All directory events share one debounce, so N project watchers do not cause N full scans.
      const watcher = monitorActivity(async () => ({ signature: await (projectTargets.has(root) ? projectSkillSignature(root) : folderSignature(root, root === path.join(this.dataDir, 'skill-pending') ? 2 : 1)) }), () => this.queueRefresh(root),
        { interval: 2000, recursive: true, watch: () => {
          try { return (!projectTargets.has(root) || !linkedSkillParent(root)) && fs.lstatSync(root, { throwIfNoEntry: false })?.isDirectory() ? root : null; } catch { return null; }
        } });
      this.watchers.set(root, watcher);
    }
  }

  close() {
    this.closed = true; clearTimeout(this.scanTimer);
    for (const watchers of [this.watchers, this.routingWatchers]) {
      for (const watcher of watchers.values()) watcher.stop();
      watchers.clear();
    }
  }
}

module.exports = { SkillsStore, MAX_SSH_BUNDLE_BYTES, probeCodex, probeClaude };
