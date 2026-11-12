const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { codexLaunch, agentCommand } = require('../electron/features/agents/agent-command.cjs');
const { shellEvent } = require('../integration/agent-event.cjs');
const main = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
const thread = '11111111-1111-4111-8111-111111111111';

test('manual Codex argv maps only supported native semantics, including exact resume and initial prompt', () => {
  assert.deepEqual(codexLaunch([]), { resume: false });
  assert.deepEqual(codexLaunch(['resume', thread, '--model', 'fixture', '继续检查']),
    { resume: true, providerSessionId: thread, model: 'fixture', prompt: '继续检查' });
  assert.deepEqual(codexLaunch(['--cd', '../sub', '-m', 'fixture', '-c', 'model_reasoning_effort="high"', 'resume', '--last']),
    { resume: true, latest: true, cwd: '../sub', model: 'fixture', effort: 'high' });
  for (const args of [['login'], ['review'], ['app'], ['exec', 'task'], ['resume'], ['resume', 'not-a-thread'], ['--profile', 'other'],
    ['--sandbox', 'danger-full-access'], ['-c', 'model_provider="other"'], ['-m'], ['-m', 'a', '-m', 'b'],
    ...['agents', 'queue', 'fork', 'cloud', 'exec', 'e', 'review', 'archive', 'delete', 'unarchive', 'migrate-rollouts', 'migrate-nfs-db', 'exec-server', 'remote-control', 'doctor', 'plugin', 'help'].map(word => [word]),
    ['one', 'two'], ['--help'], ['--unknown'], ['x'.repeat(32769)], [null]]) {
    assert.throws(() => codexLaunch(args), /Agentrix.*原生模式/, JSON.stringify(args));
  }
  assert.equal(agentCommand('codex', 'login'), null, 'Codex no longer creates terminal command runs');
  assert.equal(agentCommand('claude', 'login'), 'login');
});

test('the existing shell event carries bounded argv intact without forging a CLI completion', () => {
  const args = ['resume', thread, '中文 "quotes" \\ end'];
  const event = shellEvent(['codex-started', '3', '0', 'codex', 'true', 'true', '/home/.codex', '/p', '', '', JSON.stringify(args)], 't', 'key');
  assert.deepEqual(event.args, args);
  assert.equal(event.type, 'codex-started');
  assert.equal(shellEvent(['codex-started', '3', '0', 'codex', 'true', 'true', '', '/p', '', '', 'broken'], 't', 'key'), null);
});

function host(kind = 'local') {
  const starts = [], sent = [], launches = [], warnings = [], project = { id: 'p', kind, path: kind === 'ssh' ? '/remote/project' : path.resolve('project') };
  const session = { terminalId: 't', projectId: 'p', sessionKey: 'key', chunks: [], bytes: 0, pending: '', flush() { warnings.push(this.pending); this.pending = ''; } };
  const sessions = new Map([['t', session]]);
  const context = vm.createContext({ path, require: name => { assert.equal(name, './features/agents/agent-command.cjs'); return { codexLaunch }; }, randomUUID: () => 'message-id', codexLaunch, sessions,
    nativeSessions: { start: async (...args) => { starts.push(args); return { runtimeSessionId: 'runtime' }; }, send: async (...args) => { sent.push(args); } },
    launchPlans: { delete: id => launches.push(id) }, restorePlans: { delete() {} }, broadcast() {},
    quitting: false, store: { projects: [project], findTerminal: () => ({ record: {} }) }, startupErrors: new Map(), acceptShellEvent: require('../electron/terminal-input.cjs').acceptShellEvent,
  });
  const begin = main.indexOf('async function openCodexFromShell(');
  assert.ok(begin >= 0, 'manual Codex has an explicit native launch boundary');
  vm.runInContext(main.slice(begin, main.indexOf('\nfunction onEvent(', begin)), context);
  return { context, project, session, sessions, starts, sent, warnings };
}

for (const kind of ['local', 'ssh']) test(`${kind} manual Codex starts on the same terminal via native start, preserving cwd and exact thread`, async () => {
  const f = host(kind), cwd = kind === 'ssh' ? '/remote/project/sub' : path.resolve('project/sub');
  await f.context.openCodexFromShell(f.project, f.session, { args: ['resume', thread, '-m', 'fixture', 'continue'], cwd });
  assert.equal(f.starts.length, 1); assert.equal(f.starts[0][0], 't');
  assert.equal(f.starts[0][1].agent, 'codex'); assert.equal(f.starts[0][1].resume, true);
  assert.equal(f.starts[0][1].launch.providerSessionId, thread); assert.equal(f.starts[0][1].launch.cwd, cwd);
  assert.equal(f.starts[0][1].launch.model, 'fixture');
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0][1], 'runtime'); assert.equal(f.sent[0][2].text, 'continue');
});

test('unsupported shell arguments stay at the prompt with a Chinese explanation and launch nothing', async () => {
  const f = host();
  await f.context.openCodexFromShell(f.project, f.session, { args: ['login'], cwd: f.project.path });
  assert.equal(f.starts.length, 0); assert.equal(f.sessions.get('t'), f.session);
  assert.match(f.warnings.join(''), /Agentrix.*原生模式.*软件外/);
});

test('a failed app-server start after retiring the shell stays visible without a TUI fallback', async () => {
  const f = host();
  f.context.nativeSessions.start = async () => { f.sessions.delete('t'); throw new Error('Codex 原生模式连接失败，请重试。'); };
  await f.context.openCodexFromShell(f.project, f.session, { args: [], cwd: f.project.path });
  assert.equal(f.context.startupErrors.get('t'), 'Codex 原生模式连接失败，请重试。');
});

test('authenticated manual Codex events leave before any terminal agent tracking', () => {
  const f = host(); let accepted = 0;
  f.context.openCodexFromShell = () => { accepted++; };
  vm.runInContext(main.slice(main.indexOf('function onEvent('), main.indexOf('\n// The agent chosen', main.indexOf('function onEvent('))), f.context);
  const event = { type: 'codex-started', projectId: 't', sessionKey: 'key', sequence: 2, agent: 'codex', args: [] };
  f.context.onEvent({ ...event, sessionKey: 'wrong' }); assert.equal(accepted, 0);
  f.context.onEvent(event); assert.equal(accepted, 1);
  f.context.onEvent(event); assert.equal(accepted, 1, 'delayed duplicates cannot open another native session');
  assert.equal(f.session.codexActive, undefined);
});

for (const kind of ['local', 'ssh']) test(`${kind} native spec applies only the host-mapped shell launch settings`, () => {
  const project = { id: 'p', kind, path: kind === 'ssh' ? '/remote/project' : path.resolve('project') };
  let disposed = 0;
  const context = vm.createContext({ path, randomUUID: () => 'id', sessions: new Map([['t', { status: 'shell' }]]),
    findProject: () => project, disposeTerminal: () => { disposed++; }, store: { settings: { codexPermissions: 'full' }, findTerminal: () => ({ record: { restore: { agent: 'claude', threadId: 'other', cwd: 'old' } } }) },
    nativeSpecs: new Map(), runtimeDir: path.resolve('runtime'), eventServer: { name: 'pipe', address: '/socket' }, process: { platform: process.platform, env: {} },
    fs: { writeFileSync() {} }, createTerminalEnvironment: () => ({ codex_home: 'old-home' }), withoutAppImage: value => value,
    startupNote: () => 'context', READING_NOTE: 'reading', handoffFile: () => 'handoff', skills: { delivery() {} }, integrationDir: 'integration', controlAddress: 'control' });
  vm.runInContext(main.slice(main.indexOf('function nativeSpec('), main.indexOf('\nfunction structuredEvent(')), context);
  const cwd = kind === 'ssh' ? '/remote/project/sub' : path.resolve('project/sub');
  const spec = context.nativeSpec('t', 'codex', true, false, { cwd, providerSessionId: thread, model: 'fixture', effort: 'max', fast: false, codexHome: '/private/codex' });
  assert.equal(disposed, 1); assert.equal(spec.cwd, cwd); assert.equal(spec.providerSessionId, thread);
  assert.equal(spec.model, 'fixture'); assert.equal(spec.effort, 'max'); assert.equal(spec.fast, false);
  if (kind === 'local') { assert.equal(spec.env.CODEX_HOME, '/private/codex'); assert.equal(spec.env.codex_home, undefined); }
});
