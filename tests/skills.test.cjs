const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SkillsStore, MAX_SSH_BUNDLE_BYTES } = require('../electron/features/skills/store.cjs');
const { registerSkillsIpc } = require('../electron/features/skills/ipc.cjs');
const { metadata, draftText, importFiles, MAX_IMPORT_BYTES, MAX_IMPORT_FILES } = require('../electron/features/skills/files.cjs');
const { safeId, MAX_VERSIONS, TEXT_VERSIONS } = require('../electron/features/skills/history.cjs');
const { startupNote } = require('../electron/features/agents/handoff.cjs');
const { MAX_NOTE } = require('../electron/features/skills/delivery.cjs');
const { ActionLog, TranscriptTail, claudeRecord, codexRecord, skillDescription } = require('../electron/agent-actions.cjs');
const { CodexActivityReader } = require('../electron/codex-activity.cjs');

const text = (name, body = 'Use this procedure.', description = 'A tested procedure.') => `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n${body}\n`;
const put = (file, body) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body); };
const draft = (name, scope = 'global', projectId = null, body = 'First version.') => ({ name, description: 'A tested procedure.', text: body, scope, projectId });

test('metadata and activity descriptions share front-matter decoding for BOM, quotes and folded scalars', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentrix-front-matter-'));
  t.after(async () => { await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const file = path.join(root, 'SKILL.md');
  for (const description of ['"Read \\"quoted\\" paths"', "'Read the project''s own procedure'", '>\n  Read the project\n  before changing code']) {
    const source = `\uFEFF---\nname: example\ndescription: ${description}\n---\nBody.\n`;
    put(file, source);
    assert.equal(await skillDescription('example', root, file), metadata(source).description);
  }
});

function fixture(t, setup = () => {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentrix-skills-'));
  const dataDir = path.join(root, 'profile'), builtinDir = path.join(root, 'resources', 'skills');
  const projects = [{ id: 'p1', name: 'First', path: path.join(root, 'first') }, { id: 'p2', name: 'Second', path: path.join(root, 'second') }, { id: 'ssh', name: 'Remote', kind: 'ssh', path: '/srv/app' }];
  for (const project of projects.filter(p => p.kind !== 'ssh')) fs.mkdirSync(project.path);
  put(path.join(builtinDir, 'model-routing', 'SKILL.md'), fs.readFileSync(path.join(__dirname, '../resources/skills/model-routing/SKILL.md'), 'utf8'));
  const changed = [], changes = [], errors = [], active = [];
  const options = { dataDir, builtinDir, getProjects: () => projects, getAgents: () => ({ claude: { installed: true }, codex: { installed: false } }), activeProjects: () => active,
    changed: (value, change) => { changed.push(value); changes.push(change); }, report: error => errors.push(error) };
  setup({ root, dataDir, builtinDir, projects, active });
  const store = new SkillsStore(options);
  t.after(async () => { store.close(); await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  return { root, dataDir, builtinDir, projects, store, changed, changes, errors, active, options };
}

const until = async (check, label) => {
  const deadline = Date.now() + 10000;
  while (!check()) { if (Date.now() > deadline) throw new Error(`Timed out: ${label}`); await new Promise(resolve => setTimeout(resolve, 30)); }
};

test('seat info suggests the newest listed Codex model at the lowest rank below three', t => {
  const { store } = fixture(t);
  let installed = true, models = [
    { model: 'gpt-7', rank: 2 }, { model: 'gpt-6.9-mini' }, { model: 'gpt-6.10-mini' }, { model: 'gpt-6.11-mini', listed: false },
  ];
  store.getAgents = () => ({ claude: { installed: true }, codex: { installed } });
  store.getModels = () => models;
  const suggestion = () => store.seatsInfo('p1').operations.rows.find(row => row.id === 'memory').suggestion;
  assert.equal(suggestion(), 'gpt-6.10-mini');
  installed = false;
  assert.equal(suggestion(), undefined);
  installed = true;
  models = [{ model: 'gpt-7' }];
  assert.equal(suggestion(), undefined);
});

test('skill defaults, exact public shape, read-only built-ins and local-only project scopes', async t => {
  const { store } = fixture(t), builtin = store.list()[0];
  assert.deepEqual(Object.keys(builtin).sort(), ['id', 'name', 'description', 'title', 'summary', 'when', 'extends', 'replaced', 'source', 'scope', 'projectId', 'projectName', 'path', 'enabled', 'trigger', 'firstOpenRun', 'seatSummary', 'autoOptimize', 'confirmChanges', 'version', 'updatedAt', 'updatedBy', 'updatedIn', 'createdByAgent', 'pending', 'requires', 'lastUsed'].sort());
  assert.deepEqual([builtin.id, builtin.enabled, builtin.trigger, builtin.autoOptimize], ['builtin:model-routing', true, 'auto', false]);
  assert.deepEqual(builtin.requires, { claude: true, codex: false });
  assert.equal(builtin.firstOpenRun, false);
  assert.deepEqual(builtin.seatSummary[0], { seat: 'orchestrator', name: '总指挥', model: 'opus', effort: 'high', fast: false });
  await assert.rejects(() => store.save(builtin.id, draft('model-routing')), /只读/);
  for (const action of [() => store.delete(builtin.id), () => store.revert(builtin.id, 1), () => store.resolveChange(builtin.id, true), () => store.setOptions(builtin.id, { autoOptimize: true })]) assert.throws(action, /只读/);
  await assert.rejects(() => store.save(null, draft('remote', 'project', 'ssh')), /本地/);
  const user = await store.save(null, draft('mine'));
  assert.deepEqual([user.enabled, user.trigger, user.autoOptimize, user.confirmChanges, user.createdByAgent], [true, 'auto', true, false, false]);
  const scoped = await store.save(null, draft('mine', 'project', 'p1'));
  assert.equal(scoped.id, 'project:p1:mine');
  assert.equal(scoped.projectName, 'First');
});

const routing = (roles = {}, operations = {}) => ({ roles, operations });
const routeFile = project => path.join(project.path, '.agentrix', 'routing.json');
const routeDocument = (roles, operations) => JSON.stringify({ format: 'agentrix-routing', version: 1, ...routing(roles, operations) });
const seat = model => ({ model, effort: 'high' });

test('routing saves validate atomically and project files are independent of the template', async t => {
  const f = fixture(t), { store, projects } = f, before = store.read('builtin:model-routing').text;
  store.getAgents = () => ({ claude: { installed: true }, codex: { installed: true } });
  for (const [roles, code] of [
    [{ unknown: seat('opus') }, 'invalid-role'], [{ developer: seat('bad;id') }, 'invalid-model'],
    [{ developer: { model: 'gpt-6.1-sol', effort: 'max' } }, 'invalid-effort'],
    [{ designer: { ...seat('sonnet'), fast: true } }, 'fast-not-allowed'],
    [{ orchestrator: { enabled: false } }, 'lead-locked'], [{ reviewer: seat('gpt-6.1-sol') }, 'reviewer-same-model'],
  ]) {
    const result = store.setRouting('template', null, routing(roles), null);
    assert.equal(result.ok, false); assert.equal(result.code, code); assert.deepEqual(store.seatsInfo().template, routing());
  }
  assert.deepEqual(store.setRouting('template', null, routing({ researcher: seat('haiku') }), null), { ok: true });
  assert.deepEqual(store.setRouting('project', 'p1', routing({ designer: seat('opus') }), null), { ok: true });
  assert.equal(store.seatsInfo('p1').effective.researcher.model, 'sonnet');
  assert.equal(store.seatsInfo('p1').effective.designer.model, 'opus');
  assert.equal(store.seatsInfo('p2').effective.researcher.model, 'haiku');
  const raw = fs.readFileSync(routeFile(projects[0]), 'utf8'), info = store.seatsInfo('p1');
  assert.deepEqual(JSON.parse(raw), JSON.parse(routeDocument({ designer: seat('opus') })));
  assert.ok(f.changes.some(change => change.deliveryChanged));
  assert.equal(store.read('builtin:model-routing').text, before);
  await assert.rejects(() => store.save('builtin:model-routing', draft('model-routing')), /\u53EA\u8BFB/);
  assert.deepEqual(store.setRouting('project', 'p1', routing(), info.routing.digest), { ok: true });
  assert.deepEqual(store.seatsInfo('p1').config, routing());
  assert.deepEqual(f.errors, []);
});

test('removed projects lose local and trust records without deleting the project file', t => {
  const { store, projects } = fixture(t), [project, , ssh] = projects;
  assert.deepEqual(store.setRouting('project', project.id, routing({ researcher: seat('opus') }), null), { ok: true });
  assert.deepEqual(store.setRouting('project', ssh.id, routing({ designer: seat('opus') }), null), { ok: true });
  projects.splice(2, 1); projects.shift();
  store.refresh();
  const { local, trust } = JSON.parse(fs.readFileSync(store.optionsFile, 'utf8'))['builtin:model-routing'].routing;
  assert.deepEqual(local, {}); assert.deepEqual(trust, {});
  assert.equal(fs.existsSync(routeFile(project)), true);
});

test('template and legacy layers are independent and SSH saves remain local', t => {
  const id = 'builtin:model-routing', team = { version: 2, global: { researcher: seat('haiku') }, projects: { ssh: { designer: seat('opus') } } };
  const operations = { version: 1, global: { lookup: seat('opus') }, projects: { ssh: { background: { model: 'sonnet' } } } };
  const { store, projects } = fixture(t, ({ dataDir }) => put(path.join(dataDir, 'skills.json'), JSON.stringify({ [id]: { team, operations } })));
  const stored = () => JSON.parse(fs.readFileSync(store.optionsFile, 'utf8'))[id];
  assert.deepEqual(stored().routing.template, routing(team.global, operations.global));
  assert.deepEqual(stored().routing.local.ssh, routing({ ...team.global, ...team.projects.ssh }, { ...operations.global, ...operations.projects.ssh }));
  assert.equal(stored().team, undefined); assert.equal(stored().operations, undefined);
  assert.ok(projects.slice(0, 2).every(project => !fs.existsSync(routeFile(project))));
  assert.deepEqual(store.setRouting('template', null, routing(), null), { ok: true });
  assert.equal(store.seatsInfo('ssh').effective.researcher.model, 'haiku');
  assert.equal(store.seatsInfo('p1').operations.effective.lookup.model, 'haiku');
  assert.deepEqual(store.setRouting('project', 'ssh', routing({ designer: seat('opus') }), null), { ok: true });
  assert.equal(store.seatsInfo('ssh').routing.path, null);
  assert.equal(store.seatsInfo('ssh').routing.layer, 'local');
  assert.deepEqual(stored().routing.local.ssh, routing({ designer: seat('opus') }));
});

test('the review operation enforces reviewer independence against enabled authors', t => {
  const { store } = fixture(t);
  store.getAgents = () => ({ claude: { installed: true }, codex: { installed: true } });
  store.getModels = () => [{ model: 'gpt-6.2-sol' }, { model: 'gpt-6.3-sol' }];
  const model = 'gpt-6.2-sol';
  const refused = store.setRouting('project', 'p1', routing({ frontend: { ...seat(model), enabled: true } }, { review: { model } }), null);
  assert.equal(refused.code, 'review-same-model');
  assert.equal(refused.operation, 'review');
  assert.equal(store.seatsInfo('p1').routing.digest, null);
  assert.deepEqual(store.setRouting('project', 'p1', routing({ frontend: seat(model) }, { review: { model } }), null), { ok: true });
});

test('pending routing retains accepted settings and freezes launched roles through edits', t => {
  const { store, projects } = fixture(t), project = projects[0], id = project.id;
  const config = routing({ qa: { enabled: false }, 'x-mobile': { from: 'frontend', name: 'Mobile One', duty: 'Build the app' } });
  assert.deepEqual(store.setRouting('project', id, config, null), { ok: true });
  const trusted = store.seatsInfo(id).routing.digest, file = routeFile(project);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/\n/g, '\r\n'));
  assert.equal(store.seatsInfo(id).routing.digest, trusted);
  store.delivery(project, false, 'one', { agent: 'claude', started: true });
  const changed = { 'x-mobile': { from: 'frontend', name: 'Mobile Two', duty: 'Review the app', fresh: true } };
  fs.writeFileSync(file, routeDocument(changed));
  const pending = store.seatsInfo(id, null, true);
  assert.equal(pending.routing.state, 'pending'); assert.equal(pending.routing.layer, 'accepted');
  assert.equal(pending.config.roles['x-mobile'].name, 'Mobile One');
  assert.equal(pending.routing.review.config.roles['x-mobile'].duty, 'Review the app');
  assert.equal(store.resolveRouting(id, 'apply', trusted).code, 'file-changed');
  assert.deepEqual(store.resolveRouting(id, 'keep', pending.routing.digest), { ok: true });
  assert.equal(store.seatsInfo(id).routing.state, 'rejected');
  assert.deepEqual(store.resolveRouting(id, 'apply', pending.routing.digest), { ok: true });
  store.delivery(project, false, 'two', { agent: 'claude', started: true });
  assert.equal(store.sessionRoles(id, 'one').find(role => role.id === 'x-mobile').name, 'Mobile One');
  assert.equal(store.sessionRoles(id, 'one').find(role => role.id === 'x-mobile').fresh, false);
  assert.equal(store.sessionRoles(id, 'one').find(role => role.id === 'qa').enabled, false);
  assert.equal(store.sessionRoles(id, 'two').find(role => role.id === 'x-mobile').name, 'Mobile Two');
  assert.equal(store.sessionRoles(id, 'two').find(role => role.id === 'x-mobile').fresh, true);
  fs.rmSync(file);
  assert.equal(store.seatsInfo(id).routing.notice, 'file-deleted');
  assert.equal(store.seatsInfo(id).routing.layer, 'template');
});

test('worker seats go live while the running lead stays pinned', t => {
  const { store, projects } = fixture(t), [project] = projects, id = project.id;
  store.seatSession = () => ({ projectId: id, sessionId: 'running', nativeClaude: true });
  const first = store.delivery(project, false, 'running', { agent: 'claude', started: true });
  const before = store.seatsInfo(id, 'terminal');
  const live = routing({ orchestrator: { model: 'sonnet', effort: 'medium' }, designer: { model: 'haiku', effort: 'low' },
    'x-mobile': { from: 'frontend', name: 'Mobile', duty: 'Build the app' } },
  { lookup: { model: 'sonnet', effort: 'medium' }, subagent: { model: 'sonnet' } });
  assert.equal(before.leadPending, null);
  assert.deepEqual(store.setRouting('project', id, live, null), { ok: true });
  const saved = store.seatsInfo(id, 'terminal');
  assert.deepEqual(saved.current.orchestrator, before.current.orchestrator);
  assert.deepEqual(saved.leadPending, { model: 'sonnet', effort: 'medium', fast: false });
  assert.deepEqual(saved.current.designer, saved.effective.designer);
  assert.equal(saved.currentRoles.find(role => role.id === 'x-mobile')?.name, 'Mobile');
  assert.deepEqual(saved.operations.pending, ['subagent']);
  assert.deepEqual(saved.operations.current.values.lookup, live.operations.lookup);
  assert.deepEqual(saved.operations.current.values.subagent, before.operations.current.values.subagent);
  assert.deepEqual(store.delivery(project, false, 'running', { agent: 'claude', started: true }).rendered, first.rendered);

  fs.writeFileSync(routeFile(project), routeDocument({ designer: { model: 'opus', effort: 'medium' } }));
  const pending = store.seatsInfo(id, 'terminal', true);
  assert.equal(pending.routing.state, 'pending');
  assert.equal(store.dispatchSeats(id).designer.model, 'haiku');
  assert.deepEqual(store.resolveRouting(id, 'apply', pending.routing.digest), { ok: true });
  assert.equal(store.dispatchSeats(id).designer.model, 'opus');
  assert.equal(store.seatsInfo(id, 'terminal').leadPending, null);
  fs.writeFileSync(routeFile(project), '{broken');
  assert.equal(store.seatsInfo(id, 'terminal').routing.state, 'invalid');
  assert.equal(store.dispatchSeats(id).designer.model, 'opus');
});

test('the routing save IPC returns after active session updates settle', async t => {
  const { store, projects } = fixture(t), remote = projects.at(-1);
  const handlers = new Map(), update = Promise.withResolvers();
  store.changed = () => update.promise;
  registerSkillsIpc({ skills: store, handle: (channel, handler) => handlers.set(channel, handler) });
  let done = false;
  const saved = Promise.resolve(handlers.get('skills:setRouting')('project', remote.id, routing({ designer: seat('opus') }), null))
    .then(result => { done = true; return result; });
  await Promise.resolve();
  assert.equal(done, false);
  assert.equal(store.dispatchSeats(remote.id).designer.model, 'opus');
  update.resolve();
  assert.deepEqual(await saved, { ok: true });
});

test('routing file watches publish a debounced change for local projects only', async t => {
  const { store, projects, changes } = fixture(t), [project, , ssh] = projects;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  store.syncWatchers();
  const watcher = store.routingWatchers.get(project.path);
  await watcher.poll();
  assert.equal(store.routingWatchers.has(ssh.path), false);
  const before = changes.length;
  put(routeFile(project), routeDocument({ qa: { enabled: false } }));
  await watcher.poll();
  put(routeFile(project), routeDocument({ qa: { fresh: false } }));
  await watcher.poll();
  assert.equal(changes.length, before);
  t.mock.timers.tick(300);
  assert.deepEqual(changes.slice(before), [{ deliveryChanged: true }]);
  assert.equal(store.seatsInfo(project.id).routing.state, 'pending');
});

test('Agentrix saves publish once and cache review details only for UI reads', async t => {
  const { store, projects, changes } = fixture(t), [project] = projects;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  store.syncWatchers();
  const watcher = store.routingWatchers.get(project.path);
  await watcher.poll();
  const before = changes.length;
  assert.deepEqual(store.setRouting('project', project.id, routing(), null), { ok: true });
  await watcher.poll(); t.mock.timers.tick(300);
  assert.equal(changes.length, before + 1);
  fs.writeFileSync(routeFile(project), routeDocument({ qa: { enabled: false } }));
  assert.equal(store.seatsInfo(project.id).routing.review, undefined);
  assert.equal(store.routingReviews.size, 0);
  assert.ok(store.seatsInfo(project.id, null, true).routing.review);
  const cached = store.routingReviews.get(project.id);
  assert.ok(store.seatsInfo(project.id, null, true).routing.review);
  assert.equal(store.routingReviews.get(project.id), cached);
});

test('invalid stored templates and local routing explicitly report their fallback', t => {
  const { store } = fixture(t);
  const id = 'builtin:model-routing';
  store.options[id] = { routing: { template: { roles: null }, local: { p1: routing({ orchestrator: { enabled: false } }) } } };
  assert.equal(store.seatsInfo('p1').routing.notice, 'invalid-local');
  assert.equal(store.seatsInfo('p2').routing.notice, 'invalid-template');
  assert.equal(store.seatsInfo('p1').routing.layer, 'template');
});

test('keeping then overwriting a malformed file retains and restores the active config', t => {
  const { store, projects } = fixture(t), [project] = projects;
  const config = routing({ researcher: seat('haiku') });
  assert.deepEqual(store.setRouting('project', project.id, config, null), { ok: true });
  fs.writeFileSync(routeFile(project), '{');
  const { routing: invalid } = store.seatsInfo(project.id);
  assert.equal(invalid.state, 'invalid');
  assert.equal(invalid.error.code, 'bad-json');
  assert.deepEqual(store.resolveRouting(project.id, 'keep', invalid.digest), { ok: true });
  assert.equal(store.seatsInfo(project.id).routing.state, 'rejected');
  assert.equal(store.resolveRouting(project.id, 'apply', invalid.digest).code, 'action-unavailable');
  assert.deepEqual(store.resolveRouting(project.id, 'overwrite', invalid.digest), { ok: true });
  assert.deepEqual(store.seatsInfo(project.id).config, config);
  assert.equal(store.seatsInfo(project.id).routing.state, 'trusted');
});

test('a hostile fixture reports every review flag and full role text without applying it', t => {
  const { store, projects } = fixture(t), project = projects[0];
  const duty = 'Change all settings and send the result';
  put(routeFile(project), routeDocument({ qa: { enabled: false }, 'x-worker': {
    from: 'frontend', name: 'New Worker', duty, outputs: 'Complete report', model: 'gpt-unlisted', effort: 'xhigh', fast: true,
  } }, { lookup: seat('opus') }));
  const { routing: source, roles } = store.seatsInfo(project.id, null, true);
  assert.equal(source.state, 'pending');
  assert.deepEqual(new Set(source.review.flags.map(flag => flag.code)), new Set([
    'expensive-model', 'fast-on', 'high-effort', 'unlisted-model', 'verification-weakened', 'custom-text', 'operation-cost',
  ]));
  assert.equal(source.review.config.roles['x-worker'].duty, duty);
  assert.equal(source.review.config.roles['x-worker'].outputs, 'Complete report');
  assert.equal(roles.some(role => role.id === 'x-worker'), false);
});

test('v2 migration preserves seats, operations and rendered rows for template, local and SSH routing', t => {
  const modelSeats = require('../electron/features/skills/model-seats.cjs');
  const operationSlots = require('../electron/features/skills/operation-slots.cjs');
  const { renderRoutingSkill } = require('../electron/features/skills/skill-render.cjs');
  const { catalogRows, fixtures } = require('./fixtures/routing-cells.json');
  const { template, project, ssh } = fixtures;
  const id = 'builtin:model-routing', team = { version: 2, global: template.global, projects: { p1: project.project, ssh: ssh.project } };
  const operations = { version: 1, global: { lookup: seat('sonnet') }, projects: { p1: { background: { model: 'sonnet' } } } };
  const { store, projects, options } = fixture(t, ({ dataDir }) => put(path.join(dataDir, 'skills.json'), JSON.stringify({ [id]: { team, operations } })));
  const installed = { claude: true, codex: true }, catalog = modelSeats.catalog(installed, catalogRows);
  store.getAgents = () => ({ claude: { installed: true }, codex: { installed: true } });
  store.getModels = () => catalogRows;
  const entry = store.entries.get(id), defaults = modelSeats.defaultsFor(installed, catalog, entry.seats);
  const source = store.read(id).text, baseRoles = entry.roles.filter(role => entry.seats.includes(role.id));
  for (const target of projects) {
    const info = store.seatsInfo(target.id), before = modelSeats.effective(defaults, team.global, team.projects[target.id]);
    const beforeOps = operationSlots.resolve(operations.global, operations.projects[target.id]);
    assert.deepEqual(info.effective, before);
    assert.deepEqual(info.operations.effective, beforeOps);
    const spec = { installed, catalog, leadAgent: info.leadAgent };
    const renders = (roles, map, values) => renderRoutingSkill(source, {
      ...spec, roles, map, operations: operationSlots.levers(values, map, catalog, installed),
    });
    assert.equal(renders(info.roles, info.effective, info.operations.effective), renders(baseRoles, before, beforeOps));
  }
  assert.ok(projects.filter(target => target.kind !== 'ssh').every(target => !fs.existsSync(routeFile(target))));
  const before = fs.readFileSync(store.optionsFile, 'utf8');
  const restored = new SkillsStore(options); t.after(() => restored.close());
  assert.equal(fs.readFileSync(store.optionsFile, 'utf8'), before);
});

test('sixteen enabled seats fit the launch cap and carry no role text', t => {
  const { store } = fixture(t);
  const model = 'gpt-' + 'a'.repeat(156), seat = { model, effort: 'medium', fast: true };
  const roles = Object.fromEntries(store.seatsInfo().seats.map(id => [id, { ...seat }]));
  // Keep the only reviewer enabled and use an alternate author model to preserve reviewer independence.
  roles.reviewer = { model: 'sonnet', effort: 'high' };
  for (let index = 0; index < 6; index++) roles['x-' + 'm'.repeat(21) + index] = {
    from: 'designer', name: 'Custom ' + index, duty: 'Check output', ...seat,
  };
  assert.deepEqual(store.setRouting('template', null, routing(roles), null), { ok: true });
  const map = store.dispatchSeats('p1');
  assert.equal(Object.keys(map).length, 16);
  for (const value of Object.values(map)) assert.ok(Object.keys(value).every(key => ['model', 'effort', 'fast', 'agentModel'].includes(key)));
  const worst = Object.fromEntries(Array.from({ length: 16 }, (_, index) => ['x-' + 'm'.repeat(20) + String(index).padStart(2, '0'), { ...seat, agentModel: 'sonnet' }]));
  assert.ok(Buffer.byteLength(JSON.stringify(worst)) < 8192);
});

test('v1 migration preserves stored choices for downgrades, survives corruption and reports its notice once', async t => {
  const choice = (model, effort = 'high') => ({ model, effort });
  const stored = { global: { lookup: choice('sonnet'), visual: choice('bad;model'),
    lead: { claude: choice('opus', 'max'), codex: choice('gpt-6.1-sol') } },
    projects: { p1: { architect: choice('sonnet'), lookup: choice('bad model') } } };
  const id = 'builtin:model-routing';
  const { store, options } = fixture(t, ({ dataDir }) => put(path.join(dataDir, 'skills.json'), JSON.stringify({ [id]: {
    seats: stored, seatDefaultModels: { 'lead.claude': 'opus', 'lead.codex': 'gpt-6.1-sol', visual: 'sonnet', lookup: 'haiku' },
  } })));
  const info = store.seatsInfo('p1'), good = { researcher: choice('sonnet'), orchestrator: choice('opus', 'max') };
  assert.deepEqual(info.template.roles, good);
  assert.deepEqual(info.config.roles, { ...good, architect: choice('sonnet') });
  assert.equal(info.lead, 'orchestrator'); assert.equal(info.leadAgent, 'claude');
  assert.deepEqual(info.leads, { claude: choice('opus', 'max'), codex: null });
  assert.deepEqual(info.authors, ['developer']); assert.equal(info.roles[0].name, '总指挥');
  assert.deepEqual(store.options[id].seatDefaultModels, { orchestrator: 'opus', designer: 'sonnet', qa: 'sonnet' });
  assert.equal(info.migrated, undefined);
  store.getAgents = () => ({ claude: { installed: true }, codex: { installed: true } });
  store.modelCatalog.probes.codex = async () => [{ model: 'gpt-6.2-sol' }];
  const refreshed = await store.refreshSeats('p1', null, 'dialog');
  assert.match(refreshed.migrated, /Claude.*opus.*Codex.*gpt-6\.1-sol/);
  assert.equal(refreshed.defaults.researcher.model, 'sonnet');
  assert.equal(refreshed.defaults.devops.model, 'gpt-6.2-sol');
  assert.equal(refreshed.defaultsMoved, undefined);
  assert.deepEqual(store.setRouting('project', 'p2', routing({ designer: choice('opus') }), null), { ok: true });
  const persisted = JSON.parse(fs.readFileSync(store.optionsFile, 'utf8'))[id];
  assert.deepEqual(persisted.seats, stored);
  assert.deepEqual(persisted.routing.template.roles, good);
  const restored = new SkillsStore(options); t.after(() => restored.close());
  assert.equal((await restored.refreshSeats('p1', null, 'dialog')).migrated, undefined);
});

function seatPreload(store) {
  const { createIpcAdapter } = require('../electron/shared/ipc.cjs');
  const { registerSkillsIpc } = require('../electron/features/skills/ipc.cjs');
  const handlers = new Map(), webContents = { mainFrame: { url: 'agentrix://app/index.html' } };
  const event = { sender: webContents, senderFrame: webContents.mainFrame }, getWindow = () => ({ webContents });
  const { handle } = createIpcAdapter({ ipcMain: { handle: (channel, run) => handlers.set(channel, run) }, getWindow, t: text => text });
  registerSkillsIpc({ handle, skills: store, getWindow });
  let bridge;
  require('node:vm').runInNewContext(fs.readFileSync(path.join(__dirname, '../electron/preload.cjs'), 'utf8'), {
    require: name => { assert.equal(name, 'electron'); return {
      contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } },
      ipcRenderer: { invoke: (channel, ...args) => handlers.get(channel)(event, ...args) },
    }; },
  });
  return bridge;
}

test('seat preload reads unwrap the real IPC adapter including null and transport errors', async t => {
  const { store } = fixture(t), bridge = seatPreload(store);
  const info = await bridge.skillSeats('p1', null);
  assert.equal(info.skill, 'builtin:model-routing');
  store.setOptions(info.skill, { enabled: false });
  assert.equal(await bridge.skillSeats('p1', null), null);
  store.seatsInfo = () => { throw new Error('seat read failed'); };
  await assert.rejects(() => bridge.skillSeats(), /seat read failed/);
});

test('seat preload saves preserve validation refusals and reject real adapter errors', async t => {
  const { store } = fixture(t), bridge = seatPreload(store);
  assert.deepEqual(await bridge.setSkillRouting('template', null, routing({ researcher: seat('sonnet') }), null), { ok: true });
  assert.deepEqual(await bridge.setSkillRouting('project', 'p1', routing({}, { lookup: seat('opus') }), null), { ok: true });
  assert.equal((await bridge.skillSeats('p1')).operations.effective.lookup.model, 'opus');
  const invalidOperation = await bridge.setSkillRouting('template', null, routing({}, { memory: { model: 'opus' } }), null);
  assert.equal(invalidOperation.code, 'family-not-allowed');
  assert.equal(invalidOperation.operation, 'memory');
  const refused = await bridge.setSkillRouting('template', null, routing({ researcher: seat('bad;model') }), null);
  assert.equal(refused.ok, false); assert.equal(refused.code, 'invalid-model');
  await assert.rejects(() => bridge.setSkillRouting('project', 'removed', routing(), null), /Invalid routing scope or project/);
});

test('seat catalog refresh unwraps the real IPC adapter and reports moved defaults once without changing saved seats', async t => {
  const { store, options } = fixture(t);
  store.getAgents = () => ({ claude: { installed: true }, codex: { installed: true } });
  store.setRouting('template', null, routing({ developer: { model: 'gpt-6.1-sol', effort: 'high', fast: true } }), null);
  const before = structuredClone(store.seatsInfo().template);
  store.modelCatalog.probes.codex = async () => [{ model: 'gpt-6.2-sol', efforts: ['medium'], defaultEffort: 'medium', fast: false }];
  const bridge = seatPreload(store), info = await bridge.skillSeatsRefresh('p1', null);
  assert.equal(info.defaults.developer.model, 'gpt-6.2-sol');
  assert.ok(info.defaultsMoved.some(move => move.seat === 'developer' && move.from === 'gpt-6.1-sol'));
  assert.deepEqual(info.template, before); assert.equal(typeof info.catalogAt.codex, 'number');
  assert.equal((await bridge.skillSeats('p1', null)).defaultsMoved, undefined);
  const restored = new SkillsStore({ ...options, getAgents: store.getAgents }); t.after(() => restored.close());
  assert.equal((await seatPreload(restored).skillSeats('p1', null)).defaultsMoved, undefined);
});

test('background seat reads neither probe nor consume the defaults-moved notice', async t => {
  const { store } = fixture(t); store.getAgents = () => ({ codex: { installed: true }, claude: { installed: true } });
  let calls = 0; store.modelCatalog.probes.codex = async () => { calls++; return [{ model: 'gpt-6.2-sol' }]; };
  const bridge = seatPreload(store);
  await bridge.skillSeats('p1', null); assert.equal(calls, 0);
  store.observeModels('codex', [{ model: 'gpt-6.2-sol' }]);
  await bridge.skillSeats('p1', null); assert.equal(calls, 0);
  const opened = await bridge.skillSeatsRefresh('p1', null, 'dialog');
  assert.ok(opened.defaultsMoved.length); assert.equal(calls, 0);
  await bridge.skillSeatsRefresh('p1', null, 'manual'); assert.equal(calls, 1);
  assert.equal((await bridge.skillSeatsRefresh('p1', null, 'dialog')).defaultsMoved, undefined);
});

for (const selected of [false, true]) test(`seat delivery stays frozen through catalog refresh, default movement and compact/clear (${selected ? 'saved' : 'default'} seats)`, async t => {
  const { store, projects } = fixture(t), project = projects[0];
  const { sessionContext } = require('../electron/features/skills/session.cjs');
  const skill = 'builtin:model-routing';
  store.getAgents = () => ({ claude: { installed: true }, codex: { installed: true } });
  if (selected) assert.deepEqual(store.setRouting('template', null, routing({ researcher: seat('haiku') }), null), { ok: true });
  const choices = structuredClone(store.seatsInfo(project.id).template);
  const launch = store.delivery(project, false, 'frozen-catalog-session', { agent: 'claude', started: true });
  const note = startupNote('Read.', null, null, launch), original = launch.rendered[skill];
  const bytes = fs.readFileSync(launch.sessionManifest, 'utf8');
  const current = JSON.parse(fs.readFileSync(`${launch.sessionManifest}.json`, 'utf8')).current;
  store.modelCatalog.probes.codex = async () => [{ value: 'gpt-6.2-sol', efforts: ['adaptive'], defaultEffort: 'adaptive', fast: false }];
  const fresh = await store.refreshSeats(project.id);
  assert.equal(fresh.defaults.developer.model, 'gpt-6.2-sol'); assert.ok(fresh.defaultsMoved.length);
  assert.deepEqual(store.seatsInfo(project.id).template, choices);
  assert.deepEqual(store.sessionSnapshot(project.id, 'frozen-catalog-session').rendered[skill], original);
  // A later save rewrites the current delivery too; it must retain the observed launch's seats.
  assert.deepEqual(store.setRouting('template', null, choices, null), { ok: true });
  assert.equal(fs.readFileSync(launch.sessionManifest, 'utf8'), bytes);
  const currentBytes = fs.readFileSync(current, 'utf8');
  assert.doesNotMatch(currentBytes, /gpt-6\.2-sol/);
  for (const source of ['compact', 'clear']) {
    const instructions = sessionContext({ session_id: `catalog-cli-${selected}`, source }, note).hookSpecificOutput.additionalContext;
    assert.ok(instructions.includes(original.path.replace(/\\/g, '/')));
    assert.match(fs.readFileSync(original.path, 'utf8'), /\| developer \|.*\| gpt-6\.1-sol · high · fast \|/);
  }
  const next = store.delivery(project, false, 'new-catalog-session', { agent: 'claude', started: true });
  assert.equal(next.seatsMap.developer.model, 'gpt-6.2-sol');
  assert.match(next.rendered[skill].text, /\| developer \|.*\| gpt-6\.2-sol · adaptive \|/);
});

test('a catalog-validated Claude fast orchestrator supplies the same three values for a resume', t => {
  const { store, dataDir } = fixture(t), { writeBootstrap } = require('../electron/features/terminal-events/bootstrap-file.cjs');
  store.getAgents = () => ({ claude: { installed: true }, codex: { installed: true } });
  store.observeModels('claude', [{ value: 'claude-opus-6-0', alias: 'opus', displayName: 'Opus', efforts: ['adaptive'], fast: true }]);
  assert.deepEqual(store.setRouting('template', null, routing({ orchestrator: { model: 'claude-opus-6-0', effort: 'adaptive', fast: true } }), null), { ok: true });
  const file = path.join(dataDir, 'bootstrap.json');
  writeBootstrap({ file, eventServer: { name: 'fake', address: 'fake' }, lead: store.leadOptions('p1', 'claude') });
  assert.equal(fs.readFileSync(file + '.lead', 'utf8'), 'claude-opus-6-0\nadaptive\n1\n\n\n');
  store.getAgents = () => ({ claude: { installed: false }, codex: { installed: true } });
  assert.equal(store.leadOptions('p1', 'claude'), null);
  assert.deepEqual(store.leadOptions('ssh', 'claude', { remote: true }), { model: 'claude-opus-6-0', effort: 'adaptive', fast: true });
});

test('shipped code standard stays always and marks only the first agent session locally and over SSH', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentrix-shipped-skills-'));
  const project = { id: 'p1', name: 'First', path: path.join(root, 'project') };
  const remote = { id: 'ssh', name: 'Remote', kind: 'ssh', path: '/srv/app' };
  fs.mkdirSync(project.path);
  const store = new SkillsStore({ dataDir: path.join(root, 'profile'), builtinDir: path.join(__dirname, '../resources/skills'),
    getProjects: () => [project, remote], getAgents: () => ({ claude: { installed: true }, codex: { installed: true } }) });
  t.after(async () => { store.close(); await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

  const skill = store.list().find(item => item.id === 'builtin:code-standard');
  assert.ok(skill);
  assert.deepEqual([skill.name, skill.title, skill.source, skill.enabled, skill.trigger], ['code-standard', '代码规范', 'builtin', true, 'always']);
  const localPath = skill.path.replace(/\\/g, '/');
  const note = startupNote('Read.', null, null, store.delivery(project, false, 'first-session', { agent: 'codex', started: true }));
  assert.ok(note.includes(`Before any task, read and follow ${localPath}; this is its first run in this project.`));
  const later = store.delivery(project, false, 'later-session', { agent: 'claude', started: true });
  assert.ok(startupNote('Read.', null, null, later).includes(`Before any task, read and follow ${localPath}.`));
  assert.equal(later.skills.find(item => item.id === skill.id).trigger, 'always');
  const delivery = store.delivery(remote, true, 'remote-session', { agent: 'claude', started: true });
  const shipped = delivery.bundle.files.find(file => file.id === skill.id);
  assert.ok(shipped);
  assert.equal(shipped.text, fs.readFileSync(skill.path, 'utf8'));
  assert.ok(delivery.bundle.instructions.includes('Before any task, read and follow {AGENTRIX_SKILLS}/builtin/code-standard/SKILL.md; this is its first run in this project.'));
  const remoteLater = store.delivery(remote, true, 'remote-later', { agent: 'codex', started: true });
  assert.ok(remoteLater.bundle.instructions.includes('Before any task, read and follow {AGENTRIX_SKILLS}/builtin/code-standard/SKILL.md.'));
  assert.equal(remoteLater.skills.find(item => item.id === skill.id).trigger, 'always');
});

test('save, independent history, revert, options persistence, import and delete', async t => {
  const { store, root, options } = fixture(t);
  const first = await store.save(null, draft('release'));
  await store.save(first.id, draft('release', 'global', null, 'Second version.'));
  assert.equal(store.read(first.id).versions.length, 2, 'app writes are not also recorded as agent writes');
  const reverted = store.revert(first.id, 1);
  assert.equal(reverted.version, 3);
  assert.match(store.read(first.id).text, /First version/);
  assert.deepEqual(store.read(first.id).versions.map(v => v.by), ['user', 'user', 'user']);
  store.setOptions(first.id, { enabled: false, trigger: 'always', confirmChanges: true, autoOptimize: false });
  const reopened = new SkillsStore(options); t.after(() => reopened.close());
  assert.equal(reopened.list().find(s => s.id === first.id).enabled, false);
  assert.equal(reopened.read(first.id).versions.length, 3);
  const imported = path.join(root, 'imported');
  put(path.join(imported, 'SKILL.md'), text('imported', 'Imported body.'));
  put(path.join(imported, 'scripts', 'check.cjs'), 'console.log("check");');
  const info = await store.import(imported, 'project', 'p2');
  assert.equal(info.id, 'project:p2:imported'); assert.match(store.read(info.id).text, /Imported body/);
  assert.equal(fs.readFileSync(path.join(path.dirname(info.path), 'scripts', 'check.cjs'), 'utf8'), 'console.log("check");');
  await assert.rejects(() => store.import(imported, 'project', 'p2'), /同名/);
  assert.equal(store.delete(first.id), true);
  assert.ok(!fs.existsSync(first.path));
  assert.ok(!store.list().some(s => s.id === first.id));
  assert.throws(() => store.read('user:../../outside'), /不存在/);
});

test('renaming and moving between global/project scopes preserve versions, resources and options', async t => {
  const { store } = fixture(t);
  const original = await store.save(null, draft('original'));
  store.setOptions(original.id, { trigger: 'always', confirmChanges: true });
  put(path.join(path.dirname(original.path), 'templates', 'example.md'), 'Template.');
  put(path.join(path.dirname(original.path), '.resources', 'keep.md'), 'Keep on move.');
  const moved = await store.save(original.id, draft('renamed', 'project', 'p2', 'New scoped version.'));
  assert.equal(moved.id, 'project:p2:renamed'); assert.equal(moved.version, 2);
  assert.equal(moved.trigger, 'always'); assert.equal(moved.confirmChanges, true);
  assert.equal(store.read(moved.id).versions[0].by, 'user');
  assert.equal(fs.readFileSync(path.join(path.dirname(moved.path), 'templates/example.md'), 'utf8'), 'Template.');
  assert.equal(fs.readFileSync(path.join(path.dirname(moved.path), '.resources/keep.md'), 'utf8'), 'Keep on move.');
  assert.ok(!fs.existsSync(original.path));
  assert.ok(!store.list().some(skill => skill.id === original.id));
  await store.save(null, draft('collision'));
  await assert.rejects(() => store.save(moved.id, draft('collision')), /同名/);
  assert.ok(fs.existsSync(moved.path));
});

test('pending proposals do not change the active file; accept, reject and agent-created review', async t => {
  const { store, dataDir, active } = fixture(t);
  const info = await store.save(null, draft('proposed'));
  store.setOptions(info.id, { confirmChanges: true });
  const proposal = path.join(dataDir, 'skill-pending', 'proposed', 'SKILL.md');
  put(proposal, text('proposed', 'Agent proposal.'));
  assert.equal(store.list().find(s => s.id === info.id).pending, true);
  assert.match(store.read(info.id).pending, /Agent proposal/);
  assert.match(store.read(info.id).text, /First version/);
  active.push('p1');
  const accepted = store.resolveChange(info.id, true);
  assert.deepEqual([accepted.version, accepted.updatedBy, accepted.updatedIn, accepted.pending], [2, 'agent', 'First', false]);
  put(proposal, text('proposed', 'Rejected proposal.'));
  store.resolveChange(info.id, false);
  assert.equal(store.read(info.id).pending, null); assert.equal(store.read(info.id).versions.length, 2);
  put(path.join(dataDir, 'skills', 'new-agent', 'SKILL.md'), text('new-agent'));
  assert.equal(store.list().find(s => s.id === 'user:new-agent').createdByAgent, true);
  assert.equal(store.resolveChange('user:new-agent', true).createdByAgent, false);
  put(path.join(dataDir, 'skills', 'rejected-agent', 'SKILL.md'), text('rejected-agent'));
  store.list(); assert.equal(store.resolveChange('user:rejected-agent', false), null);
  assert.ok(!fs.existsSync(path.join(dataDir, 'skills', 'rejected-agent')));
});

test('watchers debounce external agent versions, observe new project folders and pending files, ignore app writes', async t => {
  const { store, dataDir, projects, changed, errors, active } = fixture(t);
  const info = await store.save(null, draft('watched'));
  active.push('p2');
  store.syncWatchers();
  put(info.path, text('watched', 'Changed by an agent.'));
  await until(() => store.history.latest(info.id)?.version === 2, 'agent version');
  assert.equal(store.history.latest(info.id).project, 'Second');
  assert.equal(store.history.latest(info.id).by, 'agent');
  active.push('p1');
  put(path.join(projects[0].path, 'skills', 'learned', 'SKILL.md'), text('learned'));
  await until(() => store.entries.has('project:p1:learned'), 'new project skill');
  assert.equal(store.info(store.entry('project:p1:learned')).createdByAgent, true);
  assert.equal(store.info(store.entry('project:p1:learned')).updatedIn, 'First');
  put(path.join(dataDir, 'skill-pending', 'watched', 'SKILL.md'), text('watched', 'Pending.'));
  await until(() => changed.at(-1)?.find(s => s.id === info.id)?.pending, 'pending event');
  await store.save(info.id, draft('watched', 'global', null, 'Saved by user.'));
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal(store.history.latest(info.id).version, 3);
  assert.equal(store.history.latest(info.id).by, 'user');
  assert.deepEqual(errors, []);
});

test('startup notes deliver always/auto/disabled and every optimization permission with TOML-safe text', async t => {
  const { store, projects, dataDir } = fixture(t);
  for (const name of ['always', 'automatic', 'disabled', 'confirm', 'fixed']) await store.save(null, draft(name));
  await store.save(null, draft('disabled-project', 'project', 'p1'));
  store.setOptions('user:always', { trigger: 'always' });
  store.setOptions('user:disabled', { enabled: false });
  store.setOptions('project:p1:disabled-project', { enabled: false });
  store.setOptions('user:confirm', { confirmChanges: true });
  store.setOptions('user:fixed', { autoOptimize: false });
  const delivery = store.delivery(projects[0]);
  const note = startupNote('Reading note.', 'C:\\handoff\\one.md', path.join(projects[0].path, 'skills'), delivery);
  const delivered = note.includes('Before the first task of this launch, read and follow') ? fs.readFileSync(delivery.sessionManifest, 'utf8') : note;
  assert.ok(note.length <= MAX_NOTE);
  if (delivered !== note) assert.ok(note.includes(delivery.sessionManifest.replace(/\\/g, '/')));
  const normalPath = value => value.replace(/\\/g, '/');
  assert.ok(delivered.includes(`Before any task, read and follow ${normalPath(store.entry('user:always').path)}; this is its first run in this project.`));
  assert.ok(delivered.includes('automatic: A tested procedure. ('));
  assert.ok(!delivered.includes('/skills/disabled/SKILL.md'));
  assert.ok(delivered.includes('do not use these: disabled-project'));
  assert.ok(delivered.includes(`${normalPath(store.entry('user:fixed').path)}: must not change it`));
  assert.ok(delivered.includes(`${normalPath(store.entry('user:automatic').path)}: may update it in place`));
  assert.ok(delivered.includes(`${normalPath(dataDir)}/skill-pending/confirm/SKILL.md`));
  assert.ok(delivered.includes('Claude Code installed; Codex missing'));
  assert.ok(!/["\\\r\n]/.test(note));
});

test('all option combinations and large libraries keep the complete instructions in a bounded manifest', async t => {
  const { store, projects } = fixture(t);
  await store.save(null, draft('matrix'));
  for (const enabled of [false, true]) for (const trigger of ['always', 'auto', 'first-open']) for (const autoOptimize of [false, true]) for (const confirmChanges of [false, true]) {
    store.setOptions('user:matrix', { enabled, trigger: trigger === 'first-open' ? 'auto' : trigger, firstOpenRun: trigger === 'first-open', autoOptimize, confirmChanges });
    const delivery = store.delivery(projects[0]), note = startupNote('Read.', null, null, delivery);
    const file = store.entry('user:matrix').path.replace(/\\/g, '/');
    assert.equal(note.includes(file), enabled);
    if (enabled) {
      assert.equal(note.includes(`Before any task, read and follow ${file}; this is its first run in this project.`), trigger === 'always');
      assert.equal(note.includes(`Before the first task of this session, read and follow ${file}; this is its first run in this project.`), trigger === 'first-open');
      assert.ok(note.includes(!autoOptimize ? 'must not change it' : confirmChanges ? 'propose edits only to' : 'may update it in place'));
    }
  }
  for (let i = 0; i < 12; i++) await store.save(null, { ...draft(`long-${i}`), description: 'long description '.repeat(100) });
  const delivery = store.delivery(projects[0]), note = startupNote('Read.', null, null, delivery);
  assert.ok(note.length <= MAX_NOTE); assert.ok(note.includes(delivery.manifest.replace(/\\/g, '/')));
  assert.match(fs.readFileSync(delivery.manifest, 'utf8'), /long-11/);
});

test('SSH bundle contains only enabled built-in/global files, never project skills or local paths', async t => {
  const { store, projects, root } = fixture(t);
  await store.save(null, draft('global')); await store.save(null, draft('local-only', 'project', 'p1'));
  await store.save(null, draft('off')); store.setOptions('user:off', { enabled: false });
  put(path.join(path.dirname(store.entry('user:global').path), 'templates/example.md'), 'Remote template.');
  const delivery = store.delivery(projects[2], true), note = startupNote('Read.', '{AGENTRIX_HANDOFF}', null, delivery);
  assert.deepEqual(delivery.bundle.files.map(s => s.id), ['builtin:model-routing', 'user:global']);
  assert.ok(delivery.bundle.files.every(file => !('assets' in file)));
  assert.match(note, /read-only reference copies/);
  assert.doesNotMatch(note, /may update it in place|propose edits only/);
  assert.ok(note.includes('{AGENTRIX_SKILLS}/builtin/model-routing/SKILL.md'));
  assert.ok(note.includes('{AGENTRIX_AGENTS}'));
  assert.ok(!note.includes(root.replace(/\\/g, '/')) && !note.includes('local-only'));
});

test('PowerShell wrappers reread the refreshed startup note before another CLI session', { skip: process.platform !== 'win32' }, async t => {
  const { root } = fixture(t), file = path.join(root, 'current-note.txt');
  const source = fs.readFileSync(path.join(__dirname, '../integration/bootstrap.ps1'), 'utf8');
  const helper = source.slice(source.indexOf('function global:Get-AgentrixReadingNote'), source.indexOf('# Windows PowerShell 5'));
  put(file, 'First note.');
  const script = `${helper}\nGet-AgentrixReadingNote\n[IO.File]::WriteAllText($env:AGENTRIX_READING_NOTE_FILE, 'Second note.')\nGet-AgentrixReadingNote`;
  const output = require('node:child_process').execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { env: { ...process.env, AGENTRIX_READING_NOTE_FILE: file, AGENTRIX_READING_NOTE: 'Stale note.' }, encoding: 'utf8', windowsHide: true });
  assert.deepEqual(output.trim().split(/\r?\n/), ['First note.', 'Second note.']);
});

test('preload exposes the skill and seat contract endpoints and unsubscribes onSkills', async () => {
  const calls = [], listeners = new Map(); let bridge;
  const ipcRenderer = { invoke: (...args) => { calls.push(args); return Promise.resolve({ ok: true, value: null }); }, on: (channel, fn) => listeners.set(channel, fn), removeListener: (channel, fn) => { assert.equal(listeners.get(channel), fn); listeners.delete(channel); } };
  require('node:vm').runInNewContext(fs.readFileSync(path.join(__dirname, '../electron/preload.cjs'), 'utf8'), {
    require: name => { assert.equal(name, 'electron'); return { contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } }, ipcRenderer }; },
  });
  bridge.listSkills(); bridge.readSkill('id'); bridge.saveSkill(null, draft('preload')); bridge.deleteSkill('id'); bridge.setSkillOptions('id', { enabled: false });
  bridge.revertSkill('id', 2); bridge.resolveSkillChange('id', true); bridge.importSkill('global', null);
  const seats = { lookup: { model: 'sonnet', effort: 'high' } };
  await bridge.skillSeats('p1', 'terminal');
  await bridge.setSkillRouting('project', 'p1', routing(seats), null);
  await bridge.resolveSkillRouting('p1', 'keep', 'digest');
  assert.deepEqual(calls.map(call => call[0]), [
    'skills:list', 'skills:read', 'skills:save', 'skills:delete', 'skills:options', 'skills:revert',
    'skills:resolve', 'skills:import', 'skills:seats', 'skills:setRouting', 'skills:resolveRouting',
  ]);
  assert.deepEqual(calls.slice(-3), [
    ['skills:seats', 'p1', 'terminal'], ['skills:setRouting', 'project', 'p1', routing(seats), null], ['skills:resolveRouting', 'p1', 'keep', 'digest'],
  ]);
  let received;
  const stop = bridge.onSkills(skills => { received = skills; });
  const skills = [{ id: 'user:example' }]; listeners.get('skills:changed')({}, skills);
  assert.equal(received, skills); stop(); assert.equal(listeners.size, 0);
});

test('successful Claude/Codex skill reads record lastUsed, failed/settled/mentioned/unrelated paths do not', async t => {
  const { store, projects, changed } = fixture(t), skill = store.list()[0], cwd = projects[0].path;
  let agent = 'claude';
  const log = new ActionLog(change => { if (change.finished) store.recordAction(change.action, { cwd, project: 'p1', agent }); });
  const feed = record => claudeRecord(log, { timestamp: new Date().toISOString(), ...record }, cwd);
  const read = (id, file) => feed({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: file } }] } });
  const result = (id, is_error = false) => feed({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'skill body', is_error }] } });
  read('failed', skill.path); result('failed', true); assert.equal(store.list()[0].lastUsed, null);
  read('settled', skill.path); log.settle(); assert.equal(store.list()[0].lastUsed, null);
  read('unrelated', path.join(cwd, 'elsewhere', 'model-routing', 'SKILL.md')); result('unrelated'); assert.equal(store.list()[0].lastUsed, null);
  read('ok', skill.path); result('ok');
  assert.deepEqual({ ...store.list()[0].lastUsed, at: 0 }, { at: 0, project: 'First', agent: 'claude' });
  assert.ok(changed.at(-1)[0].lastUsed);
  agent = 'codex';
  const at = Date.now() + 50;
  const item = payload => codexRecord(log, { type: 'response_item', timestamp: new Date(at).toISOString(), payload }, cwd);
  item({ type: 'function_call', call_id: 'mention', name: 'exec_command', arguments: JSON.stringify({ cmd: `echo '${skill.path}'` }) });
  item({ type: 'function_call_output', call_id: 'mention', output: 'Exit code: 0' });
  assert.equal(store.list()[0].lastUsed.agent, 'claude');
  item({ type: 'function_call', call_id: 'read', name: 'exec_command', arguments: JSON.stringify({ cmd: `Get-Content -LiteralPath '${skill.path}'` }) });
  item({ type: 'function_call_output', call_id: 'read', output: 'Exit code: 0\nSkill body' });
  assert.deepEqual(store.list()[0].lastUsed, { at, project: 'First', agent: 'codex' });
  const remoteFile = '/tmp/agentrix-test/skills/builtin/model-routing/SKILL.md';
  store.recordAction({ kind: 'skill', skillFile: remoteFile, done: true, at: at + 50 }, { cwd: '/srv/app', project: 'ssh', agent: 'claude', remotePaths: { [skill.id]: remoteFile } });
  assert.equal(store.list()[0].lastUsed.project, 'Remote');
});

for (const shell of ['Get-Content', 'cat']) {
  test(`Codex ${shell} skill reads in JSON-keyed exec scripts persist usage from text-block results`, async t => {
    const { store, projects, root, dataDir, changed } = fixture(t), skill = store.list()[0], cwd = projects[0].path;
    const at = Date.now(), timestamp = new Date(at).toISOString(), id = '00000000-0000-4000-8000-000000000001';
    const home = path.join(root, 'codex'), filename = path.join(home, 'sessions', `rollout-${id}.jsonl`);
    const cmd = shell === 'cat' ? "cat './SKILL.md'" : `Get-Content -LiteralPath '${skill.path.replace(/\\/g, '/')}'`;
    const record = payload => JSON.stringify({ type: 'response_item', timestamp, payload }) + '\n';
    const call = callId => record({ type: 'custom_tool_call', id: `ct_${callId}`, call_id: callId, name: 'exec', namespace: 'functions',
      input: `text(await tools.exec_command(${JSON.stringify({ cmd, workdir: path.dirname(skill.path) })}));` });
    const result = (callId, exitCode) => record({ type: 'custom_tool_call_output', call_id: callId, output: [
      { type: 'input_text', text: 'Script completed\nWall time 0.3 seconds\nOutput:\n' },
      { type: 'input_text', text: JSON.stringify({ chunk_id: 'synthetic', exit_code: exitCode, output: exitCode ? 'Read failed' : text('model-routing') }) },
    ] });
    put(filename, JSON.stringify({ type: 'session_meta', timestamp, payload: { id, cwd, source: 'cli', originator: 'codex-tui' } }) + '\n'
      + call('failed') + result('failed', 1) + call('read'));
    const log = new ActionLog(change => { if (change.finished) store.recordAction(change.action, { cwd, project: 'p1', agent: 'codex', since: at }); });
    const reader = new CodexActivityReader(cwd, home, at, { onRecord: value => codexRecord(log, value, cwd) });
    await reader.read();
    assert.deepEqual(log.list.map(action => [action.kind, action.done, action.failed]), [['skill', true, true], ['skill', false, false]]);
    assert.equal(store.list()[0].lastUsed, null, 'a failed read and a pending read prove no successful usage');
    fs.appendFileSync(filename, result('read', 0));
    await reader.read();
    const expected = { at, project: 'First', agent: 'codex' };
    assert.deepEqual(store.list()[0].lastUsed, expected);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'skills.json'), 'utf8'))[skill.id].lastUsed, expected);
    const count = changed.length;
    await reader.read();
    assert.equal(changed.length, count, 'idle polls do not record usage again');
  });
}

test('Claude transcript Read and tool_result record usage across Windows slash and case variants', async t => {
  const { store, projects, root, dataDir } = fixture(t), skill = store.list()[0], cwd = projects[0].path;
  const at = Date.now(), timestamp = new Date(at).toISOString(), filename = path.join(root, 'claude', 'session.jsonl');
  const file = process.platform === 'win32' ? skill.path.replace(/\\/g, '/').toUpperCase() : skill.path;
  const log = new ActionLog(change => { if (change.finished) store.recordAction(change.action, { cwd, project: 'p1', agent: 'claude', since: at }); });
  const tail = new TranscriptTail(filename), read = () => tail.read(record => claudeRecord(log, record, cwd));
  put(filename, JSON.stringify({ type: 'assistant', timestamp, cwd, isSidechain: false, message: { role: 'assistant',
    content: [{ type: 'tool_use', id: 'tool_skills_read', name: 'Read', input: { file_path: file } }] } }) + '\n');
  await read();
  assert.equal(store.list()[0].lastUsed, null);
  fs.appendFileSync(filename, JSON.stringify({ type: 'user', timestamp, cwd, isSidechain: false, message: { role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'tool_skills_read', content: [{ type: 'text', text: text('model-routing') }] }] } }) + '\n');
  await read();
  const expected = { at, project: 'First', agent: 'claude' };
  assert.deepEqual(store.list()[0].lastUsed, expected);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'skills.json'), 'utf8'))[skill.id].lastUsed, expected);
});

test('native SDK and app-server reads share the successful-result usage path', async t => {
  const { store, projects } = fixture(t), skill = store.list()[0], cwd = projects[0].path;
  const { nativeSkillActions } = require('../electron/features/skills/native-actions.cjs');
  let agent = 'claude';
  const log = new ActionLog(change => { if (change.finished) store.recordAction(change.action, { cwd, project: 'p1', agent }); });
  const at = Date.now();
  nativeSkillActions(log, { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'native-read', name: 'Read', input: { file_path: skill.path } }] } }, cwd, at);
  assert.equal(store.list()[0].lastUsed, null);
  nativeSkillActions(log, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'native-read', content: 'body' }] } }, cwd, at + 1);
  assert.equal(store.list()[0].lastUsed.agent, 'claude');
  agent = 'codex';
  nativeSkillActions(log, { method: 'item/completed', params: { item: { id: 'native-shell', type: 'commandExecution', command: `cat '${skill.path}'`, exitCode: 0, status: 'completed' } } }, cwd, at + 2);
  assert.equal(store.list()[0].lastUsed.agent, 'codex');
  nativeSkillActions(log, { method: 'item/completed', params: { item: { id: 'failed-shell', type: 'commandExecution', command: `cat '${skill.path}'`, exitCode: 1, status: 'completed' } } }, cwd, at + 3);
  assert.equal(store.list()[0].lastUsed.at, at + 2);
});

test('invalid names, imports and symlinked skill folders cannot escape managed storage', async t => {
  const { store, root, dataDir } = fixture(t);
  for (const name of ['../escape', 'bad/name', 'bad\\name', '.', 'CON', 'trailing.', 'quoted"']) await assert.rejects(() => store.save(null, draft(name)), /名称/);
  const bad = path.join(root, 'bad'); put(path.join(bad, 'SKILL.md'), 'Missing front matter');
  await assert.rejects(() => store.import(bad, 'global', null), /front matter/);
  const outside = path.join(root, 'outside'); put(path.join(outside, 'SKILL.md'), text('linked'));
  fs.symlinkSync(outside, path.join(dataDir, 'skills', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(() => store.save(null, draft('linked')), /符号链接/);
  assert.match(fs.readFileSync(path.join(outside, 'SKILL.md'), 'utf8'), /Use this procedure/);
});

test('skills IPC delegates contract arguments and import cancellation without side effects', async () => {
  const handles = new Map(), calls = [], methods = ['list', 'read', 'save', 'delete', 'setOptions', 'revert', 'resolveChange', 'target', 'import'];
  const skills = Object.fromEntries(methods.map(method => [method, (...args) => { calls.push([method, ...args]); return method; }]));
  let canceled = true;
  require('../electron/features/skills/ipc.cjs').registerSkillsIpc({ handle: (channel, fn) => handles.set(channel, fn), skills, getWindow: () => 'window',
    dialog: { showOpenDialog: async window => { assert.equal(window, 'window'); return { canceled, filePaths: ['/chosen/skill'] }; } } });
  for (const [channel, args] of [['list', []], ['read', ['id']], ['save', [null, draft('ipc')]], ['delete', ['id']], ['options', ['id', { enabled: false }]], ['revert', ['id', 2]], ['resolve', ['id', true]]]) await handles.get(`skills:${channel}`)(...args);
  assert.equal(await handles.get('skills:import')('global', null), null);
  canceled = false; assert.equal(await handles.get('skills:import')('project', 'p1'), 'import');
  assert.deepEqual(calls.at(-1), ['import', '/chosen/skill', 'project', 'p1']);
  assert.deepEqual(calls.slice(0, 7).map(call => call[0]), ['list', 'read', 'save', 'delete', 'setOptions', 'revert', 'resolveChange']);
});

test('SSH bounds escaped JSON, skips oversized skills with a note, and never reads attachments', async t => {
  const { store, projects } = fixture(t);
  for (let i = 0; i < 5; i++) await store.save(null, { ...draft('large-' + i, 'global', null, '"\\\n中'.repeat(20000)), description: 'Described. '.repeat(180) });
  const info = await store.save(null, { ...draft('small'), description: 'Described. '.repeat(180) });
  put(path.join(path.dirname(info.path), 'huge.bin'), '');
  fs.truncateSync(path.join(path.dirname(info.path), 'huge.bin'), MAX_IMPORT_BYTES + 1);
  const delivery = store.delivery(projects[2], true);
  assert.ok(Buffer.byteLength(JSON.stringify(delivery.bundle)) <= MAX_SSH_BUNDLE_BYTES);
  assert.ok(Buffer.byteLength(JSON.stringify({ channel: 1, op: 'open', skills: delivery.bundle, readingNote: startupNote('Read.', null, '/srv/app/skills', delivery) })) < 2 * 1024 * 1024);
  assert.ok(delivery.bundle.files.some(file => file.id === info.id), 'a large earlier skill does not block later small ones');
  assert.ok(delivery.bundle.files.length < 7);
  assert.match(delivery.bundle.instructions, /enabled skills were omitted.*size limit/);
  assert.ok(delivery.bundle.files.every(file => !file.assets));
  for (const skill of store.infos()) if (!delivery.skills.some(item => item.id === skill.id)) {
    assert.ok(!delivery.bundle.instructions.includes('/' + skill.name + '/SKILL.md'));
  }
  const note = startupNote('Read.', '{AGENTRIX_HANDOFF}', '/srv/app/skills', delivery);
  assert.ok(note.includes(delivery.manifest), 'large instruction lists use a manifest');
  assert.ok(note.includes(delivery.skippedNote), 'the startup note discloses omissions even when using a manifest');
  assert.match(note, /This project keeps its skills in \/srv\/app\/skills/);
  assert.match(note, /create or update a skill there/);
  assert.match(note, /no names of people, email addresses, phone numbers/);
  assert.match(note, /read-only reference copies/);
  assert.doesNotMatch(note, /may update it in place|propose edits only/);
});

test('idle metadata polls read no bodies and refresh only the root that actually changed', async t => {
  const { store, projects } = fixture(t);
  const global = await store.save(null, draft('polled'));
  await store.save(null, draft('other', 'project', 'p1'));
  await Promise.all([...store.watchers.values()].map(watcher => watcher.poll()));
  await new Promise(resolve => setTimeout(resolve, 250));
  const refreshes = [], reads = [], refresh = store.refresh.bind(store), readFile = fs.readFileSync;
  store.refresh = (...args) => { refreshes.push(args[1]); return refresh(...args); };
  t.mock.method(fs, 'readFileSync', (file, ...args) => { if (String(file).endsWith('SKILL.md')) reads.push(file); return readFile(file, ...args); });
  for (let i = 0; i < 3; i++) await Promise.all([...store.watchers.values()].map(watcher => watcher.poll()));
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.deepEqual(refreshes, []); assert.deepEqual(reads, []);
  put(global.path, text('polled', 'Changed outside the app.'));
  await store.watchers.get(store.globalFolder).poll();
  await until(() => refreshes.length > 0, 'one changed-root refresh');
  assert.ok(refreshes.every(roots => roots instanceof Set && [...roots].every(root => root === store.globalFolder)));
  assert.ok(reads.every(file => !String(file).startsWith(projects[0].path)));
});

test('startup, offline edits and newly added projects are app baselines; invalid/reappearing files retain identity', async t => {
  const { store, options, dataDir, projects, active } = fixture(t, ({ dataDir }) => {
    put(path.join(dataDir, 'skills', 'existing', 'SKILL.md'), text('existing'));
    put(path.join(dataDir, 'skills', 'invalid-at-start', 'SKILL.md'), 'incomplete front matter');
  });
  let skill = store.list().find(item => item.id === 'user:existing');
  assert.deepEqual([skill.version, skill.updatedBy, skill.createdByAgent], [1, 'app', false]);
  const original = store.read(skill.id).text;
  assert.equal(JSON.parse(fs.readFileSync(path.join(store.history.folder(skill.id), 'index.json'), 'utf8')).lastSeenHash, safeId(original));
  active.push('p1');
  put(path.join(dataDir, 'skills', 'invalid-at-start', 'SKILL.md'), text('invalid-at-start'));
  const repaired = store.list().find(item => item.name === 'invalid-at-start');
  assert.deepEqual([repaired.updatedBy, repaired.createdByAgent], ['app', false]);
  put(skill.path, '---\nname: existing\n');
  assert.equal(store.list().find(item => item.id === skill.id).version, 1);
  assert.equal(store.read(skill.id).text, original);
  put(skill.path, original);
  assert.equal(store.list().find(item => item.id === skill.id).version, 1);
  const hidden = path.join(dataDir, 'temporarily-away');
  fs.renameSync(path.dirname(skill.path), hidden); store.list();
  fs.renameSync(hidden, path.dirname(skill.path));
  skill = store.list().find(item => item.id === skill.id);
  assert.deepEqual([skill.version, skill.createdByAgent], [1, false]);
  store.close(); put(skill.path, text('existing', 'Edited while closed.'));
  const reopened = new SkillsStore(options); t.after(() => reopened.close());
  skill = reopened.list().find(item => item.id === skill.id);
  assert.deepEqual([skill.version, skill.updatedBy, skill.createdByAgent], [2, 'app', false]);
  const added = { id: 'added', name: 'Added', path: path.join(dataDir, 'added-project') };
  put(path.join(added.path, 'skills', 'present', 'SKILL.md'), text('present'));
  projects.push(added); active.push('added');
  const baseline = reopened.list().find(item => item.id === 'project:added:present');
  assert.deepEqual([baseline.version, baseline.updatedBy, baseline.createdByAgent], [1, 'app', false]);
});

test('only active sessions in the matching project attribute changes and new skills to an agent', async t => {
  const { store, active, dataDir, projects } = fixture(t);
  const local = await store.save(null, draft('local', 'project', 'p1'));
  active.push('p2');
  put(local.path, text('local', 'External editor in an inactive folder.'));
  assert.equal(store.list().find(item => item.id === local.id).updatedBy, 'user');
  put(path.join(projects[0].path, 'skills', 'external', 'SKILL.md'), text('external'));
  assert.equal(store.list().find(item => item.name === 'external').createdByAgent, false);
  active.push('p1');
  put(local.path, text('local', 'Changed during an active session in this folder.'));
  const changed = store.list().find(item => item.id === local.id);
  assert.deepEqual([changed.updatedBy, changed.updatedIn], ['agent', 'First']);
  put(path.join(dataDir, 'skills', 'ambiguous', 'SKILL.md'), text('ambiguous'));
  assert.equal(store.list().find(item => item.name === 'ambiguous').updatedBy, 'user', 'multiple active projects provide no unique global attribution');
  const global = store.entry('user:ambiguous');
  put(global.path, text('ambiguous', 'Successful tool edit supplies the missing evidence.'));
  store.recordAction({ kind: 'edit', done: true, at: Date.now(), files: [{ path: global.path }] }, { cwd: projects[1].path, project: 'p2', agent: 'claude' });
  active.length = 0;
  assert.equal(store.list().find(item => item.name === 'ambiguous').updatedBy, 'agent', 'a proven edit outlives its session until the watcher catches up');
  assert.equal(store.list().find(item => item.name === 'ambiguous').updatedIn, 'Second');
  put(global.path, text('ambiguous', 'External edit after the session and proven write have finished.'));
  assert.equal(store.list().find(item => item.name === 'ambiguous').updatedBy, 'user');
});

test('corrupt JSON is backed up and bad skills roots are warned about without breaking construction or delivery', t => {
  const corrupt = '{"broken":';
  const { store, dataDir, errors, projects } = fixture(t, ({ dataDir }) => {
    put(path.join(dataDir, 'skills.json'), corrupt);
    put(path.join(dataDir, 'skill-history', safeId('builtin:model-routing'), 'index.json'), corrupt);
    put(path.join(dataDir, 'skills'), 'a file, not a directory');
  });
  assert.doesNotThrow(() => store.delivery(projects[0]));
  assert.doesNotThrow(() => store.delivery(projects[2], true));
  for (const file of [path.join(dataDir, 'skills.json'), path.join(store.history.folder('builtin:model-routing'), 'index.json')]) {
    const backup = fs.readdirSync(path.dirname(file)).find(name => name.startsWith(path.basename(file) + '.corrupt-'));
    assert.ok(backup); assert.equal(fs.readFileSync(path.join(path.dirname(file), backup), 'utf8'), corrupt);
  }
  assert.ok(errors.some(error => error.message.includes('skills.json')));
  assert.ok(errors.some(error => error.message.includes('index.json')));
  assert.ok(errors.some(error => error.message.includes('skills')));
});

test('inaccessible roots and skill files are skipped with warnings and valid siblings still deliver', async t => {
  const { store, options, projects, errors } = fixture(t);
  const info = await store.save(null, draft('denied'));
  store.close();
  const readDir = fs.readdirSync, readFile = fs.readFileSync;
  t.mock.method(fs, 'readdirSync', (root, ...args) => {
    if (root === path.join(projects[0].path, 'skills')) throw Object.assign(new Error('synthetic EACCES root'), { code: 'EACCES' });
    return readDir(root, ...args);
  });
  t.mock.method(fs, 'readFileSync', (file, ...args) => {
    if (file === info.path) throw Object.assign(new Error('synthetic EACCES file'), { code: 'EACCES' });
    return readFile(file, ...args);
  });
  fs.mkdirSync(path.join(projects[0].path, 'skills'), { recursive: true });
  const reopened = new SkillsStore(options); t.after(() => reopened.close());
  assert.equal(reopened.list().length, 1);
  assert.doesNotThrow(() => reopened.delivery(projects[0]));
  assert.ok(errors.some(error => error.message === 'synthetic EACCES root'));
  assert.ok(errors.some(error => error.message === 'synthetic EACCES file'));
});

test('display metadata stays separate from agent metadata and project names follow renames', async t => {
  const { store, projects } = fixture(t);
  const builtinText = fs.readFileSync(path.join(__dirname, '../resources/skills/model-routing/SKILL.md'), 'utf8');
  const builtin = metadata(builtinText);
  assert.equal(builtin.name, 'model-routing'); assert.equal(builtin.title, '模型路由');
  assert.equal(builtin.summary.split('。').filter(Boolean).length, 2);
  const raw = '\uFEFF---\r\nname: old\r\ndescription: old description\r\ntitle: "显示名"\r\nsummary: >\r\n  第一行。\r\n  第二行。\r\n---\r\nBody stays.\r\n';
  const saved = draftText({ ...draft('user-name'), text: raw });
  assert.equal(metadata(saved).title, '显示名'); assert.match(saved, /Body stays\.\r\n$/);
  const user = await store.save(null, { ...draft('user-name', 'project', 'p1'), text: raw });
  assert.deepEqual([user.title, user.summary, user.updatedIn], ['user-name', 'A tested procedure.', 'First']);
  const at = Date.now();
  store.recordAction({ kind: 'skill', done: true, at, skillFile: user.path }, { cwd: projects[0].path, project: 'p1', agent: 'claude' });
  projects[0].name = 'Renamed project';
  const renamed = store.list().find(item => item.id === user.id);
  assert.equal(renamed.updatedIn, 'Renamed project'); assert.equal(renamed.lastUsed.project, 'Renamed project');
  assert.equal(store.read(user.id).versions[0].project, 'Renamed project');
  assert.deepEqual(Object.keys(store.read(user.id).versions[0]).sort(), ['version', 'at', 'by', 'project', 'text'].sort());
});

test('history moves once, deletes with the skill, caps versions, and loads only recent bodies', async t => {
  const { store } = fixture(t);
  let info = await store.save(null, draft('history'));
  for (let i = 2; i <= 25; i++) info = await store.save(info.id, draft('history', 'global', null, 'Version ' + i));
  let versions = store.read(info.id).versions;
  assert.equal(versions.length, MAX_VERSIONS);
  assert.deepEqual(versions.map(item => item.version), Array.from({ length: 20 }, (_, i) => i + 6));
  assert.equal(versions.filter(item => item.text).length, TEXT_VERSIONS);
  assert.equal(fs.readdirSync(store.history.folder(info.id)).filter(name => name.endsWith('.md')).length, MAX_VERSIONS);
  const oldId = info.id, oldHistory = store.history.folder(oldId);
  info = await store.save(info.id, draft('moved-history', 'project', 'p2', 'Moved version'));
  versions = store.read(info.id).versions;
  assert.equal(versions.length, MAX_VERSIONS); assert.equal(new Set(versions.map(item => item.version)).size, MAX_VERSIONS);
  assert.ok(!fs.existsSync(oldHistory)); assert.equal(store.history.latest(oldId), null);
  store.revert(info.id, versions[0].version);
  assert.match(store.read(info.id).text, /Version 7/);
  const folder = store.history.folder(info.id);
  store.delete(info.id);
  assert.ok(!fs.existsSync(folder)); assert.equal(store.history.latest(info.id), null);
});

test('legacy history is capped on startup and cross-volume moves carry versions once without app-write races', async t => {
  const { store, projects } = fixture(t, ({ dataDir }) => {
    const id = 'user:legacy', folder = path.join(dataDir, 'skill-history', safeId(id)), versions = [];
    for (let version = 1; version <= 25; version++) {
      versions.push({ version, at: version, by: 'user', project: null });
      put(path.join(folder, 'v' + version + '.md'), text('legacy', 'Version ' + version));
    }
    put(path.join(folder, 'index.json'), JSON.stringify(versions));
    put(path.join(dataDir, 'skills', 'legacy', 'SKILL.md'), text('legacy', 'Version 25'));
  });
  const original = store.entry('user:legacy'), oldFolder = store.history.folder(original.id);
  assert.equal(store.read(original.id).versions.length, MAX_VERSIONS);
  assert.equal(fs.readdirSync(oldFolder).filter(name => name.endsWith('.md')).length, MAX_VERSIONS);
  const rename = fs.promises.rename.bind(fs.promises);
  t.mock.method(fs.promises, 'rename', async (from, to) => {
    if (from === path.dirname(original.path)) {
      assert.equal(store.refresh().find(item => item.id === original.id).version, 25);
      const concurrent = await store.save(null, draft('concurrent'));
      assert.deepEqual([concurrent.title, concurrent.summary, concurrent.source], ['concurrent', 'A tested procedure.', 'user']);
      throw Object.assign(new Error('synthetic cross-volume move'), { code: 'EXDEV' });
    }
    return rename(from, to);
  });
  const moved = await store.save(original.id, draft('legacy-moved', 'project', projects[0].id));
  assert.equal(moved.version, 26); assert.equal(store.read(moved.id).versions.length, MAX_VERSIONS);
  assert.ok(!fs.existsSync(oldFolder));
});

test('delivery is reused until relevant changes and successful reads publish usage without refreshing notes', async t => {
  const { store, projects, changes } = fixture(t);
  const info = await store.save(null, draft('cached'));
  const refresh = t.mock.method(store, 'refresh', store.refresh.bind(store));
  const delivery = store.delivery(projects[0]), manifestTime = fs.statSync(delivery.manifest).mtimeMs;
  assert.equal(store.delivery(projects[0]), delivery);
  store.recordAction({ kind: 'skill', done: true, at: Date.now(), skillFile: info.path }, { cwd: projects[0].path, project: 'p1', agent: 'claude' });
  assert.equal(changes.at(-1).deliveryChanged, false);
  assert.equal(store.delivery(projects[0]), delivery);
  assert.equal(fs.statSync(delivery.manifest).mtimeMs, manifestTime);
  assert.equal(refresh.mock.callCount(), 0, 'starts and usage publications do not scan every project');
  store.setOptions(info.id, { trigger: 'always' });
  assert.notEqual(store.delivery(projects[0]), delivery);
  const source = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
  const notes = source.slice(source.indexOf('function refreshSkillNotes()'), source.indexOf('// Workspace broadcasts'));
  const sessions = new Map([['one', { projectId: 'p1', terminalId: 'one', sessionId: 'first', skillNoteFile: 'one.txt' }], ['two', { projectId: 'p1', terminalId: 'two', sessionId: 'later', skillNoteFile: 'two.txt' }]]);
  let deliveries = 0, writes = 0;
  const refreshNotes = require('node:vm').runInNewContext('(' + notes + ')', { sessions, store: { projects }, skills: { delivery: (project, remote, sessionId) => { assert.equal(project.id, 'p1'); assert.equal(remote, false); assert.ok(['first', 'later'].includes(sessionId)); deliveries++; return {}; } }, startupNote: () => 'Current instructions.', path,
    integrationDir: '/synthetic/integration', handoffFile: id => id, READING_NOTE: 'Read.', writeFileAtomic: () => writes++ });
  refreshNotes(); assert.equal(deliveries, 2); assert.equal(writes, 2);
  refreshNotes(); assert.equal(writes, 2, 'unchanged notes are not rewritten');
});

test('imports skip dependency and dot folders, enforce total/count limits, and yield to the event loop', async t => {
  const { root, store } = fixture(t), folder = path.join(root, 'bounded-import');
  put(path.join(folder, 'SKILL.md'), text('bounded-import'));
  for (const skipped of ['.git', 'node_modules', '.hidden']) put(path.join(folder, skipped, 'too-big.bin'), '');
  fs.truncateSync(path.join(folder, '.git', 'too-big.bin'), MAX_IMPORT_BYTES + 1);
  for (let i = 0; i < 60; i++) put(path.join(folder, 'asset-' + i), 'small');
  let ticked = false;
  const importing = importFiles(folder); setImmediate(() => { ticked = true; });
  const files = await importing;
  assert.equal(ticked, true); assert.equal(files.length, 61);
  assert.ok(files.every(file => !/\.git|node_modules|\.hidden/.test(file.relative)));
  const imported = await store.import(folder, 'global', null);
  assert.ok(!fs.existsSync(path.join(path.dirname(imported.path), '.git')));
  put(path.join(folder, 'oversized.bin'), ''); fs.truncateSync(path.join(folder, 'oversized.bin'), MAX_IMPORT_BYTES + 1);
  await assert.rejects(() => importFiles(folder), /8 MB/);
  fs.unlinkSync(path.join(folder, 'oversized.bin'));
  for (let i = 60; i <= MAX_IMPORT_FILES; i++) put(path.join(folder, 'asset-' + i), '');
  await assert.rejects(() => importFiles(folder), /128/);
});
