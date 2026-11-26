const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { monitorActivity } = require('../../codex-activity.cjs');
const { guideMetadata } = require('./guide-format.cjs');
const modelSeats = require('./model-seats.cjs');
const { agentOfModel, allowsUltracode } = require('./seat-rules.mjs');
const { cleanConfig, compactConfig, emptyConfig, resolveTeam, validateTeam } = require('./team-roles.cjs');
const { readRouting, writeRouting, routingState, reviewFile, routingWatch } = require('./project-routing.cjs');
const { renderRoutingGuide, modelWords } = require('./guide-render.cjs');
const { ModelCatalog, trackModelRuntime } = require('./model-catalog.cjs');
const { probeCodex, probeClaude } = require('./model-probe.cjs');
const { writeFileAtomic: writeFile } = require('../../atomic-write.cjs');
const { MAX_BYTES } = require('../../shared/front-matter.cjs');
const { launchNote, modeNote, routingChangeNote } = require('./mode-notes.cjs');
const { pruneGuides } = require('./guide-cleanup.cjs');

// Closing a store's watchers does not end its running conversations.
const liveSessionSnapshots = new Map();
const digest = value => createHash('sha256').update(value).digest('hex');
const MAX_SSH_GUIDE_BYTES = MAX_BYTES;

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

function loadOptions(file, report) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SyntaxError('Invalid routing JSON structure.');
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return migrateOptions(file, report);
    const corrupt = error instanceof SyntaxError;
    if (corrupt) {
      try { fs.copyFileSync(file, `${file}.corrupt-${randomUUID()}.bak`); }
      catch (backupError) { report(backupError); }
    }
    report(new Error(`Skipping routing JSON ${file}: ${error.message}`));
    return corrupt ? {} : null;
  }
}

function stripOperationConfig(config) {
  if (!config || !Object.hasOwn(config, 'operations')) return;
  delete config.operations;
}

function stripLegacyOperations(saved) {
  if (!saved) return;
  stripOperationConfig(saved.template);
  for (const config of Object.values(saved.local || {})) stripOperationConfig(config);
  for (const record of Object.values(saved.trust || {})) stripOperationConfig(record?.config);
}

function migrateOptions(file, report) {
  try {
    const old = JSON.parse(fs.readFileSync(path.join(path.dirname(file), 'skills.json'), 'utf8'))?.['builtin:model-routing'];
    if (!old || typeof old !== 'object' || Array.isArray(old)) return {};
    const options = {};
    for (const key of ['routing', 'seatDefaultModels', 'seatMigrationNotice', 'team', 'seats']) {
      if (Object.hasOwn(old, key)) options[key] = old[key];
    }
    stripLegacyOperations(options.routing);
    return options;
  } catch (error) {
    if (error.code !== 'ENOENT') report(error);
    return error.code === 'ENOENT' || error instanceof SyntaxError ? {} : null;
  }
}

class RoutingStore {
  constructor({ dataDir, guideFile, getProjects = () => [], getAgents = () => ({}), routingNote = () => '', changed = () => {}, report = () => {},
    getModels = () => [], modelProbes = {}, now = Date.now, seatSession = () => null }) {
    Object.assign(this, { dataDir, getProjects, getAgents, routingNote, changed, report, getModels, seatSession, now });
    this.renderedDir = path.join(dataDir, 'routing', 'rendered');
    this.optionsFile = path.join(dataDir, 'routing-settings.json');
    const options = loadOptions(this.optionsFile, report);
    this.options = options ?? {};
    this.optionsReadable = options !== null;
    this.routingWatchers = new Map();
    this.routingSeen = new Set();
    this.routingReviews = new Map();
    this.routingSeedTried = new Set();
    this.launches = new Map();
    this.modelCatalog = new ModelCatalog({ dataDir, probes: modelProbes, now, report, changed: () => this.publish() });
    try {
      if (fs.statSync(guideFile).size > MAX_BYTES) throw new Error('Routing guide is too large.');
      const text = fs.readFileSync(guideFile, 'utf8');
      this.entry = { ...guideMetadata(text, path.basename(guideFile, '.md')), path: guideFile, text };
    } catch (error) { report(error); }
    this.migrateTeams();
    this.pruneProjects();
    this.persistOptions();
    this.pruneRenderedGuides();
  }

  publish() {
    this.launches.clear();
    this.launchRefresh = this.changed();
  }

  pruneRenderedGuides(now = this.now()) {
    const live = new Set([...liveSessionSnapshots.values()].flatMap(session => [...session.files]));
    pruneGuides(this.renderedDir, live, this.report, now);
  }

  migrateTeams() {
    const entry = this.entry;
    let options = this.options;
    if (!entry?.seats?.length || options.routing) return;
    if (options.team?.version !== 2 && (options.seats || options.seatDefaultModels)) options = this.migrateLegacySeats(entry, options);
    const { team, ...rest } = options;
    if (!team) return;
    const roles = modelSeats.cleanStoredSeats(team?.global, entry.seats);
    const template = { roles };
    const local = Object.fromEntries(this.getProjects().flatMap(({ id }) => {
      const seatOverride = Object.hasOwn(team?.projects || {}, id);
      if (!seatOverride) return [];
      const projectRoles = modelSeats.cleanStoredSeats(team.projects[id], entry.seats);
      return [[id, { roles: { ...roles, ...projectRoles } }]];
    }));
    this.options = { ...rest, routing: { template, local, trust: {} } };
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
    let modified = false;
    for (const id of this.routingSeedTried) if (!projects.has(id)) this.routingSeedTried.delete(id);
    for (const id of this.routingSeen) if (!projects.has(id)) this.routingSeen.delete(id);
    for (const id of this.routingReviews.keys()) if (!projects.has(id)) this.routingReviews.delete(id);
    for (const scoped of [this.options.routing?.local, this.options.routing?.trust]) {
      for (const id of Object.keys(scoped || {})) if (!projects.has(id)) { delete scoped[id]; modified = true; }
    }
    return modified;
  }

  persistOptions() {
    // A failed startup read may have left saved settings we cannot safely replace.
    if (!this.optionsReadable) return false;
    const text = JSON.stringify(this.options);
    if (this.optionsText === text) return true;
    try { writeFile(this.optionsFile, text); this.optionsText = text; return true; }
    catch (error) { this.report(error); return false; }
  }


  sessionSnapshot(projectId, sessionId) {
    return sessionId ? liveSessionSnapshots.get(this.sessionKey(projectId, sessionId)) : null;
  }

  leadOptions(projectId, agent, { remote = false } = {}) {
    const info = this.seatsInfo(projectId);
    if (!info || !remote) return info?.leads[agent] ?? null;
    // The SSH shell resolves the CLI on its own host.
    return modelSeats.leadOptions(info.effective, agent, { ...info.installed, [agent]: true }, info.catalog, info.lead);
  }

  // A terminal lead takes its seat only in conductor mode. In native mode it is the plain CLI, which /model and /effort change.
  terminalLead(projectId, { remote = false } = {}) {
    if (!this.seatsInfo(projectId)?.conductor) return null;
    const seat = this.leadOptions(projectId, 'claude', { remote });
    if (!seat) return null;
    return { ...seat, seatsMap: this.dispatchSeats(projectId) };
  }

  dispatchSeats(projectId) {
    const info = this.seatsInfo(projectId);
    return launchSeatMap(info?.effective, info?.catalog);
  }

  leadAgent(projectId) { return this.seatsInfo(projectId)?.leadAgent ?? null; }

  // Model routing owns the lead's settings only in conductor mode.
  routingOwned(projectId) { return !!this.seatsInfo(projectId)?.conductor; }

  observeModels(family, rows) { this.modelCatalog.accept(family, rows); }

  trackModelRuntime(runtime, { family, local, runtimes }) {
    return trackModelRuntime(runtime, { local, runtimes, observe: rows => this.observeModels(family, rows) });
  }

  async refreshSeats(projectId = null, terminalId = null, reason = 'manual') {
    await this.modelCatalog.refresh(reason);
    const info = this.seatsInfo(projectId, terminalId, true);
    if (!info) return null;
    const options = this.options, { seatMigrationNotice: migrated, seatDefaultModels: prior = {} } = options;
    const next = {}, moved = [];
    for (const [id, seat] of Object.entries(info.defaults)) {
      next[id] = seat.model;
      const oldSolDefault = options.seatDefaultModels === undefined && /^gpt-\d+(?:\.\d+)?-sol$/.test(seat.model);
      const from = prior[id] || (oldSolDefault ? 'gpt-6.1-sol' : seat.model);
      if (from !== seat.model) moved.push({ seat: id, from, to: seat.model });
    }
    if (migrated || JSON.stringify(prior) !== JSON.stringify(next)) {
      this.options = { ...options, seatDefaultModels: next };
      delete this.options.seatMigrationNotice;
      this.persistOptions();
    }
    return { ...info, ...(moved.length ? { defaultsMoved: moved } : {}), ...(migrated ? { migrated } : {}) };
  }

  routingContext() {
    const entry = this.entry;
    if (!entry?.seats?.length) return null;
    const agents = this.getAgents(), installed = { claude: !!agents.claude?.installed, codex: !!agents.codex?.installed };
    const catalog = modelSeats.catalog(installed, [...(this.modelCatalog?.rows() || []), ...this.getModels()]);
    const defaults = modelSeats.defaultsFor(installed, catalog, entry.seats);
    const stored = this.options.routing || {};
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

  seatsInfo(projectId = null, terminalId = null, review = false) {
    const context = this.routingContext();
    if (!context) return null;
    const { entry, installed, catalog, defaults, template } = context, lead = entry.seats[0];
    const binding = terminalId ? this.seatSession(terminalId) : null;
    const project = this.getProjects().find(item => item.id === (projectId ?? binding?.projectId));
    const { config, source } = this.routingSelection(context, project, review);
    const team = resolveTeam(entry, config ?? template, defaults), effective = team.effective;
    const snapshot = binding && (!projectId || binding.projectId === projectId) ? this.sessionSnapshot(binding.projectId, binding.sessionId) : null;
    const roles = team.team.map(item => item.row);
    const leadConfig = modelSeats.leadConfiguration(effective, lead, installed, catalog);
    const runningLead = snapshot?.seatsMap?.[lead];
    const agent = runningLead && agentOfModel(runningLead.model), remote = project?.kind === 'ssh';
    const restartLead = agent && (remote && agent === 'claude'
      ? modelSeats.leadOptions(effective, agent, { ...installed, claude: true }, catalog, lead) : leadConfig.leads[agent]);
    const applied = snapshot && binding.appliedRouting;
    const current = runningLead ? { ...(applied?.effective ?? effective), [lead]: restartLead || runningLead } : null;
    return { seats: team.seats, roles, lead, authors: team.authors, fresh: team.fresh,
      ...leadConfig, defaults, template, config, routing: source, conductor: !!(config ?? template).conductor,
      effective, current, currentRoles: current ? applied?.roles ?? roles : null,
      catalog, installed, issues: modelSeats.seatIssues(effective, catalog),
      catalogAt: this.modelCatalog?.timestamps() || { claude: null, codex: null } };
  }

  sessionRoles(projectId, sessionId) {
    const snapshot = this.sessionSnapshot(projectId, sessionId);
    if (snapshot && Object.hasOwn(snapshot, 'roles')) return structuredClone(snapshot.roles);
    return this.seatsInfo(projectId)?.roles.sort((a, b) => Number(b.enabled) - Number(a.enabled)) ?? null;
  }

  applyRoutingOptions(routing) {
    const old = this.options;
    this.options = { ...old, routing };
    const restore = () => {
      this.options = old;
      this.persistOptions();
    };
    if (!this.persistOptions()) { restore(); throw new Error('Routing options are unwritable.'); }
    return restore;
  }

  saveRoutingOptions(context, patch) {
    try { this.applyRoutingOptions({ ...context.stored, ...patch }); }
    catch { return routingFailure('file-unwritable'); }
    return this.routingChanged();
  }

  routingChanged() {
    this.publish();
    return { ok: true };
  }

  writeProjectRouting(context, project, config, base) {
    const { entry, catalog, defaults, stored } = context, id = project.id;
    const local = { ...stored.local }; delete local[id];
    const result = writeRouting(project.path, config, base, [entry, catalog, defaults], (digest, cleaned) => {
      const trust = { ...stored.trust, [id]: { digest, config: cleaned, at: this.now() } };
      return this.applyRoutingOptions({ ...stored, local, trust });
    });
    if (!result.ok) return result;
    this.routingWatchers.get(project.path)?.accept(routingWatch(project.path).signature);
    return this.routingChanged();
  }

  acceptProjectRouting(context, id, { digest, config }) {
    const { stored } = context;
    const local = { ...stored.local }; delete local[id];
    return this.saveRoutingOptions(context, { trust: { ...stored.trust, [id]: { digest, config, at: this.now() } }, local });
  }

  seedProjectRouting(project) {
    if (!this.optionsReadable || !project || project.kind === 'ssh' || this.routingSeedTried.has(project.id)) return false;
    const { id } = project;
    try {
      const context = this.routingContext();
      if (!context) return false;
      const { entry, catalog, defaults, stored, restore, template } = context;
      const hasTrust = Object.hasOwn(stored.trust || {}, id);
      if (!hasTrust && context.invalidTemplate) return false;
      this.routingSeedTried.add(id);
      if (hasTrust) return false;
      const raw = Object.hasOwn(stored.local || {}, id) ? stored.local[id] : null, local = restore(raw);
      if (raw != null && !local) return false;
      const file = readRouting(project.path, entry, catalog, defaults);
      if (file.error) return false;
      const config = compactConfig(entry, local ?? template);
      if (file.digest === null) return this.writeProjectRouting(context, project, config, null).ok;
      // Compare in the parsed form used by the writer's trust record.
      const parsed = cleanConfig(config, entry, catalog, true, true);
      if (parsed.ignored.length || !isDeepStrictEqual(file.config, parsed.config)) return false;
      return this.acceptProjectRouting(context, id, file).ok;
    } catch (error) { this.report(error); return false; }
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
    if (action === 'keep') {
      const trust = stored.trust || {};
      const previous = Object.hasOwn(trust, projectId) ? trust[projectId] : {};
      return this.saveRoutingOptions(context, { trust: { ...trust, [projectId]: { ...previous, rejected: digest, at: this.now() } } });
    }
    return this.acceptProjectRouting(context, projectId, file);
  }

  renderedGuide(seats, map, leadAgent, remote, weights) {
    const entry = this.entry;
    const rendered = renderRoutingGuide(entry.text, { ...seats, map, leadAgent });
    const text = weights ? rendered.trimEnd() + '\n\n### Adopted routing weights\n\n' + weights + '\n' : rendered;
    if (remote) return { path: '{AGENTRIX_ROUTING}', text };
    try {
      for (const folder of [path.dirname(this.renderedDir), this.renderedDir]) {
        const stat = fs.lstatSync(folder, { throwIfNoEntry: false });
        if (stat && !stat.isDirectory()) throw new Error('Invalid routing guide directory.');
      }
      const file = path.join(this.renderedDir, digest(text).slice(0, 32) + '.md');
      const stat = fs.lstatSync(file, { throwIfNoEntry: false });
      if (stat && !stat.isFile()) throw new Error('Invalid rendered routing guide.');
      if (stat?.size === Buffer.byteLength(text) && fs.readFileSync(file, 'utf8') === text) {
        const now = new Date(this.now());
        fs.utimesSync(file, now, now);
      } else {
        if (stat) fs.chmodSync(file, 0o600);
        writeFile(file, text);
      }
      try { fs.chmodSync(file, 0o444); } catch { /* A read-only mode is best effort. */ }
      return { path: file, text };
    } catch (error) {
      this.report(error);
      return { path: entry.path, text: entry.text };
    }
  }

  launchSnapshot(remote, seats, agent, weights) {
    const leadAgent = agent || seats?.leadAgent;
    const lead = seats && remote && leadAgent === 'claude'
      ? modelSeats.leadOptions(seats.effective, leadAgent, { ...seats.installed, claude: true }, seats.catalog, seats.lead) : seats?.leads[leadAgent];
    const seatsMap = seats ? { ...seats.effective, ...(lead && { [seats.lead]: lead }) } : null;
    const agentSeats = launchSeatMap(seatsMap, seats?.catalog);
    const roles = seats?.roles.slice().sort((a, b) => Number(b.enabled) - Number(a.enabled)) ?? null;
    const guide = seats?.conductor && seatsMap ? this.renderedGuide(seats, seatsMap, leadAgent, remote, weights) : null;
    return { seatsMap, agentSeats, roles, guide, remote };
  }

  launch(project, remote = false, sessionId = null, { agent = null, started = false } = {}) {
    if (!remote && project.kind !== 'ssh') {
      this.seedProjectRouting(this.getProjects().find(item => item.id === project.id && item.path === project.path));
    }
    const seats = this.seatsInfo(project.id), conductor = seats?.conductor === true;
    const weights = conductor ? String(this.routingNote() || '').slice(0, 8192) : '';
    const key = JSON.stringify([project.id, remote, sessionId, agent, conductor, weights, seats?.effective, seats?.roles, seats?.catalog]);
    const frozen = this.sessionSnapshot(project.id, sessionId);
    const snapshot = frozen || this.launches.get(key) || this.launchSnapshot(remote, seats, agent, weights);
    const guide = !conductor ? null : snapshot.guide || this.launchSnapshot(remote, seats, agent, weights).guide;
    if (!frozen) this.launches.set(key, snapshot);
    if (sessionId && started) {
      if (!frozen) this.freezeLaunch(project.id, sessionId, snapshot);
      if (guide && !remote) this.sessionSnapshot(project.id, sessionId).files.add(guide.path);
    }
    return { conductor, seatsMap: snapshot.seatsMap, agentSeats: snapshot.agentSeats, roles: snapshot.roles,
      guide, note: launchNote({ conductor, remote, guidePath: guide?.path }) };
  }

  sessionKey(projectId, sessionId) {
    return JSON.stringify([canonical(this.dataDir), projectId, sessionId]);
  }

  freezeLaunch(projectId, sessionId, snapshot) {
    liveSessionSnapshots.set(this.sessionKey(projectId, sessionId), { ...structuredClone(snapshot), files: new Set() });
  }

  endSession(projectId, sessionId) {
    if (!sessionId) return;
    liveSessionSnapshots.delete(this.sessionKey(projectId, sessionId));
    for (const key of this.launches.keys()) {
      const [project, , session] = JSON.parse(key);
      if (project === projectId && session === sessionId) this.launches.delete(key);
    }
  }

  // The enabled seats of a conductor project as one line, from the saved routing or from the map a session started with;
  // null in native mode, where no seats are told.
  seatTable(projectId, map = null) {
    const info = this.seatsInfo(projectId);
    if (!info?.conductor) return null;
    const seats = map ?? info.effective;
    return info.roles.filter(role => role.enabled !== false && seats?.[role.id]).map(role => {
      const seat = seats[role.id];
      const ultracode = allowsUltracode(seat.model, role.id === info.lead) && seat.ultracode;
      return `${role.name} (${role.id}): ${modelWords({ ...seat, ultracode })}`;
    }).join('; ') || null;
  }

  // What a running conductor conversation is told after a routing change: the note and the table it now knows, or null.
  routingChange(projectId, sessionId, told) {
    const table = this.seatTable(projectId);
    if (!table) return null;
    const started = this.sessionSnapshot(projectId, sessionId);
    if (started && !started.remote && !started.guide) {
      // The local mode notice follows this check and supplies the first guide for this conversation.
      if (started.notifiedSeats === undefined || started.notifiedSeats === table) return null;
      started.notifiedSeats = table;
    } else {
      const known = told !== undefined ? told : started?.guide ? this.seatTable(projectId, started.seatsMap) : null;
      if (known === table) return null;
    }
    return { table, note: routingChangeNote(table) };
  }

  modeNote(project, sessionId, agent) {
    const remote = project.kind === 'ssh';
    const launch = this.launch(project, remote, sessionId, { agent, started: true });
    const started = this.sessionSnapshot(project.id, sessionId);
    if (!remote && started && !started.guide) started.notifiedSeats = launch.guide ? this.seatTable(project.id) : undefined;
    return modeNote(launch.conductor, remote ? null : launch.guide?.path, remote);
  }

  syncRoutingWatchers() {
    const roots = new Map(this.getProjects().filter(project => project.kind !== 'ssh').map(project => [project.path, project]));
    for (const [root, watcher] of this.routingWatchers) if (!roots.has(root)) {
      watcher.stop(); this.routingWatchers.delete(root);
    }
    for (const [root, project] of roots) if (!this.routingWatchers.has(root)) {
      this.seedProjectRouting(project);
      // Publishing a seed can synchronously re-enter this scan and install the watcher.
      if (this.routingWatchers.has(root)) continue;
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
    if (this.pruneProjects()) { this.launches.clear(); this.persistOptions(); }
  }

  close() {
    this.closed = true;
    for (const watcher of this.routingWatchers.values()) watcher.stop();
    this.routingWatchers.clear();
  }
}

function remoteGuide(guide) {
  if (!guide) return null;
  if (Buffer.byteLength(guide.text) > MAX_SSH_GUIDE_BYTES) throw new Error('Routing guide exceeds the SSH size limit.');
  return { key: digest(guide.text), text: guide.text };
}

module.exports = { RoutingStore, MAX_SSH_GUIDE_BYTES, remoteGuide, probeCodex, probeClaude };
