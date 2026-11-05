const { test } = require('node:test');
const assert = require('node:assert/strict');
const { choosePath } = require('../electron/features/native-session/routing.cjs');
const { nextPath } = require('../electron/features/native-session/usage.cjs');

// Local Codex always uses app-server, including when old settings select the retired terminal view.
test('Codex stays on app-server whatever Claude\'s key, budget or limits say', () => {
  const claudeStates = [{}, { status: 'ready' }, { reason: 'no_key' }, { reason: 'budget_exhausted' }, { reason: 'credits_exhausted' }, { reason: 'rate_limited' }, { status: 'mismatch' }];
  for (const apiState of claudeStates) for (const claudePath of ['api-then-terminal', 'api-only', 'terminal-only']) {
    assert.deepEqual(choosePath({ agent: 'codex', claudePath, codexView: 'native', apiState }), { path: 'native', reason: null });
    assert.equal(nextPath('codex', { claudePath, codexView: 'native' }, apiState, { status: 'ok' }).path, 'native');
  }
});

test('legacy settings and missing executables never route Codex to a terminal', () => {
  assert.equal(choosePath({ agent: 'codex', codexView: 'terminal' }).path, 'native');
  assert.deepEqual(nextPath('codex', { codexView: 'terminal' }, {}, { status: 'ok' }), { path: 'native', reason: null });
  assert.deepEqual(nextPath('codex', { codexView: 'native' }, {}, { status: 'missing' }), { path: null, reason: 'cli_missing' });
});
