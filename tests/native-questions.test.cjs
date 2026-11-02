const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, until } = require('./native-approvals.test.cjs');
const { CodexProtocol } = require('../electron/features/terminal/native-protocol.cjs');

for (const [method, params, result] of [
  ['item/tool/requestUserInput', { threadId: 'thread', turnId: 'turn', itemId: 'item', questions: [{ id: 'q', question: 'Pick one', options: [{ label: 'One' }, { label: 'Two' }] }] }, { answers: { q: { answers: ['Two'] } } }],
  ['mcpServer/elicitation/request', { threadId: 'thread', serverName: 'fixture', mode: 'form', message: 'A form', requestedSchema: { type: 'object', properties: { ready: { type: 'boolean' } } } }, { action: 'accept', content: { ready: false } }],
  ['mcpServer/elicitation/request', { threadId: 'thread', serverName: 'fixture', mode: 'url', url: 'https://example.invalid', elicitationId: 'url' }, { action: 'decline' }],
  ['future/provider/question', { threadId: 'thread', schema: { unfamiliar: true } }, { futureAnswer: ['kept', false, 0] }],
]) {
  test(method + ': the request and TUI reply cross the actual proxy unchanged, with no host answer', async t => {
    const h = await fixture(t), frame = { id: method, method, params }; h.emit(frame);
    await until(() => h.messages.some(m => m.id === method)); assert.deepEqual(h.messages.find(m => m.id === method), frame);
    assert.equal(h.messages.some(m => m.method === 'fixture/received'), false);
    h.socket.send(JSON.stringify({ id: method, result }));
    await until(() => h.messages.some(m => m.method === 'fixture/received'));
    assert.deepEqual(h.messages.find(m => m.method === 'fixture/received').params, { id: method, result });
    assert.deepEqual(h.writes, []);
  });
}

test('a provider resolution revokes only that request; the host never fabricates a replacement', () => {
  const p = new CodexProtocol();
  for (const id of ['a', 'b']) p.server({ id, method: 'future/question', params: { threadId: 'thread' } });
  p.server({ method: 'serverRequest/resolved', params: { requestId: 'a', threadId: 'thread' } });
  assert.equal(p.client({ id: 'a', result: {} }), false); assert.equal(p.client({ id: 'b', result: {} }), true);
});
