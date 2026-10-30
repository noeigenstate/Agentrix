const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseAgentScreen } = require('../src/features/agents/agent-screen.ts');
const { cliDialogShown, isAtPrompt } = require('../src/features/reading/cli-panel.ts');
const read = name => fs.readFileSync(path.join(__dirname, 'fixtures/screens', name + '.txt'), 'utf8').split('\n');

test('plan transitions and MCP browser actions are informative permission choices', () => {
  for (const [agent, name, title, labels] of [
    ['claude', 'claude-investigation-plan', 'Exit plan mode?', ['Yes, and switch to default (ask each time) for this session', 'No']],
    ['codex', 'codex-investigation-plan-complete', 'Implement this plan?', ['Yes, implement this plan', 'Yes, clear context and implement', 'No, stay in Plan mode']],
    ['claude', 'claude-investigation-mcp-url', 'MCP server “localprobe” wants to open a URL', ['Accept', 'Decline']],
    ['codex', 'codex-investigation-mcp-url', 'Action required', ['Open link', 'Back']],
    ['codex', 'codex-investigation-mcp-tool-approval', 'Allow the localprobe MCP server to run tool "choice_probe"?', ['Allow', 'Allow for this session', 'Always allow', 'Cancel']],
  ]) {
    const rows = read(name), screen = parseAgentScreen(agent, rows);
    assert.equal(screen.choice?.kind, 'permission', name);
    assert.equal(screen.choice.title, title, name);
    assert.deepEqual(screen.choice.options.map(option => option.label), labels, name);
    assert.equal(screen.waiting, undefined, name);
    assert.equal(cliDialogShown(agent, rows, screen), true, name);
  }
});

test('horizontal Claude URL choices reflect Decline focus without becoming interactive questions', () => {
  const rows = read('claude-investigation-mcp-url').map(row => row.replace('❯ Accept    Decline', '  Accept  ❯ Decline'));
  const screen = parseAgentScreen('claude', rows);
  assert.equal(screen.choice?.kind, 'permission');
  assert.deepEqual(screen.choice.options.map(option => option.selected), [false, true]);
  assert.equal(screen.choice.question, undefined);
});

test('unmapped MCP fields, nested radio controls and tall clipped questions explicitly wait', () => {
  for (const [agent, name, title] of [
    ['claude', 'claude-investigation-mcp-form', 'MCP server “localprobe” requests your input'],
    ['claude', 'claude-investigation-mcp-form-field', 'MCP server “localprobe” requests your input'],
    ['codex', 'codex-investigation-mcp-form', 'Local MCP choice form'],
    ['claude', 'claude-investigation-tall', null],
  ]) {
    const rows = read(name), screen = parseAgentScreen(agent, rows);
    assert.equal(screen.choice, null, name);
    assert.deepEqual(screen.waiting, { title }, name);
    assert.equal(cliDialogShown(agent, rows, screen), true, name);
    assert.equal(isAtPrompt(agent, rows, screen), false, name);
  }
});

test('waiting is evidence of live dialog controls, never silence, ordinary prose, or working/idle footers', () => {
  for (const agent of ['claude', 'codex']) {
    const input = agent === 'claude' ? ['────', '❯ ', '────', '  ⏸ manual mode on'] : ['› ', '', '  GPT-6-Sol medium · C:\\work\\demo'];
    for (const rows of [[], ['A question about a plan?'], ['1. First', '2. Second'], ['The documentation says Esc to cancel'],
      ['Esc to cancel'], ['• Working (5s · esc to interrupt)'], ['✻ Worked for 5s', ...input],
      ['Enter to select · Esc to cancel', ...input], ['────', '❯ quote', '  Enter to select · Esc to cancel', '────', '  ⏸ manual mode on']]) {
      const screen = parseAgentScreen(agent, rows);
      assert.equal(screen.waiting, undefined, `${agent}: ${rows.join(' / ')}`);
    }
    const rows = ['Unfamiliar choice', 'tab to switch · enter to select · esc to cancel'];
    assert.deepEqual(parseAgentScreen(agent, rows).waiting, { title: null });
  }
});

test('a later answer or returned input dismisses every captured dialog and waiting signal', () => {
  for (const name of ['claude-investigation-review', 'claude-investigation-plan', 'claude-investigation-mcp-url',
    'claude-investigation-mcp-form-field', 'claude-investigation-tall', 'codex-investigation-mcp-form', 'codex-investigation-plan-complete']) {
    const agent = name.startsWith('claude') ? 'claude' : 'codex';
    for (const suffix of [['● User answered'], agent === 'claude' ? ['────', '❯ ', '────', '  ⏸ manual mode on'] : ['› ', '', '  GPT-6-Sol medium · C:\\work\\demo']]) {
      const screen = parseAgentScreen(agent, [...read(name), ...suffix]);
      assert.equal(screen.choice, null, name);
      assert.equal(screen.waiting, undefined, name);
    }
  }
});
