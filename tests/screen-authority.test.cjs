const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { defineMain } = require('./helpers/main-modules.cjs');
const { cliStateFor } = require('../src/features/agents/agent-screen-state.ts');

// Deliver a hook after the input frame was drawn, through the real host publisher and renderer authority rule.
function permission(sentAt, hookEvent = 'PermissionRequest') {
  const s = { terminalId: 't', sessionId: 'pty', agent: 'claude', codexActive: true, activitySince: 1000,
    claudeSessionId: 'provider', promptQueue: { list: () => [] } };
  const context = vm.createContext({ sessions: new Map([['t', s]]), broadcast() {}, Date: class extends Date { static now() { return 2100; } } });
  defineMain(context, 'publishCliState', 'claudeActivity');
  context.claudeActivity({ kind: 'local' }, s, { state: 'attention', sessionId: 'provider', eventId: 'provider:permission', sentAt, hookEvent, message: 'Approve' });
  const terminal = { id: 't', sessionId: 'pty', agent: 'claude', codexActive: true, cliState: s.cliState, needsInput: s.needsInput.message };
  const frame = { sessionId: 'pty', revision: 2, updatedAt: 2090, stateUpdatedAt: { claude: 2050 }, rows: ['────', '❯ ', '────'] };
  return { terminal, frame, state: () => cliStateFor('claude', frame, terminal) };
}

test('a permission sent before the answered input frame cannot keep that frame waiting on late arrival', () => {
  for (const hookEvent of ['PermissionRequest', 'Notification']) {
    const h = permission(2010, hookEvent);
    assert.equal(h.terminal.cliState.state, 'waiting', 'the key and screen do not rewrite the host signal');
    assert.equal(h.state().waiting, false); assert.equal(h.state().canDeliver, true);
  }
});

test('a permission genuinely sent after the input frame still wins on late arrival', () => {
  const h = permission(2060);
  assert.equal(h.state().waiting, true); assert.equal(h.state().canDeliver, false);
  assert.equal(h.state().message, 'Approve');
});

test('an equal-time or cached input frame cannot supersede a permission hook', () => {
  const h = permission(2050);
  assert.equal(h.state().waiting, true, 'the screen must be strictly newer');
  h.frame.updatedAt = 2200;
  assert.equal(h.state().waiting, true, 'unrelated drawing does not advance the state-change time');
});

test('an input frame of another PTY session cannot supersede a permission hook', () => {
  const h = permission(2010); h.frame.sessionId = 'previous-pty';
  assert.equal(h.state().waiting, true); assert.equal(h.state().canDeliver, false);
});
