const { test } = require('node:test');
const assert = require('node:assert/strict');
const { agentCommand } = require('../electron/features/agents/agent-command.cjs');
const { commandRun, commandRows } = require('../src/features/reading/agent-command-run.ts');

test('a run of the CLI that is no conversation is told by its first word', () => {
  assert.equal(agentCommand('codex', 'update'), null);
  assert.equal(agentCommand('claude', 'update'), 'update');
  assert.equal(agentCommand('codex', '--version'), null);
  assert.equal(agentCommand('claude', '-p'), '-p');
  assert.equal(agentCommand('codex', 'login'), null);
  // A conversation: nothing, resume, a model option, a prompt.
  for (const word of [undefined, '', 'resume', 'fork', '--model', '-m', 'hello', '修复登录页', '--update; rm -rf /']) assert.equal(agentCommand('codex', word), null, String(word));
  assert.equal(agentCommand('claude', '--resume'), null);
  assert.equal(agentCommand('claude', 'exec'), null, "Claude Code has no exec");
});

test('the reading view names the run and shows what came after its command line', () => {
  assert.deepEqual(commandRun('update'), { title: '正在更新 {agent}…', working: true });
  assert.deepEqual(commandRun('--version'), { title: '{agent} 的版本', working: false });
  assert.deepEqual(commandRun('sandbox'), { title: '正在运行 {agent} {command}…', working: true });
  const rows = ['PS C:\work> codex update', 'Checking for updates…', 'Downloading codex 0.163.0', '', '', ''];
  assert.deepEqual(commandRows(rows, 'codex', 'update'), ['Checking for updates…', 'Downloading codex 0.163.0']);
  assert.deepEqual(commandRows(['$ claude --version', '2.1.296 (Claude Code)'], 'claude', '--version'), ['2.1.296 (Claude Code)']);
  assert.deepEqual(commandRows(['a', '', 'b', ''], 'codex', 'update'), ['a', '', 'b'], 'the last rows when the command line scrolled away');
  // Output at the top of a tall screen, blank rows under it: the output, not the blank rows.
  assert.deepEqual(commandRows(['Checking', 'Downloading', ...Array(50).fill('')], 'codex', 'update'), ['Checking', 'Downloading']);
});
