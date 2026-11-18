const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createTerminalEnvironment } = require('../electron/terminal-env.cjs');

for (const fast of [true, false, undefined]) test(`terminal launch fast=${fast} preserves base hooks and writes the launch choice separately`, t => {
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const { writeBootstrap } = require('../electron/features/terminal-events/bootstrap-file.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fast-hooks-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'bootstrap.json'), hooks = { settings: {
    http: JSON.stringify({ hooks: { SessionStart: ['session'], Stop: ['http'] } }),
    fallback: JSON.stringify({ hooks: { SessionStart: ['session'], Stop: ['command'] } }) } };
  const before = JSON.stringify(hooks);
  const source = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
  const terminal = source.indexOf('function startTerminal(');
  const start = source.indexOf('  if (hooks) {', terminal), end = source.indexOf('  if (bootstrapFile) writeBootstrap', start);
  require('node:vm').runInNewContext(source.slice(start, end), { hooks, env: {} });
  assert.equal(JSON.stringify({ settings: hooks.settings }), before);
  writeBootstrap({ file, eventServer: { name: 'injected', address: 'injected' }, hooks,
    lead: fast === undefined ? null : { model: 'opus', effort: 'high', fast } });
  assert.equal(fs.readFileSync(file + '.lead', 'utf8'), fast === undefined ? '' : `opus\nhigh\n${fast ? 1 : 0}\n`);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const channel of ['http', 'fallback']) {
    const settings = JSON.parse(saved.hooks.settings[channel]);
    assert.equal(settings.fastMode, undefined); assert.deepEqual(settings.hooks.SessionStart, ['session']);
    assert.equal(settings.hooks.Stop[0], channel === 'http' ? 'http' : 'command');
    assert.equal(hooks.settings[channel], saved.hooks.settings[channel]);
    assert.equal(JSON.parse(saved.hooks.fastSettings[channel]).fastMode, true);
  }
});

test('a terminal drops inherited SDK entrypoints in every letter case', () => {
  const env = createTerminalEnvironment({ CLAUDE_CODE_ENTRYPOINT: 'agentrix-sdk', claude_code_entrypoint: 'agentrix-sdk' }, 'fake-bootstrap');
  assert.equal(Object.keys(env).some(name => name.toUpperCase() === 'CLAUDE_CODE_ENTRYPOINT'), false);
});

test('a terminal drops an inherited Claude Code or Codex choice: only main tells a terminal which one to run', () => {
  const env = createTerminalEnvironment({ AGENTRIX_CLAUDE_EXECUTABLE: 'C:\\old\\claude.exe', agentrix_claude_executable: '/old/claude',
    AGENTRIX_CODEX_EXECUTABLE: 'D:\\old\\codex.cmd', Agentrix_Codex_Executable: '/old/codex' }, 'fake-bootstrap');
  for (const name of ['AGENTRIX_CLAUDE_EXECUTABLE', 'AGENTRIX_CODEX_EXECUTABLE']) assert.equal(Object.keys(env).some(key => key.toUpperCase() === name), false, name);
});

test('PTYs advertise color support even when launched by a monochrome host', () => {
  const source = Object.freeze({ NO_COLOR: '1', NODE_DISABLE_COLORS: '1', TERM: 'dumb', COLORTERM: '', CLICOLOR: '0', FORCE_COLOR: '0', PATH: 'existing-path' });
  const env = createTerminalEnvironment(source, 'session.json');
  assert.equal(env.NO_COLOR, undefined);
  assert.equal(env.NODE_DISABLE_COLORS, undefined);
  assert.equal(env.FORCE_COLOR, undefined);
  assert.equal(env.TERM, 'xterm-256color');
  assert.equal(env.COLORTERM, 'truecolor');
  assert.equal(env.CLICOLOR, '1');
  assert.equal(env.TERM_PROGRAM, 'agentrix');
  assert.equal(env.PATH, 'existing-path');
  assert.equal(source.NO_COLOR, '1');
});

test('Windows environment casing cannot leave duplicate color-disabling variables', () => {
  const env = createTerminalEnvironment({ No_Color: '1', Node_Disable_Colors: '1', Term: 'dumb', ColorTerm: '', CliColor: '0', Force_Color: 'false', AGENTRIX_DATA_DIR: 'test-data', ELECTRON_RUN_AS_NODE: '1' }, 'bootstrap.json');
  assert.deepEqual(Object.keys(env).sort(), ['CLICOLOR', 'COLORTERM', 'AGENTRIX_BOOTSTRAP', 'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS', 'TERM', 'TERM_PROGRAM'].sort());
});

test('unrelated environment values and positive color preferences are preserved', () => {
  const env = createTerminalEnvironment({ FORCE_COLOR: '3', LANG: 'zh_CN.UTF-8', SystemRoot: 'C:\\Windows', SSH_AUTH_SOCK: 'socket' }, 'bootstrap.json');
  assert.equal(env.FORCE_COLOR, '3');
  assert.equal(env.LANG, 'zh_CN.UTF-8');
  assert.equal(env.SSH_AUTH_SOCK, 'socket');
  assert.equal(env.AGENTRIX_BOOTSTRAP, 'bootstrap.json');
});

test('a terminal starts Claude Code without background tasks by default; the Settings switch removes the variable, even an inherited one, and process.env is never changed', () => {
  const { claudeBackgroundEnvironment } = require('../electron/shared/claude-background.cjs');
  const name = 'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS', before = process.env[name], source = Object.freeze({ PATH: 'p' });
  assert.equal(createTerminalEnvironment(source, 'b.json')[name], '1', 'default: off');
  assert.equal(createTerminalEnvironment(source, 'b.json', { allowBackgroundTasks: false })[name], '1');
  for (const inherited of [{ [name]: '1' }, { claude_code_disable_background_tasks: '1' }, { [name]: '0' }]) {
    const on = createTerminalEnvironment({ PATH: 'p', ...inherited }, 'b.json', { allowBackgroundTasks: true });
    assert.equal(Object.keys(on).some(key => key.toUpperCase() === name), false, JSON.stringify(inherited));
    assert.equal(on.PATH, 'p');
    const off = createTerminalEnvironment({ PATH: 'p', ...inherited }, 'b.json');
    assert.equal(Object.keys(off).filter(key => key.toUpperCase() === name).length, 1, 'one spelling only');
    assert.equal(off[name], '1');
  }
  const input = Object.freeze({ A: '1', [name]: 'keep' });
  assert.deepEqual(claudeBackgroundEnvironment(input, true), { A: '1' });
  assert.deepEqual(claudeBackgroundEnvironment(input), { A: '1', [name]: '1' });
  assert.equal(process.env[name], before, 'process.env untouched');
});

test('the variable reaches Claude Code workers and native sessions: the dispatch and SDK environments keep it', () => {
  const name = 'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS', terminal = createTerminalEnvironment({ PATH: 'p' }, 'b.json');
  assert.equal(require('../electron/features/codex-app-server/environment.cjs').workerEnvironment({ ...terminal, AGENTRIX_SDK_PARENT: '1' })[name], '1');
  assert.equal(require('../electron/features/claude-sdk/credentials.cjs').apiEnvironment(terminal, 'sk-ant-fixture-key-0000', 'dispatch')[name], '1');
  assert.equal(require('../electron/features/claude-sdk/credentials.cjs').apiEnvironment(terminal, 'sk-ant-fixture-key-0000', 'gui')[name], '1');
});
