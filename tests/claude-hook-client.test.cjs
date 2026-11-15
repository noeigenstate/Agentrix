// The test-side hook client speaks contract C-2: an HTTP terminal gets a keyed POST per event, a command terminal gets the
// hook script, and SessionStart is always the script. Every smoke and probe that reports a Claude hook goes through it.
require('./fixtures/team-isolation.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { EventEmitter } = require('node:events');
const { KIND_OF_EVENT, HTTP_ONLY_EVENTS, MAX_BODY_BYTES, resolveHook, sendHook, hookText, postHook, startHookReceiver } = require('./helpers/claude-hook-client.cjs');

const command = { powershellPath: 'powershell.exe', claudeHookPath: 'claude-hook.ps1', pipeName: 'pipe', projectId: 'project', sessionKey: 'session' };

// A process that records how it was started and what it was given on its input, and exits when told.
function fakeSpawn() {
  const started = [];
  const spawn = (file, args) => {
    const child = new EventEmitter(), input = [];
    child.stdin = { end: text => { input.push(text); queueMicrotask(() => child.emit('exit', 0)); } };
    started.push({ file, args, input });
    return child;
  };
  return { spawn, started };
}

test('every hook event maps to the legacy kind of contract C-2, and the events with no kind are HTTP only', () => {
  assert.deepEqual(KIND_OF_EVENT, {
    UserPromptSubmit: 'start', Stop: 'stop', Notification: 'notify', SessionStart: 'session',
    PreToolUse: 'progress', PostToolUse: 'progress', PostToolUseFailure: 'progress', PermissionDenied: 'progress', ElicitationResult: 'progress',
    PermissionRequest: 'permission', Elicitation: 'permission' });
  assert.deepEqual(resolveHook('start'), { event: 'UserPromptSubmit', kind: 'start' });
  assert.deepEqual(resolveHook('Stop'), { event: 'Stop', kind: 'stop' });
  assert.deepEqual(resolveHook('progress', { hook_event_name: 'PostToolUseFailure' }), { event: 'PostToolUseFailure', kind: 'progress' });
  assert.deepEqual(resolveHook('progress', { hook_event_name: 'Stop' }), { event: 'PostToolUse', kind: 'progress' }, 'a payload naming another kind does not change the event');
  for (const event of HTTP_ONLY_EVENTS) assert.deepEqual(resolveHook(event), { event, kind: null });
  assert.throws(() => resolveHook('finish'), /Unknown hook kind or event/);
});

test('an HTTP terminal gets a keyed POST per event and the answer is 200 with {}', async t => {
  const receiver = await startHookReceiver({ terminalId: 'terminal-7', key: 'secret' });
  t.after(() => receiver.close());
  const bootstrap = { ...command, hooks: receiver.hooks };
  assert.deepEqual(await sendHook(bootstrap, 'start', { session_id: 's1', prompt: 'go' }), { channel: 'http', status: 200, body: '{}' });
  assert.deepEqual(await sendHook(bootstrap, 'PreToolUse', { session_id: 's1', tool_name: 'Read' }), { channel: 'http', status: 200, body: '{}' });
  assert.deepEqual(receiver.accepted.map(({ seq, event }) => [seq, event]), [[1, 'UserPromptSubmit'], [2, 'PreToolUse']]);
  assert.equal(receiver.accepted[0].headers['x-agentrix-key'], 'secret');
  assert.deepEqual(receiver.accepted[0].payload, { hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'go' });
  assert.match(receiver.hooks.url, /^http:\/\/127\.0\.0\.1:\d+\/h\/terminal-7$/);
});

test('a wrong key or an unknown terminal gets 404 and is counted with its reason, never dropped', async t => {
  const receiver = await startHookReceiver({ terminalId: 'terminal-7', key: 'secret' });
  t.after(() => receiver.close());
  assert.equal((await postHook({ ...receiver.hooks, key: 'other' }, 'Stop', {})).status, 404);
  assert.equal((await postHook({ ...receiver.hooks, url: receiver.hooks.url.replace('terminal-7', 'terminal-8') }, 'Stop', {})).status, 404);
  assert.deepEqual(receiver.rejected.map(item => item.reason), ['bad_key', 'unknown_terminal']);
  assert.deepEqual(receiver.accepted, []);
});

test('a body over 4 MB is refused by the client, and when it is sent anyway the receiver still answers 200 with {} and counts it as oversize', async t => {
  const receiver = await startHookReceiver({ terminalId: 'terminal-7', key: 'secret' });
  t.after(() => receiver.close());
  assert.throws(() => postHook(receiver.hooks, 'Stop', { text: 'x'.repeat(MAX_BODY_BYTES) }), /at most 4194304 bytes/);
  const oversized = JSON.stringify({ text: 'x'.repeat(MAX_BODY_BYTES) });
  const reply = await new Promise((resolve, reject) => {
    const request = http.request(`${receiver.hooks.url}/Stop`, { method: 'POST', agent: false, headers: { 'x-agentrix-key': 'secret' } }, response => {
      let body = ''; response.setEncoding('utf8'); response.on('data', chunk => { body += chunk; }); response.once('end', () => resolve({ status: response.statusCode, body }));
    });
    request.once('error', reject); request.end(oversized);
  });
  assert.deepEqual(reply, { status: 200, body: '{}' });
  assert.deepEqual(receiver.accepted.map(({ terminalId, event, payload, oversize }) => ({ terminalId, event, payload, oversize })), [{ terminalId: 'terminal-7', event: 'Stop', payload: {}, oversize: true }]);
  assert.deepEqual(receiver.stats, { events: 1, oversize: 1 });
  assert.deepEqual(receiver.rejected, []);
  // A wrong key is still 404 and is not counted as an event.
  const wrong = await postHook({ ...receiver.hooks, key: 'other' }, 'Stop', {});
  assert.equal(wrong.status, 404);
  assert.deepEqual(receiver.stats, { events: 1, oversize: 1 });
});

test('SessionStart, a command terminal and a command-async terminal go to the hook script with the kind and the JSON on its input', async () => {
  for (const [hooks, name, expected] of [[{ channel: 'http' }, 'session', 'session'], [{ channel: 'command' }, 'start', 'start'], [{ channel: 'command-async' }, 'Stop', 'stop'], [undefined, 'notify', 'notify']]) {
    const { spawn, started } = fakeSpawn();
    const result = await sendHook({ ...command, hooks }, name, { session_id: 's1' }, { spawn });
    assert.deepEqual(result, { channel: 'command', code: 0 });
    assert.equal(started.length, 1);
    assert.equal(started[0].file, 'powershell.exe');
    assert.deepEqual(started[0].args, ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'claude-hook.ps1', '-PipeName', 'pipe', '-ProjectId', 'project', '-SessionKey', 'session', '-Kind', expected]);
    assert.deepEqual(started[0].input, ['{"session_id":"s1"}']);
  }
});

test('an HTTP-only event cannot be sent to a command terminal, and nothing is started', async () => {
  const { spawn, started } = fakeSpawn();
  await assert.rejects(sendHook({ ...command, hooks: { channel: 'command' } }, 'SubagentStart', {}, { spawn }), /no command hook/);
  assert.deepEqual(started, []);
});

test('an abort signal ends a hook the server never answers, once the request has arrived', async t => {
  const server = http.createServer(); t.after(() => { server.closeAllConnections(); server.close(); });
  const arrived = once(server, 'request');
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const abort = new AbortController();
  const sent = postHook({ url: `http://127.0.0.1:${server.address().port}/h/t`, key: 'k' }, 'PermissionRequest', {}, { signal: abort.signal });
  await arrived; abort.abort();
  await assert.rejects(sent, { name: 'AbortError' });
});

test('typed into a terminal, a hook picks the channel from the terminal\'s own session and quotes the JSON', () => {
  const text = hookText('start', { prompt: "it's \"quoted\"", session_id: 's1' });
  assert.match(text, /\$global:AgentrixSession\.hooks\.channel -eq 'http'/);
  assert.match(text, /\$web\.Proxy = \$null/);
  assert.match(text, /\$web\.Headers\['X-Agentrix-Key'\] = \$global:AgentrixSession\.hooks\.key/);
  assert.match(text, /UploadString\(\$global:AgentrixSession\.hooks\.url \+ '\/UserPromptSubmit', \$json\)/);
  assert.match(text, /\$json \| & \$global:AgentrixSession\.powershellPath .* -Kind start/);
  assert.ok(text.endsWith(`'{"hook_event_name":"UserPromptSubmit","prompt":"it''s \\"quoted\\"","session_id":"s1"}'`), text);
  // SessionStart is always the script: no HTTP branch, and the JSON is the payload as given.
  const session = hookText('session', { source: 'startup' });
  assert.doesNotMatch(session, /UploadString|hooks\.channel/);
  assert.match(session, /-Kind session/);
  assert.ok(session.endsWith(`'{"source":"startup"}'`));
  // An HTTP-only event typed into a terminal reports its own limit instead of a wrong kind.
  assert.match(hookText('StopFailure', {}), /StopFailure has no command hook/);
});
