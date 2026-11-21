const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { folderHistory, latestCodexSession, launchCommand } = require('../electron/features/agents/launch.cjs');
const { createHostInputs } = require('../electron/features/native-session/host-inputs.cjs');

test('a new project starts each agent fresh, or resumes the conversation found for its folder', () => {
  assert.equal(launchCommand('claude', null), 'claude\r');
  assert.throws(() => launchCommand('codex', null), /app-server/);
  assert.equal(launchCommand('claude', { id: '0b7c2b4e-5f0a-4d43-9a43-8f1f2f8f0c11', at: 1 }), 'claude --resume 0b7c2b4e-5f0a-4d43-9a43-8f1f2f8f0c11\r');
  assert.throws(() => launchCommand('codex', { id: '01a12122-af65-73b0-88ef-19fd79292360', at: 1 }), /app-server/);
});

test('Claude launch commands leave all seat flags to the terminal wrappers', () => {
  const seat = { model: 'sonnet', effort: 'xhigh' };
  assert.equal(launchCommand('claude', null, seat), 'claude\r');
  assert.equal(launchCommand('claude', { id: 'saved' }, seat), 'claude --resume saved\r');
});

test('bootstrap writes and refreshes four lead lines for fresh and resumed terminal launches', t => {
  const { writeBootstrap, updateBootstrapLead, removeBootstrap } = require('../electron/features/terminal-events/bootstrap-file.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'route-lead-')), file = path.join(root, 'bootstrap.json');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lead = { model: 'claude-opus-5[1m]', effort: 'adaptive', fast: true };
  writeBootstrap({ file, eventServer: { name: 'fake', address: 'fake' }, lead });
  assert.equal(fs.readFileSync(file + '.lead', 'utf8'), 'claude-opus-5[1m]\nadaptive\n1\nnull\n');
  const bytes = fs.readFileSync(file, 'utf8');
  updateBootstrapLead(file, { model: 'sonnet', effort: 'high', fast: false, seatsMap: { researcher: { model: 'sonnet', effort: 'high' } } });
  assert.equal(fs.readFileSync(file + '.lead', 'utf8'), 'sonnet\nhigh\n0\n{"researcher":{"model":"sonnet","effort":"high"}}\n');
  assert.throws(() => updateBootstrapLead(file, { ...lead, model: 'invalid\nline' }), /Invalid lead seat/);
  updateBootstrapLead(file, null);
  assert.equal(fs.readFileSync(file + '.lead', 'utf8'), '');
  assert.equal(fs.readFileSync(file, 'utf8'), bytes);
  removeBootstrap(file); assert.equal(fs.existsSync(file + '.lead'), false);
});

function nativeSeatStart(skills) {
  const { nativeSpec } = createHostInputs({ sessions: new Map(), nativeSpecs: new Map(), findProject: () => ({ id: 'p', path: '/isolated' }),
    store: { settings: {}, findTerminal: () => ({ record: { restore: { agent: 'codex', threadId: 'saved' } } }) },
    skills: { ...skills, delivery: () => ({}) },
    randomUUID: () => 'isolated-session', runtimeDir: '/isolated/runtime', integrationDir: '/isolated/integration',
    writeBootstrap() {}, nativeEnvironment: () => ({}), startupNote: () => '', handoffFile: () => '', READING_NOTE: '',
    eventServer: {}, controlAddress: '', nativeSubagent() {},
  });
  return (agent, resume = false, launch = null) => nativeSpec('terminal', agent, resume, false, launch);
}

test('native starts and resumes take the selected family lead and ignore obsolete launch choices', () => {
  const seats = { codex: { model: 'gpt-next', effort: 'medium', fast: false }, claude: { model: 'sonnet', effort: 'max' } };
  const start = nativeSeatStart({ leadOptions: (_project, agent) => seats[agent] });
  const fresh = start('codex'); assert.equal(fresh.model, 'gpt-next'); assert.equal(fresh.effort, 'medium'); assert.equal(fresh.fast, false);
  const claude = start('claude'); assert.equal(claude.model, 'sonnet'); assert.equal(claude.effort, 'max'); assert.equal(claude.fast, false);
  const explicit = start('codex', false, { model: 'gpt-explicit', effort: 'low', fast: true });
  assert.equal(explicit.model, 'gpt-next'); assert.equal(explicit.effort, 'medium'); assert.equal(explicit.fast, false);
  const resume = start('codex', true); assert.equal(resume.providerSessionId, 'saved'); assert.equal(resume.model, 'gpt-next');
  const pendingHistory = start('claude', true);
  assert.equal(pendingHistory.providerSessionId, null); assert.equal(pendingHistory.model, 'sonnet');
});

test('team defaults and the other-family lead are always present even after a disable request', t => {
  const { SkillsStore } = require('../electron/features/skills/store.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentrix-seat-lead-'));
  const project = { id: 'p', name: 'Isolated', path: path.join(root, 'project') }; fs.mkdirSync(project.path);
  const store = new SkillsStore({ dataDir: path.join(root, 'profile'), builtinDir: path.join(__dirname, '../resources/skills'),
    getProjects: () => [project], getAgents: () => ({ claude: { installed: true }, codex: { installed: true } }) });
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const start = nativeSeatStart({ leadOptions: store.leadOptions.bind(store) });
  assert.equal(start('claude').model, 'opus'); assert.equal(start('codex').model, 'gpt-6.1-sol');
  const claude = { model: 'sonnet', effort: 'max' };
  assert.deepEqual(store.setRouting('template', null, { roles: { orchestrator: claude } }, null), { ok: true });
  assert.deepEqual(store.leadOptions('p', 'claude'), claude);
  const codex = { model: 'gpt-6.1-sol', effort: 'low', fast: false };
  assert.deepEqual(store.setRouting('project', 'p', { roles: { orchestrator: codex } }, null), { ok: true });
  assert.deepEqual(store.leadOptions('p', 'claude'), { model: 'opus', effort: 'high' });
  assert.deepEqual(store.leadOptions('p', 'codex'), codex);
  assert.throws(() => store.setOptions('builtin:model-routing', { enabled: false }), /\u53ea\u8bfb/);
  assert.equal(start('claude').model, 'opus'); assert.equal(start('codex', true).effort, 'low');
});

test('latest and deferred Codex resumes take the current seat', () => {
  let seatReads = 0;
  const start = nativeSeatStart({ leadOptions: () => { seatReads++; return { model: 'gpt-seat', effort: 'xhigh', fast: false }; } });
  for (const [resume, launch] of [[true, { resume: true, latest: true }], [false, { resume: true, latest: true }], [true, null]]) {
    const spec = start('codex', resume, launch);
    assert.equal(spec.model, 'gpt-seat'); assert.equal(spec.effort, 'xhigh'); assert.equal(spec.fast, false);
    assert.equal(Object.hasOwn(spec, 'preserveRunOptions'), false);
  }
  const explicit = start('codex', true, { resume: true, latest: true, model: 'gpt-owner', effort: 'low', fast: false });
  assert.equal(explicit.model, 'gpt-seat'); assert.equal(explicit.effort, 'xhigh'); assert.equal(explicit.fast, false);
  assert.equal(seatReads, 4);
});

test('a Claude resume takes the lead seat even before folder history resolves its identity', () => {
  const start = nativeSeatStart({ leadOptions: () => ({ model: 'sonnet', effort: 'max' }) });
  const resumed = start('claude', true);
  assert.equal(resumed.providerSessionId, null, 'the router has not read folder history yet');
  assert.equal(resumed.model, 'sonnet'); assert.equal(resumed.effort, 'max');
  const ownerChoice = start('claude', true, { model: 'owner-menu-model', effort: 'max' });
  assert.equal(ownerChoice.model, 'sonnet'); assert.equal(ownerChoice.effort, 'max');
  const fresh = start('claude');
  assert.equal(fresh.model, 'sonnet'); assert.equal(fresh.effort, 'max');
});

test('the seat catalog reuses models already read by the Codex model menu without making a request', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
  assert.doesNotMatch(source, /require\(['"]\.\/features\/skills\/model-(?:catalog|probe)\.cjs['"]\)/);
  const codex = source.indexOf('  const codex = { create(spec, emit) {');
  const start = source.indexOf('    return typeof skills', codex), end = source.indexOf('\n  } };', start);
  assert.ok(start >= 0 && end > start);
  let reads = 0;
  const rows = [{ value: 'gpt-menu-model', efforts: ['low', 'high'] }], cache = new Map();
  const { SkillsStore } = require('../electron/features/skills/store.cjs');
  const runtime = { models: async () => { reads++; return rows; }, close: async () => {} };
  const skills = { trackModelRuntime: SkillsStore.prototype.trackModelRuntime,
    observeModels: (family, values) => { assert.equal(family, 'codex'); for (const row of values) cache.set(row.value, row); } };
  const context = vm.createContext({ runtime, skills, spec: { kind: 'local' }, seatModelRuntimes: { codex: new Set() } });
  assert.equal(vm.runInContext(`(function () {${source.slice(start, end)} })()`, context), runtime);
  assert.equal(reads, 0); assert.equal(cache.size, 0);
  assert.equal(await runtime.models(), rows); assert.equal(reads, 1); assert.equal(cache.get('gpt-menu-model'), rows[0]);
  await runtime.close();
});

test("the latest Codex conversation is this folder's own, never another project's newer one", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-codex-')), day = path.join(home, 'sessions', '2026', '10', '10');
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-project-')), other = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-other-'));
  fs.mkdirSync(day, { recursive: true });
  const write = (name, id, cwd, modified) => {
    const file = path.join(day, `rollout-2026-10-10T00-00-00-${id}.jsonl`);
    fs.writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { id, cwd, source: 'cli' } }) + '\n');
    fs.utimesSync(file, modified, modified);
  };
  write('mine', '01a12122-af65-73b0-88ef-19fd79292360', project, new Date('2026-10-09T10:00:00Z'));
  write('older', '01a12122-af65-73b0-88ef-19fd79292361', project, new Date('2026-10-08T10:00:00Z'));
  write('other', '01a12122-af65-73b0-88ef-19fd79292362', other, new Date('2026-10-10T10:00:00Z'));
  const found = await latestCodexSession(project, home);
  assert.equal(found.id, '01a12122-af65-73b0-88ef-19fd79292360');
  assert.equal(await latestCodexSession(fs.mkdtempSync(path.join(os.tmpdir(), 'launch-empty-')), home), null);
});

test('folder history reports each agent separately and survives one of them failing', async () => {
  const history = await folderHistory('C:\\work', {
    claude: async () => [{ id: 'c1', updatedAt: 5 }, { id: 'c0', updatedAt: 1 }],
    codex: async () => { throw new Error('unreadable'); },
  });
  assert.deepEqual(history, { claude: { id: 'c1', at: 5 }, codex: null });
});

test('public state reserves the reading surface during agent startup and releases it on success, error or exit', () => {
  const source = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
  const session = { sessionId: 'session', status: 'starting', agentStarting: true, promptQueue: { list: () => [] } };
  const context = vm.createContext({ restorePlans: new Map(), readingHistory: { summary: () => null }, dispatchedOnly: () => null,
    store: { projects: [{ id: 'project', name: 'Project' }], settings: {} }, sessions: new Map([['project', session]]), startupErrors: new Map(),
    terminalIds: () => ['project'], shownTerminalIds: () => ['project'], getBranch: () => '', t: text => text,
    localShell: () => ({ kind: 'powershell' }), process: { platform: 'win32', env: { AGENTRIX_DATA_DIR: 'isolated' } },
    app: { getVersion: () => 'test' }, desktopGlassBackend: null, desktopGlassWindow: false, desktopGlassActive: false, windowZoom: null, macTitlebar: null,
  });
  vm.runInContext(source.slice(source.indexOf('function publicState('), source.indexOf('function terminalIds(')), context);
  const terminal = () => context.publicState().projects[0].terminals[0];
  assert.equal(terminal().agentStarting, true);
  session.status = 'shell'; assert.equal(terminal().agentStarting, true, 'the first shell prompt still belongs to the pending agent launch');
  session.codexActive = true; assert.equal(terminal().agentStarting, false);
  session.codexActive = false; session.error = 'agent not installed'; assert.equal(terminal().agentStarting, false, 'errors expose the terminal for diagnosis');
  session.error = null; session.status = 'exited'; assert.equal(terminal().agentStarting, false);
  session.status = 'shell'; session.agentStarting = false; assert.equal(terminal().agentStarting, false, 'a plain shell stays visible');
});

test('agent:launch refuses the removed native mode without starting or replacing a session, and sends Codex to app-server', async () => {
  const main = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8'), handlers = {}, starts = [], deleted = [];
  const context = vm.createContext({ handle: (name, run) => handlers[name] = run, findProject: () => ({ kind: 'local' }), sessions: new Map(),
    launchPlans: { delete: id => deleted.push(id) }, restorePlans: { delete: id => deleted.push(id) }, startTerminal: () => assert.fail('no Codex TUI'),
    store: { findTerminal: () => ({ record: {} }) }, nativeSessions: { start: async (...args) => starts.push(args) }, broadcast() {} });
  const start = main.indexOf("  handle('agent:launch'");
  vm.runInContext(main.slice(start, main.indexOf('  registerNativeIpc(', start)), context);
  for (const agent of ['claude', 'codex']) await assert.rejects(handlers['agent:launch']('fixture', agent, 'native'), /Unsupported agent session mode/);
  assert.deepEqual(starts, []); assert.deepEqual(deleted, []);
  assert.equal(await handlers['agent:launch']('fixture', 'codex', 'new'), true);
  assert.equal(starts.length, 1); assert.equal(starts[0][0], 'fixture'); assert.equal(starts[0][1].agent, 'codex');
});

test('the launcher offers both agents and the two start modes, with no terminal mode or managed Claude action', t => {
  const { hookHarness } = require('./helpers/hook-harness.cjs'), React = require('react');
  const previous = global.window; global.window = { agentrix: { getAgents: async () => ({ ok: true, value: { codex: { installed: true }, claude: { installed: true } } }), onAgents: () => () => {}, agentHistory: async () => ({ ok: true, value: { claude: null, codex: null } }) } };
  t.after(() => { global.window = previous; });
  const ui = hookHarness('src/features/terminal/AgentLauncher.tsx', { '@phosphor-icons/react': { CircleNotch() {}, Terminal() {} },
    './AgentBrandIcon.ts': { ClaudeLogo() {}, CodexLogo() {} }, './time': { relativeTime: () => '' }, './i18n': { t: text => text }, './agent-launcher.css': {} });
  const props = { terminalId: 'fixture', projectId: 'fixture', onAction: async () => {}, onOpenTerminal() {} };
  const nodes = node => Array.isArray(node) ? node.flatMap(nodes) : React.isValidElement(node) ? [node, ...nodes(node.props.children)] : [];
  const first = ui.render('AgentLauncher', props).result;
  const buttons = nodes(first).filter(node => node.type === 'button' && node.props.className?.startsWith('agent-launcher-agent '));
  assert.deepEqual(nodes(first).filter(node => node.props.role === 'radio').map(node => node.props.children), ['开始新开发', '继承开发历史']);
  assert.equal(buttons.length, 2);
  assert.equal(nodes(first).some(node => typeof node.props.children === 'string' && /SDK/.test(node.props.children)), false); ui.dispose();
});
