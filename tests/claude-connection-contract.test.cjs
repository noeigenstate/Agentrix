// R2 contract: the connection test and a new session in the same project take their path from the same facts, so they
// agree. Fakes only: no real API, CLI or ~/.claude.
require('./fixtures/team-isolation.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { routeFixture } = require('./fixtures/claude-route.cjs');

const MODES = ['api-then-terminal', 'api-only', 'terminal-only'];
const CLIS = [{ status: 'ok', version: '2.1.318' }, { status: 'missing', reason: 'not_found' }, { status: 'too_old', version: '2.1.300' },
  { status: 'missing', reason: 'timeout', found: 'claude.exe' }];
const BILLING = ['ANTHROPIC_API_KEY', '/login managed key'];

test('the connection test and a new session choose the same path and billing for every fact set', async t => {
  for (const mode of MODES) for (const key of ['ok', 'missing', 'invalid', 'credits']) for (const cli of CLIS) for (const billing of BILLING) {
    const label = JSON.stringify({ mode, key, cli: cli.reason || cli.status, billing });
    const f = routeFixture(t, { mode, key, cli, billing });
    const tested = await f.native.testConnection('p'), queries = f.fake.calls.length;
    const session = await f.newSession('n');
    assert.equal(session.path, tested.path, `${label}: the same path`);
    if (tested.path === 'api') {
      // The test confirmed this key bills the session: its first message is accepted on the API.
      assert.equal(tested.billing.status, 'ok', label);
      const receipt = await f.native.send('n', session.runtimeSessionId, { clientMessageId: 'm', text: 'synthetic only' });
      assert.notEqual(receipt.status, 'rejected', label);
    } else {
      // A session the test keeps off the API asks Claude Code nothing, and both say why.
      assert.equal(f.fake.calls.length, queries, `${label}: no SDK query`);
      assert.ok(tested.reason, `${label}: the test says why`);
      assert.ok(session.reason, `${label}: the session says why`);
    }
  }
});

test('an answer the connection test could not get is told by the test and never held for the next session', async t => {
  const f = routeFixture(t, { key: 'unreachable' });
  const tested = await f.native.testConnection('p');
  assert.equal(tested.path, 'terminal'); assert.equal(tested.reason, '无法连接 Anthropic API。');
  assert.equal((await f.newSession('n')).path, 'api', 'an unreachable API is not a fact about the key');
});
