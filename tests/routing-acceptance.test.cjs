const { test } = require('node:test');
const assert = require('node:assert/strict');
const { started, ended } = require('./helpers/dispatch-events.cjs');

test('routing acceptance reads scope, session and routing from JSON fields', async () => {
  const { readDispatchSignals } = await import('../scripts/routing-acceptance.mjs');
  const start = started('matched', 'codex', { session: 'session-key', model: 'routing ok',
    routing: { verdict: 'mismatch', declared: { model: 'fixture' }, unverified: [], fallback: false } });
  const end = ended('matched', 'scope', { scope: { state: 'out-of-scope', count: 1, files: ['src/scope ok/OUT OF SCOPE.md'] } });
  const signals = [start, ended('other'), end].map(event => JSON.stringify(event)).join('\r\n') + '\r\n';
  assert.deepEqual(readDispatchSignals(signals), { started: start, ended: end, session: 'session-key', routingOk: false, scope: end.scope });
  assert.throws(() => readDispatchSignals(JSON.stringify({ ...start, v: 2 })), { code: 'wire.unsupported_version' });
});
