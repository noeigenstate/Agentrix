// The test-side Claude Code hook client: how a smoke, a probe or a fixture reports "Claude Code fired this hook" to a
// terminal, the way Claude Code itself does. It speaks contract C-2 of the 1.5.0 plan:
//   - a terminal whose bootstrap names the HTTP channel gets a POST to <hooks.url>/<EventName> with the header
//     X-Agentrix-Key, and the reply is always 200 with the body {};
//   - every other terminal (and SessionStart, which stays a command hook) gets integration/claude-hook.ps1 started as
//     Claude Code starts it, with the hook's JSON on its input.
// One module so that a change of channel is made here and nowhere else. It never waits on a clock: a caller that wants a
// bound passes an AbortSignal.
const http = require('node:http');
const { spawn: spawnProcess } = require('node:child_process');

const MAX_BODY_BYTES = 256 * 1024;

// The legacy kind of every hook event that has one (C-2's table). Events without a kind are HTTP only.
const KIND_OF_EVENT = {
  UserPromptSubmit: 'start', Stop: 'stop', Notification: 'notify', SessionStart: 'session',
  PreToolUse: 'progress', PostToolUse: 'progress', PostToolUseFailure: 'progress', PermissionDenied: 'progress', ElicitationResult: 'progress',
  PermissionRequest: 'permission', Elicitation: 'permission',
};
// The event a kind stands for when the payload does not name one.
const DEFAULT_EVENT_OF_KIND = { start: 'UserPromptSubmit', stop: 'Stop', notify: 'Notification', session: 'SessionStart', progress: 'PostToolUse', permission: 'PermissionRequest' };
// Events that are only ever sent over HTTP, so a terminal on the command channel has no kind for them.
const HTTP_ONLY_EVENTS = ['PostToolBatch', 'StopFailure', 'SubagentStart', 'SubagentStop', 'PreCompact', 'PostCompact', 'SessionEnd'];

// Accepts a hook event name ('Stop') or a legacy kind ('stop'); a progress or permission kind takes the event the payload
// names when it is one of that kind's events.
function resolveHook(kindOrEvent, payload = {}) {
  if (Object.hasOwn(KIND_OF_EVENT, kindOrEvent) || HTTP_ONLY_EVENTS.includes(kindOrEvent)) return { event: kindOrEvent, kind: KIND_OF_EVENT[kindOrEvent] || null };
  if (!Object.hasOwn(DEFAULT_EVENT_OF_KIND, kindOrEvent)) throw new Error(`Unknown hook kind or event: ${kindOrEvent}`);
  const named = payload.hook_event_name;
  const event = named && KIND_OF_EVENT[named] === kindOrEvent ? named : DEFAULT_EVENT_OF_KIND[kindOrEvent];
  return { event, kind: kindOrEvent };
}

const usesHttp = (bootstrap, event) => bootstrap?.hooks?.channel === 'http' && event !== 'SessionStart';

// POST one hook to a terminal's hook server. Resolves with { channel: 'http', status, body }.
function postHook(hooks, event, payload, { signal, request = http.request } = {}) {
  const body = JSON.stringify({ hook_event_name: event, ...payload });
  if (Buffer.byteLength(body) > MAX_BODY_BYTES) throw new Error(`A hook body is at most ${MAX_BODY_BYTES} bytes (contract C-2)`);
  return new Promise((resolve, reject) => {
    const outgoing = request(`${hooks.url}/${event}`, { method: 'POST', agent: false, signal,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-agentrix-key': hooks.key } }, response => {
      let text = ''; response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      response.once('end', () => resolve({ channel: 'http', status: response.statusCode, body: text }));
      response.once('error', reject);
    });
    outgoing.once('error', reject);
    outgoing.end(body);
  });
}

// Start the real hook script as a process of its own, as Claude Code starts a command hook. Resolves with the exit code.
function runCommandHook(bootstrap, kind, payload, { spawn = spawnProcess } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bootstrap.powershellPath, ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', bootstrap.claudeHookPath,
      '-PipeName', bootstrap.pipeName, '-ProjectId', bootstrap.projectId, '-SessionKey', bootstrap.sessionKey, '-Kind', kind], { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
    child.once('error', reject);
    child.once('exit', code => resolve({ channel: 'command', code }));
    child.stdin.end(JSON.stringify(payload));
  });
}

// Report one hook of a terminal from outside it, over the channel the terminal's bootstrap names.
async function sendHook(bootstrap, kindOrEvent, payload = {}, options = {}) {
  const { event, kind } = resolveHook(kindOrEvent, payload);
  if (usesHttp(bootstrap, event)) return postHook(bootstrap.hooks, event, payload, options);
  if (!kind) throw new Error(`${event} has no command hook: only an HTTP terminal can be sent it`);
  return runCommandHook(bootstrap, kind, payload, options);
}

const quote = value => "'" + String(value).replaceAll("'", "''") + "'";

// One hook as a PowerShell statement to type into an Agentrix terminal. The terminal decides the channel when the
// statement runs, from its own session ($global:AgentrixSession.hooks, read from bootstrap.json): HTTP posts to the hook
// server without a proxy, anything else pipes the JSON to the hook script. SessionStart is always the script.
function hookText(kindOrEvent, payload = {}) {
  const { event, kind } = resolveHook(kindOrEvent, payload);
  const session = '$global:AgentrixSession';
  const script = kind ? `$json | & ${session}.powershellPath -NoProfile -ExecutionPolicy Bypass -File ${session}.claudeHookPath -PipeName ${session}.pipeName -ProjectId ${session}.projectId -SessionKey ${session}.sessionKey -Kind ${kind}` : `Write-Error ${quote(`${event} has no command hook`)}`;
  if (event === 'SessionStart') return `& { param($json) ${script} } ${quote(JSON.stringify(payload))}`;
  const body = quote(JSON.stringify({ hook_event_name: event, ...payload }));
  const post = `$web = New-Object Net.WebClient; $web.Proxy = $null; $web.Encoding = [Text.Encoding]::UTF8; $web.Headers['Content-Type'] = 'application/json'; $web.Headers['X-Agentrix-Key'] = ${session}.hooks.key; [void]$web.UploadString(${session}.hooks.url + '/${event}', $json)`;
  return `& { param($json) if (${session}.hooks.channel -eq 'http') { ${post} } else { ${script} } } ${body}`;
}

// A hook server that answers as contract C-2 says, for tests that have no Agentrix to talk to: 200 with {} for the right
// terminal and key, 404 (counted with its reason) for anything else, 413 over 256 KB.
async function startHookReceiver({ terminalId = 'terminal-1', key = 'test-key', onRequest } = {}) {
  const accepted = [], rejected = [];
  let seq = 0;
  const server = http.createServer((request, response) => {
    const chunks = []; let size = 0, over = false;
    request.on('data', chunk => { size += chunk.length; if (size > MAX_BODY_BYTES) over = true; else chunks.push(chunk); });
    request.once('end', () => {
      const parts = request.url.split('/'), reason = request.method !== 'POST' || parts[1] !== 'h' || parts[2] !== terminalId ? 'unknown_terminal' : request.headers['x-agentrix-key'] !== key ? 'bad_key' : null;
      if (over) { rejected.push({ reason: 'too_large', url: request.url }); return response.writeHead(413).end(); }
      if (reason) { rejected.push({ reason, url: request.url }); return response.writeHead(404).end(); }
      let payload = null; try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* recorded as null */ }
      const entry = { seq: ++seq, event: parts[3], headers: request.headers, payload };
      accepted.push(entry); onRequest?.(entry);
      response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {
    hooks: { url: `http://127.0.0.1:${server.address().port}/h/${terminalId}`, key, channel: 'http', channelReason: null },
    accepted, rejected, server,
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }),
  };
}

module.exports = { KIND_OF_EVENT, DEFAULT_EVENT_OF_KIND, HTTP_ONLY_EVENTS, MAX_BODY_BYTES, resolveHook, usesHttp, postHook, runCommandHook, sendHook, hookText, startHookReceiver };
