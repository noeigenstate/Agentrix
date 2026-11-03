const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRequests } = require('../electron/features/codex-app-server/requests.cjs');
const { assertCompatible } = require('../electron/features/codex-app-server/compatibility.cjs');

function fixture() {
  const writes = [], events = [], states = [];
  const api = createRequests({ respond: (id, result) => writes.push({ id, result }), reject: (id, code = -32601) => writes.push({ id, code }) },
    { binding: { providerSessionId: 'thread', turnId: 'turn' }, publish: (type, payload) => events.push({ type, payload }) }, state => states.push(state));
  const open = (method, params = {}, id = 1) => api.open({ method, id, params: { threadId: 'thread', turnId: 'turn', itemId: 'same-item', ...params } });
  return { api, open, events, writes, states };
}

test('same item approvals retain distinct RPC identities and old turn requests are rejected', () => {
  const f = fixture();
  f.open('item/commandExecution/requestApproval', { approvalId: 'one' }, 1);
  f.open('item/commandExecution/requestApproval', { approvalId: 'two' }, '1');
  const [a, b] = f.api.snapshot(); assert.notEqual(a.requestId, b.requestId);
  f.api.answer(b.requestId, { decision: 'deny' }); f.api.answer(a.requestId, { decision: 'allow' });
  assert.deepEqual(f.writes, [{ id: '1', result: { decision: 'decline' } }, { id: 1, result: { decision: 'accept' } }]);
  f.open('item/commandExecution/requestApproval', { turnId: 'old-turn' }, 3); assert.equal(f.writes.at(-1).code, -32601);
});

test('questions validate without consuming invalid answers, preserve secret metadata and never publish answers', () => {
  const f = fixture();
  f.open('item/tool/requestUserInput', { isBlocking: false, questions: [{ id: 'q', question: 'Synthetic question', isSecret: true, isOther: true }] });
  const request = f.api.snapshot()[0]; assert.equal(request.blocking, false); assert.equal(request.questions[0].isSecret, true);
  assert.throws(() => f.api.answer(request.requestId, { answers: { foreign: 'bad' } }), /invalid/); assert.equal(f.api.snapshot().length, 1);
  f.api.answer(request.requestId, { answers: { q: 'synthetic-answer' } });
  assert.deepEqual(f.writes[0].result, { answers: { q: { answers: ['synthetic-answer'] } } });
  assert.equal(JSON.stringify(f.events).includes('synthetic-answer'), false);
});

test('permissions grant only the requested profile and URL elicitation needs an explicit answer', () => {
  const f = fixture(), permissions = { network: { enabled: true }, fileSystem: null };
  f.open('item/permissions/requestApproval', { permissions }); f.api.answer(f.api.snapshot()[0].requestId, { decision: 'allow' });
  assert.deepEqual(f.writes[0].result, { permissions: { network: { enabled: true } }, scope: 'turn' });
  f.open('mcpServer/elicitation/request', { mode: 'url', url: 'https://example.invalid/authorize' }, 2);
  assert.equal(f.writes.length, 1); f.api.answer(f.api.snapshot()[0].requestId, { decision: 'deny' });
  assert.equal(f.writes[1].result.action, 'cancel');
});

test('MCP forms validate string enums and cancel unsupported form content', () => {
  const f = fixture();
  f.open('mcpServer/elicitation/request', { mode: 'form', requestedSchema: { type: 'object', properties: { pick: { type: 'string', enum: ['a', 'b'] } } } });
  const request = f.api.snapshot()[0];
  assert.throws(() => f.api.answer(request.requestId, { answers: { pick: 'c' } }), /invalid/);
  f.api.answer(request.requestId, { answers: { pick: 'a' } });
  assert.deepEqual(f.writes[0].result, { action: 'accept', content: { pick: 'a' }, _meta: null });
  f.open('mcpServer/elicitation/request', { mode: 'unknown' }, 2); f.api.cancelAll(); assert.equal(f.writes[1].result.action, 'cancel');
});

test('server resolution and stop expire tickets and unknown tool requests fail immediately', () => {
  const f = fixture();
  f.open('item/fileChange/requestApproval', {}, 5); const request = f.api.snapshot()[0]; f.api.resolved(5);
  assert.throws(() => f.api.answer(request.requestId, { decision: 'allow' }), /expired/);
  f.open('item/permissions/requestApproval', {}, 6); f.open('item/tool/requestUserInput', { questions: [] }, 7);
  f.api.cancelAll(); assert.deepEqual(f.api.snapshot(), []);
  assert.deepEqual(f.writes[0].result, { permissions: {}, scope: 'turn' }); assert.equal(f.writes[1].code, -32000);
  f.open('item/tool/call', {}, 8); assert.equal(f.writes.at(-1).code, -32601);
});

test('compatibility uses a tested CLI series, never a nonexistent protocol version', () => {
  assert.doesNotThrow(() => assertCompatible({ userAgent: 'codex_cli_rs/0.166.0 (synthetic)' }));
  assert.throws(() => assertCompatible({ userAgent: 'codex_cli_rs/0.1.0' }), /unsupported/);
  assert.throws(() => assertCompatible({ protocolVersion: 1 }), /unsupported/);
});
