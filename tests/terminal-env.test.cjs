const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createTerminalEnvironment } = require('../electron/terminal-env.cjs');

test('a terminal drops inherited SDK entrypoints in every letter case', () => {
  const env = createTerminalEnvironment({ CLAUDE_CODE_ENTRYPOINT: 'agentrix-sdk', claude_code_entrypoint: 'agentrix-sdk' }, 'fake-bootstrap');
  assert.equal(Object.keys(env).some(name => name.toUpperCase() === 'CLAUDE_CODE_ENTRYPOINT'), false);
});

test('a terminal drops an inherited Claude Code choice: only main tells a terminal which one to run', () => {
  const env = createTerminalEnvironment({ AGENTRIX_CLAUDE_EXECUTABLE: 'C:\\old\\claude.exe', agentrix_claude_executable: '/old/claude' }, 'fake-bootstrap');
  assert.equal(Object.keys(env).some(name => name.toUpperCase() === 'AGENTRIX_CLAUDE_EXECUTABLE'), false);
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
  assert.deepEqual(Object.keys(env).sort(), ['CLICOLOR', 'COLORTERM', 'AGENTRIX_BOOTSTRAP', 'TERM', 'TERM_PROGRAM'].sort());
});

test('unrelated environment values and positive color preferences are preserved', () => {
  const env = createTerminalEnvironment({ FORCE_COLOR: '3', LANG: 'zh_CN.UTF-8', SystemRoot: 'C:\\Windows', SSH_AUTH_SOCK: 'socket' }, 'bootstrap.json');
  assert.equal(env.FORCE_COLOR, '3');
  assert.equal(env.LANG, 'zh_CN.UTF-8');
  assert.equal(env.SSH_AUTH_SOCK, 'socket');
  assert.equal(env.AGENTRIX_BOOTSTRAP, 'bootstrap.json');
});
