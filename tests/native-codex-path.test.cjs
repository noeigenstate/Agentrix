const { test } = require('node:test');
const assert = require('node:assert/strict');
const { choosePath } = require('../electron/features/native-session/routing.cjs');
const { nextPath } = require('../electron/features/native-session/usage.cjs');

// The owner's rule: Claude's API, budget and quota rules do not apply to Codex. Only the owner's setting or a runner that cannot start moves it.
test('Codex stays on app-server whatever Claude\'s key, budget or limits say', () => {
  const claudeStates = [{}, { status: 'ready' }, { reason: 'no_key' }, { reason: 'budget_exhausted' }, { reason: 'credits_exhausted' }, { reason: 'rate_limited' }, { status: 'mismatch' }];
  for (const apiState of claudeStates) for (const claudePath of ['api-then-terminal', 'api-only', 'terminal-only']) {
    assert.deepEqual(choosePath({ agent: 'codex', claudePath, codexView: 'native', apiState }), { path: 'native', reason: null });
    assert.equal(nextPath('codex', { claudePath, codexView: 'native' }, apiState, { status: 'ok' }).path, 'native');
  }
});

test('only the owner\'s setting or a missing runner takes Codex to the terminal', () => {
  assert.equal(choosePath({ agent: 'codex', codexView: 'terminal' }).path, 'terminal');
  assert.deepEqual(nextPath('codex', { codexView: 'terminal' }, {}, { status: 'ok' }), { path: 'terminal', reason: 'set_terminal' });
  assert.deepEqual(nextPath('codex', { codexView: 'native' }, {}, { status: 'missing' }), { path: 'terminal', reason: 'cli_missing' });
});
