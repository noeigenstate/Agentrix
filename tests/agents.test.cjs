const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { AGENT_PACKAGES, AgentsManager, onPath } = require('../electron/agents.cjs');

// A PATH in the platform's own form: "folder";... with .cmd shims on Windows, folder:... with executables elsewhere.
const windows = process.platform === 'win32';
function fixture(t, extra = {}) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'agentrix-agents-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const env = windows ? { Path: `;"${folder}";`, ...extra } : { PATH: `:${folder}:`, ...extra };
  return { folder, env, add: name => fs.writeFileSync(path.join(folder, windows ? `${name}.cmd` : name), '', { mode: 0o755 }) };
}
function fakeLaunch() {
  const calls = [], children = [];
  const launch = (...args) => {
    calls.push(args);
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.kill = () => { child.killed = true; child.emit('close', null); };
    children.push(child); return child;
  };
  return { launch, calls, children };
}

test('status checks a fake PATH without spawning tools and ignores directories', t => {
  const { env, folder, add } = fixture(t);
  const fake = fakeLaunch();
  const manager = new AgentsManager({ env, launch: fake.launch });
  assert.deepEqual(manager.getState(), { codex: { installed: false }, claude: { installed: false }, npm: false, installing: null, message: '', error: '' });
  add('codex'); add('npm'); fs.mkdirSync(path.join(folder, windows ? 'claude.exe' : 'claude'));
  assert.equal(onPath('codex', env), true);
  if (!windows) fs.rmdirSync(path.join(folder, 'claude'));
  assert.deepEqual(manager.getState(), { codex: { installed: true }, claude: { installed: false }, npm: true, installing: null, message: '', error: '' });
  add('claude'); assert.equal(manager.getState().claude.installed, true);
  assert.equal(fake.calls.length, 0);
});

test('outside Windows a command is an executable file on a colon-separated PATH', { skip: windows }, t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'agentrix-agents-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const env = { PATH: `/nonexistent:${folder}` };
  fs.writeFileSync(path.join(folder, 'codex'), '', { mode: 0o644 });
  fs.writeFileSync(path.join(folder, 'claude.cmd'), '', { mode: 0o755 });
  assert.equal(onPath('codex', env, 'darwin'), false, 'not executable');
  assert.equal(onPath('claude', env, 'darwin'), false, 'a Windows shim is not a macOS command');
  fs.chmodSync(path.join(folder, 'codex'), 0o755);
  assert.equal(onPath('codex', env, 'darwin'), true);
});

test('isolated profiles report installed agents unless the agent test opt-in is set', t => {
  const { env } = fixture(t, { AGENTRIX_DATA_DIR: 'isolated-profile' });
  const manager = new AgentsManager({ env });
  assert.equal(manager.getState().codex.installed, true); assert.equal(manager.getState().claude.installed, true);
  env.AGENTRIX_TEST_AGENTS = '1';
  assert.equal(manager.getState().codex.installed, false); assert.equal(manager.getState().claude.installed, false);
});

test('only the immutable fixed package map is accepted, including prototype names and shell input', t => {
  const { env, add } = fixture(t); add('npm');
  const fake = fakeLaunch(), manager = new AgentsManager({ env, launch: fake.launch });
  assert.deepEqual(AGENT_PACKAGES, { codex: '@openai/codex', claude: '@anthropic-ai/claude-code' });
  assert.equal(Object.isFrozen(AGENT_PACKAGES), true);
  for (const agent of ['unknown', 'constructor', '__proto__', 'codex & whoami', '', null, {}, ['codex']]) assert.throws(() => manager.install(agent), /无效的编码助手/);
  assert.equal(fake.calls.length, 0);
});

test('npm must be available before starting any install', async t => {
  const { env } = fixture(t), fake = fakeLaunch(), states = [];
  const manager = new AgentsManager({ env, launch: fake.launch, onChange: state => states.push(state) });
  const result = await manager.install('codex');
  assert.equal(result.error, '需要先安装 Node.js'); assert.equal(result.installing, null);
  assert.deepEqual(states, [result]); assert.equal(fake.calls.length, 0);
});

test('Windows installs one agent at a time, pushes transitions and re-detects on success', async t => {
  const { env, add } = fixture(t); add('npm');
  const fake = fakeLaunch(), states = [];
  const manager = new AgentsManager({ env, platform: 'win32', launch: fake.launch, onChange: state => states.push(state) });
  assert.equal(manager.timeout, 600000);
  const first = manager.install('codex');
  assert.equal(manager.getState().installing, 'codex'); assert.equal(states[0].installing, 'codex');
  assert.throws(() => manager.install('claude'), /已有编码助手正在安装/);
  assert.deepEqual(fake.calls[0], ['cmd.exe', ['/d', '/s', '/c', 'npm install -g @openai/codex'], { env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] }]);
  add('codex'); fake.children[0].emit('close', 0);
  const result = await first;
  assert.equal(result.codex.installed, true); assert.equal(result.installing, null); assert.equal(result.error, ''); assert.match(result.message, /重启项目的终端/);
  assert.deepEqual(states.at(-1), result);
  const second = manager.install('claude');
  assert.equal(fake.calls[1][1][3], 'npm install -g @anthropic-ai/claude-code');
  add('claude'); fake.children[1].emit('close', 0); assert.equal((await second).claude.installed, true);
});

test('failed installs retain the last 2000 output characters and allow retry', async t => {
  const { env, add } = fixture(t); add('npm');
  const fake = fakeLaunch(), manager = new AgentsManager({ env, launch: fake.launch });
  const pending = manager.install('claude');
  fake.children[0].stdout.emit('data', Buffer.from('discarded' + 'x'.repeat(2100)));
  fake.children[0].stderr.emit('data', Buffer.from('last error'));
  fake.children[0].emit('close', 1);
  const result = await pending;
  assert.equal(result.error, '安装失败。\n' + 'x'.repeat(1990) + 'last error');
  assert.equal(result.message, ''); assert.equal(result.claude.installed, false); assert.equal(result.installing, null);
  const retry = manager.install('claude'); assert.equal(manager.getState().error, ''); fake.children[1].emit('close', 0); await retry;
});

test('spawn exceptions and process errors settle once without leaving an install locked', async t => {
  const { env, add } = fixture(t); add('npm');
  const manager = new AgentsManager({ env, launch: () => { throw new Error('spawn blocked'); } });
  assert.match((await manager.install('codex')).error, /spawn blocked/); assert.equal(manager.installing, null);
  const fake = fakeLaunch(), states = [], other = new AgentsManager({ env, launch: fake.launch, onChange: state => states.push(state) });
  const pending = other.install('codex'); fake.children[0].emit('error', new Error('ENOENT')); fake.children[0].emit('close', 1);
  assert.match((await pending).error, /ENOENT/); assert.equal(states.length, 2); assert.equal(other.installing, null);
});

test('a timed out install kills its process and reports an error instead of success', async t => {
  const { env, add } = fixture(t); add('npm');
  const fake = fakeLaunch(), manager = new AgentsManager({ env, launch: fake.launch, timeout: 10 });
  const result = await manager.install('codex');
  assert.equal(fake.children[0].killed, true); assert.equal(result.error, '安装超时，请重试。'); assert.equal(result.message, ''); assert.equal(result.installing, null);
});

test('Claude Code reads as installed from the locator\'s last search, never a search of its own, and an install searches again', async t => {
  const { env, add } = fixture(t); add('npm'); add('claude');
  const file = 'D:\\nodejs22\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe', terminal = { file, fileShown: file, version: '2.1.322', via: 'npm' };
  let located = null, refreshes = 0;
  const fake = fakeLaunch(), manager = new AgentsManager({ env, launch: fake.launch, claude: () => located,
    refreshClaude: async () => { refreshes++; located = { terminal, native: terminal }; } });
  // Before the first search the PATH check stands in; a search that found nothing (a placeholder shim) reads as missing.
  assert.deepEqual(manager.getState().claude, { installed: true });
  located = { terminal: null, native: null, reason: 'not_found' };
  assert.deepEqual(manager.getState().claude, { installed: false });
  const pending = manager.install('claude'); fake.children[0].emit('close', 0);
  assert.deepEqual((await pending).claude, { installed: true, version: '2.1.322', via: 'npm', fileShown: file }); assert.equal(refreshes, 1);
  // A failed install searches nothing; an isolated desktop check reads neither.
  const failed = manager.install('claude'); fake.children[1].emit('close', 1); await failed; assert.equal(refreshes, 1);
  assert.deepEqual(new AgentsManager({ env: { ...env, AGENTRIX_DATA_DIR: 'x' }, claude: () => assert.fail('not read') }).getState().claude, { installed: true });
});

test('an installed Claude Code that cannot run natively still reads as installed, with why, and a version split names the native copy', t => {
  const { env } = fixture(t), file = 'D:\\bin\\claude.exe';
  const old = { file, fileShown: file, version: '2.1.300', via: 'path' }, fresh = { file: 'D:\\new\\claude.exe', fileShown: 'D:\\new\\claude.exe', version: '2.1.322', via: 'npm' };
  const state = located => new AgentsManager({ env, claude: () => located }).getState().claude;
  assert.deepEqual(state({ terminal: null, native: null, reason: 'timeout', failure: { reason: 'timeout', found: file } }), { installed: true, reason: 'timeout' });
  assert.deepEqual(state({ terminal: old, native: null, reason: 'too_old', version: '2.1.300' }), { installed: true, version: '2.1.300', via: 'path', fileShown: file, reason: 'too_old' });
  assert.deepEqual(state({ terminal: null, native: null, reason: 'too_old', version: '2.1.100' }), { installed: true, version: '2.1.100', reason: 'too_old' }, 'an old JavaScript package');
  assert.deepEqual(state({ terminal: null, native: null, reason: 'not_found', incomplete: 'D:\\nodejs22\\node_modules\\@anthropic-ai\\claude-code' }), { installed: true, incomplete: true });
  assert.deepEqual(state({ terminal: null, native: null, reason: 'not_found' }), { installed: false });
  assert.deepEqual(state({ terminal: old, native: fresh, reason: 'cli_split_versions' }),
    { installed: true, version: '2.1.300', via: 'path', fileShown: file, notice: 'cli_split_versions', native: { version: '2.1.322', via: 'npm', fileShown: 'D:\\new\\claude.exe' } });
});
