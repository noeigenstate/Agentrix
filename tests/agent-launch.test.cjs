const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { folderHistory, latestCodexSession, launchCommand } = require('../electron/features/agents/launch.cjs');

test('a new project starts each agent fresh, or resumes the conversation found for its folder', () => {
  assert.equal(launchCommand('claude', null), 'claude\r');
  assert.throws(() => launchCommand('codex', null), /app-server/);
  assert.equal(launchCommand('claude', { id: '0b7c2b4e-5f0a-4d43-9a43-8f1f2f8f0c11', at: 1 }), 'claude --resume 0b7c2b4e-5f0a-4d43-9a43-8f1f2f8f0c11\r');
  assert.throws(() => launchCommand('codex', { id: '01a12122-af65-73b0-88ef-19fd79292360', at: 1 }), /app-server/);
});

test('fresh Claude terminal launches carry the lead seat flags while resume carries no seat flags', () => {
  const seat = { model: 'sonnet', effort: 'xhigh' };
  assert.equal(launchCommand('claude', null, seat), 'claude --model "sonnet" --effort xhigh\r');
  assert.equal(launchCommand('claude', { id: 'saved' }, seat), 'claude --resume saved\r');
  assert.throws(() => launchCommand('claude', null, { model: 'opus;echo', effort: 'high' }), /model/);
});

test('native fresh launches take lead options, explicit launch choices win and resume ignores seat changes', () => {
  const { leadOptions } = require('../electron/features/skills/model-seats.cjs');
  const source = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
  const seats = { lead: { codex: { model: 'gpt-next', effort: 'medium', fast: false }, claude: { model: 'sonnet', effort: 'max' } } };
  const context = vm.createContext({ sessions: new Map(), nativeSpecs: new Map(), findProject: () => ({ id: 'p', path: '/isolated' }),
    store: { settings: {}, findTerminal: () => ({ record: { restore: { agent: 'codex', threadId: 'saved' } } }) },
    skills: { leadOptions: (_project, agent, explicit) => leadOptions(seats, agent, explicit), delivery: () => ({}) },
    randomUUID: () => 'isolated-session', path, runtimeDir: '/isolated/runtime', integrationDir: '/isolated/integration',
    writeBootstrap() {}, nativeEnvironment: () => ({}), startupNote: () => '', handoffFile: () => '', READING_NOTE: '',
    eventServer: {}, controlAddress: '', nativeSubagent() {},
  });
  vm.runInContext(source.slice(source.indexOf('function nativeSpec('), source.indexOf('\nfunction nativeSubagent(')), context);
  const start = (agent, resume = false, launch = null) => context.nativeSpec('terminal', agent, resume, false, launch);
  const fresh = start('codex'); assert.equal(fresh.model, 'gpt-next'); assert.equal(fresh.effort, 'medium'); assert.equal(fresh.fast, false);
  const claude = start('claude'); assert.equal(claude.model, 'sonnet'); assert.equal(claude.effort, 'max'); assert.equal(claude.fast, false);
  const explicit = start('codex', false, { model: 'gpt-explicit', effort: 'low', fast: true });
  assert.equal(explicit.model, 'gpt-explicit'); assert.equal(explicit.effort, 'low'); assert.equal(explicit.fast, true);
  const resume = start('codex', true); assert.equal(resume.providerSessionId, 'saved'); assert.equal(resume.model, null);
  const pendingHistory = start('claude', true);
  assert.equal(pendingHistory.providerSessionId, null); assert.equal(pendingHistory.seatResumeOptions.model, null);
});

test('a Claude resume resolved from folder history does not acquire the new lead seat model', () => {
  const source = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
  const start = source.indexOf('  const createClaude = claudeRuntime.create;'), end = source.indexOf('  // The first look at the CLI', start);
  assert.ok(start >= 0 && end > start);
  const context = vm.createContext({ claudeRuntime: { create: spec => spec } });
  vm.runInContext(source.slice(start, end), context);
  const resumed = context.claudeRuntime.create({ owner: 'gui', providerSessionId: 'saved', model: 'new-seat-model', effort: 'max',
    seatResumeOptions: { model: null, effort: 'high', fast: false } });
  assert.equal(resumed.model, null); assert.equal(resumed.effort, 'high');
  assert.equal(Object.hasOwn(resumed, 'seatResumeOptions'), false);
  const ownerChoice = context.claudeRuntime.create({ owner: 'gui', providerSessionId: 'saved', model: 'owner-menu-model', effort: 'max' });
  assert.equal(ownerChoice.model, 'owner-menu-model'); assert.equal(ownerChoice.effort, 'max');
  const fresh = context.claudeRuntime.create({ owner: 'gui', model: 'sonnet', effort: 'max' });
  assert.equal(fresh.model, 'sonnet'); assert.equal(fresh.effort, 'max');
});

test('the seat catalog reuses models already read by the Codex model menu without making a request', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
  const start = source.indexOf('    const models = runtime.models;'), end = source.indexOf('    let accountBinding', start);
  assert.ok(start >= 0 && end > start);
  let reads = 0;
  const rows = [{ value: 'gpt-menu-model', efforts: ['low', 'high'] }], cache = new Map();
  const runtime = { models: async () => { reads++; return rows; } }, context = vm.createContext({ runtime, seatModelCatalog: cache });
  vm.runInContext(source.slice(start, end), context);
  assert.equal(reads, 0); assert.equal(cache.size, 0);
  assert.equal(await runtime.models(), rows); assert.equal(reads, 1); assert.equal(cache.get('gpt-menu-model'), rows[0]);
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
