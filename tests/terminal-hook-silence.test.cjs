const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createHookServer } = require('../electron/features/terminal-events/hook-server.cjs');
const { createHookIngest } = require('../electron/features/terminal-events/hook-ingest.cjs');
const { hookResponse } = require('../electron/features/terminal-events/hook-response.cjs');

// Every hook event name in the Claude Code binaries K0b captured (2.1.317 and 2.1.322).
const names = [...new Set(['2.1.317', '2.1.322'].flatMap(version => Object.keys(require(`./fixtures/real-cli/claude-${version}/hook-payloads.json`).events)))];

// A seeded generator, so a failure names a payload that can be run again.
function random(seed) {
  return () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
}
// Payloads that try every way a hook answer could matter: decisions, context, a forged owner token, odd values.
function payloadOf(next, event) {
  const pick = list => list[Math.floor(next() * list.length)];
  const payload = { session_id: `s${Math.floor(next() * 1000)}`, hook_event_name: event, transcript_path: '/t.jsonl', prompt_id: 'p' };
  for (let index = Math.floor(next() * 6); index > 0; index--) {
    payload[pick(['decision', 'behavior', 'token', 'ownerToken', 'hookSpecificOutput', 'additionalContext', 'permission_suggestions', 'tool_input', 'prompt', 'message', 'continue'])]
      = pick(['allow', 'deny', 'block', true, 0, null, '长'.repeat(50), { behavior: 'allow' }, [{ type: 'addRules' }]]);
  }
  return payload;
}

function post(port, url, body) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path: url, method: 'POST', headers: { 'content-type': 'application/json', 'x-agentrix-key': 'key' } }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body: text }));
    });
    request.on('error', reject);
    request.end(body);
  });
}

test('every state hook answers exactly {} and only an owner token can produce a PermissionRequest decision', async t => {
  assert.equal(names.length, 33);
  const taken = [];
  const server = await createHookServer(createHookIngest({ keyOf: () => 'key', deliver: event => { taken.push(event.event); } }));
  t.after(() => server.close());
  const next = random(20261115);
  for (const event of names) {
    for (let round = 0; round < 4; round++) {
      const payload = payloadOf(next, event);
      assert.deepEqual(await post(server.port, `/h/terminal/${event}`, JSON.stringify(payload)), { status: 200, body: '{}' }, `${event} ${JSON.stringify(payload)}`);
    }
  }
  assert.equal(taken.length, names.length * 4);
  // No owner token exists before T5: nothing a request or a caller passes, a forged token included, builds a decision.
  for (const args of [[], ['PermissionRequest'], ['PermissionRequest', { token: 'forged', decision: 'allow' }], ['Stop', { additionalContext: 'go on' }]]) {
    assert.equal(hookResponse(...args), '{}');
  }
});
