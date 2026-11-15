const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createHookServer, BODY_LIMIT } = require('../electron/features/terminal-events/hook-server.cjs');
const { createHookIngest } = require('../electron/features/terminal-events/hook-ingest.cjs');

// One hook request the way Claude Code sends it: POST with the key header and the hook's JSON.
function post(port, url, body, key = 'key') {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path: url, method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { 'x-agentrix-key': key } : {}) } }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body: text }));
    });
    request.on('error', reject);
    request.end(body);
  });
}

test('the reply is written before ingest runs: an ingest that never settles never delays it', async t => {
  const order = [], end = http.ServerResponse.prototype.end;
  http.ServerResponse.prototype.end = function (...args) { order.push('reply'); return end.apply(this, args); };
  t.after(() => { http.ServerResponse.prototype.end = end; });
  const ingest = { admit: () => { order.push('admit'); return true; }, take: (...args) => { order.push(['take', ...args]); return new Promise(() => {}); } };
  const server = await createHookServer(ingest);
  t.after(() => server.close());
  const body = JSON.stringify({ session_id: 's', hook_event_name: 'Stop' });
  assert.deepEqual(await post(server.port, '/h/terminal/Stop', body), { status: 200, body: '{}' });
  // The CLI's next hook is answered too, while the first ingest is still pending.
  assert.deepEqual(await post(server.port, '/h/terminal/UserPromptSubmit', '{}'), { status: 200, body: '{}' });
  assert.deepEqual(order, ['admit', 'reply', ['take', 'terminal', 'Stop', body], 'admit', 'reply', ['take', 'terminal', 'UserPromptSubmit', '{}']]);
});

test('an event over 4 MB is answered {} and still taken from its URL, counted as oversize', async t => {
  const events = [];
  const ingest = createHookIngest({ keyOf: id => id === 'terminal' ? 'key' : null, deliver: event => { events.push(event); }, now: () => 5 });
  const server = await createHookServer(ingest);
  t.after(() => server.close());
  const big = JSON.stringify({ session_id: 's', tool_use_id: 'tool', tool_response: 'x'.repeat(BODY_LIMIT) });
  assert.deepEqual(await post(server.port, '/h/terminal/PostToolUse', big), { status: 200, body: '{}' });
  assert.deepEqual(events, [{ seq: 1, terminalId: 'terminal', event: 'PostToolUse', at: 5, sessionId: '', transcriptPath: '', promptId: null, toolUseId: null, agentId: null, payload: {} }]);
  assert.equal(ingest.stats().oversize, 1);
  assert.equal(ingest.stats().received, 1);
});

test('a wrong key, an unknown terminal and a stray path get 404 and are counted, never ingested', async t => {
  const events = [];
  const ingest = createHookIngest({ keyOf: id => id === 'terminal' ? 'key' : null, deliver: event => { events.push(event); }, now: () => 7 });
  const server = await createHookServer(ingest);
  t.after(() => server.close());
  const payload = JSON.stringify({ session_id: 's', transcript_path: '/t/s.jsonl', prompt_id: 'p', prompt: 'Do it', tool_input: { file: 'a' } });
  for (const [url, key] of [['/h/terminal/Stop', 'wrong'], ['/h/terminal/Stop', null], ['/h/other/Stop', 'key'], ['/h/terminal', 'key'], ['/elsewhere', 'key']]) {
    assert.deepEqual(await post(server.port, url, payload, key), { status: 404, body: '{}' }, url);
  }
  assert.deepEqual(events, []);
  assert.deepEqual(ingest.stats().refused, { path: 2, terminal: 1, key: 2 });
  assert.deepEqual(await post(server.port, '/h/terminal/UserPromptSubmit', payload), { status: 200, body: '{}' });
  // Only plain fields are kept; tool input stays in the transcript.
  assert.deepEqual(events, [{ seq: 1, terminalId: 'terminal', event: 'UserPromptSubmit', at: 7, sessionId: 's', transcriptPath: '/t/s.jsonl', promptId: 'p', toolUseId: null, agentId: null,
    payload: { session_id: 's', transcript_path: '/t/s.jsonl', prompt_id: 'p', prompt: 'Do it' } }]);
  assert.equal(ingest.stats().events.UserPromptSubmit, 1);
  assert.equal(ingest.stats().lastEventAt, 7);
});

test('an unreadable body or a failing consumer is counted and the next event still arrives', async () => {
  const events = [];
  let fail = true;
  const ingest = createHookIngest({ keyOf: () => 'key', deliver: event => { if (fail) { fail = false; throw new Error('consumer'); } events.push(event.event); } });
  ingest.take('t', 'Stop', 'not json');
  ingest.take('t', 'Notification', '[1]');
  assert.deepEqual(events, ['Notification']);
  assert.equal(ingest.stats().unparsable, 1);
  assert.equal(ingest.stats().failed, 1);
  ingest.take('t', 'constructor', '{}');
  assert.equal(ingest.stats().events.constructor, 1);
});
