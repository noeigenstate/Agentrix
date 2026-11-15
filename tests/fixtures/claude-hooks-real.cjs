// What the real-CLI hook tests share: the hook settings Agentrix hands Claude Code in each channel, a hook receiver and a
// timeline that records, in the order the test process sees them, the hooks, the screen, the model requests and the keys
// pressed. Order is the whole proof, so nothing here sleeps and nothing measures a bound: every wait is for an event.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { harness, opening, textBlock, finish } = require('./claude-real.cjs');
const { terminal } = require('./claude-terminal.cjs');
const { startHookReceiver } = require('../helpers/claude-hook-client.cjs');

// The events Agentrix hooks over HTTP (contract C-2); SessionStart stays the command hook and is not part of these tests.
const HTTP_EVENTS = ['UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'PostToolUseFailure', 'PostToolBatch', 'PermissionDenied',
  'Notification', 'Stop', 'StopFailure', 'SubagentStart', 'SubagentStop', 'PreCompact', 'PostCompact', 'SessionEnd', 'Elicitation', 'ElicitationResult'];
const SLOW = new Set(['PermissionRequest', 'Elicitation']);
// The status events Agentrix would run as async command hooks once they are proven harmless (K0b items 3 and 7).
const ASYNC_OK = new Set(['UserPromptSubmit', 'Stop', 'Notification', 'PostToolUse', 'PreToolUse']);
const MODES = ['none', 'http', 'command', 'command-async', 'gone'];

const slashes = value => value.replaceAll('\\', '/');
// The settings of each channel. 'gone' is the http settings with Agentrix's server shut down.
function settingsFor(mode, hooks) {
  if (mode === 'none') return null;
  const entry = event => {
    if (mode === 'http' || mode === 'gone') return { type: 'http', url: `${hooks.url}/${event}`, headers: { 'X-Agentrix-Key': hooks.key }, timeout: SLOW.has(event) ? 600 : 10 };
    const command = [slashes(process.execPath), slashes(path.join(__dirname, 'claude-hook-recorder.cjs')), event, hooks.url, hooks.key].map(part => `"${part}"`).join(' ');
    return { type: 'command', command, timeout: SLOW.has(event) ? 600 : 10, ...(mode === 'command-async' && ASYNC_OK.has(event) && { async: true }) };
  };
  return { hooks: Object.fromEntries(HTTP_EVENTS.map(event => [event, [{ hooks: [entry(event)] }]])) };
}

// A request body with what differs between two runs of the same session removed: ids, times, ports, and the run's folder.
function normalize(body, f) {
  const run = path.dirname(f.cwd);
  let text = JSON.stringify({ ...body, metadata: body.metadata && '<metadata>' });
  for (const folder of [run, f.cwd]) for (const form of [folder, folder.replaceAll('\\', '\\\\'), slashes(folder)]) text = text.split(form).join('<run>');
  return text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>').replace(/(?:toolu|msg)_[0-9A-Za-z]+/g, '<id>')
    .replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, '<time>').replace(/127\.0\.0\.1:\d+/g, '127.0.0.1:<port>');
}

const strip = text => text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g, ' ').replace(/\x1b[()][0-9A-Za-z]/g, '').replace(/\x1b./g, '');
// What the terminal draws, as the lab of lane K0b found it: the footer says "esc to interrupt" while a turn runs and "? for shortcuts"
// when it is idle, and the permission dialog asks "Do you want to ...".
const SCREEN = { working: /esc to interrupt/, dialog: /Do you want to (?:proceed|make this edit|create)/, idle: /\? for shortcuts/, answer: /HOOK_ACK/ };

// Everything the test process sees, in the order it sees it. `at` is only recorded for the latency artifact; no assertion reads it.
function observe(now = () => performance.now()) {
  const timeline = [], waiting = [], markers = { ...SCREEN };
  let screen = '';
  const note = entry => {
    Object.assign(entry, { n: timeline.length, at: now() }); timeline.push(entry);
    for (const waiter of [...waiting]) if (waiter.test(entry)) { waiting.splice(waiting.indexOf(waiter), 1); waiter.resolve(entry); }
    return entry;
  };
  // Resolves with the first entry after `after` that passes `test`: at once if it is already there, otherwise when it arrives.
  const when = (test, after = -1) => {
    const seen = timeline.find(entry => entry.n > after && test(entry));
    return seen ? Promise.resolve(seen) : new Promise(resolve => waiting.push({ test: entry => entry.n > after && test(entry), resolve }));
  };
  const chunk = data => {
    screen = (screen + strip(data)).slice(-8000);
    for (const [name, pattern] of Object.entries(markers)) if (pattern && pattern.test(screen)) { note({ type: 'screen', name }); screen = ''; break; }
  };
  return { timeline, markers, note, when, chunk,
    hook: (event, after) => when(entry => entry.type === 'hook' && entry.event === event, after),
    screen: (name, after) => when(entry => entry.type === 'screen' && entry.name === name, after) };
}

// A recording forward proxy, for the proxy tests: HTTP requests go on to their target, and each is listed with its URL.
async function startProxy(t) {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push(request.url);
    const forwarded = http.request(new URL(request.url), { method: request.method, headers: request.headers, agent: false }, answer => { response.writeHead(answer.statusCode, answer.headers); answer.pipe(response); });
    forwarded.on('error', () => response.writeHead(502).end());
    request.pipe(forwarded);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}

// One session of the real terminal CLI in a throwaway profile, hooked the way `mode` says, against a stub model that answers
// `respond`. `drive(session)` plays the turns; resolves with the session and the first model request that carried the prompt.
async function hooked(t, mode, { respond, proxy = null, drive }) {
  const observer = observe(), bodies = [];
  const f = await harness(t, (data, response) => { const value = respond(data, response); bodies.push(data); observer.note({ type: 'api', tools: Boolean(data.tools?.length) }); return value; });
  const receiver = mode === 'none' ? null : await startHookReceiver({ terminalId: 'terminal-1', key: 'key-1', onRequest: entry => observer.note({ type: 'hook', event: entry.event, payload: entry.payload }) });
  if (mode === 'gone') await receiver.close();
  else if (receiver) t.after(() => receiver.close());
  const settings = settingsFor(mode, receiver?.hooks), file = path.join(path.dirname(f.cwd), 'hook-settings.json');
  if (settings) fs.writeFileSync(file, JSON.stringify(settings));
  if (proxy) Object.assign(f.env, { HTTP_PROXY: proxy.url, HTTPS_PROXY: proxy.url, ALL_PROXY: proxy.url, http_proxy: proxy.url, https_proxy: proxy.url });
  const input = await terminal(t, f, settings ? ['--settings', file] : [], false, observer.chunk);
  const session = { f, observer, input, bodies, receiver, mode, proxy };
  await drive(session);
  return { ...session, body: bodies.find(body => body.tools?.length && JSON.stringify(body.messages).includes('HOOK_PROMPT')) };
}

const plainAnswer = data => [opening(data), ...textBlock(0, 'HOOK_ACK'), ...finish('end_turn')];

// Type one prompt and press Enter only once the screen shows it, so the time of Enter is known; resolves with the Enter entry.
async function submit(session, text) {
  const { observer, input } = session, before = observer.timeline.length - 1;
  observer.markers.typed = new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  input.key(text);
  await observer.screen('typed', before);
  observer.markers.typed = null;
  const enter = observer.note({ type: 'enter' });
  input.key('\r');
  return enter;
}

// One plain turn: the prompt, the answer on the screen and, when Agentrix is there to hear it, the Stop hook. Resolves with the Enter entry.
async function playTurn(session, text = 'HOOK_PROMPT one') {
  const enter = await submit(session, text);
  await session.observer.screen('answer', enter.n);
  if (['http', 'command', 'command-async'].includes(session.mode)) await session.observer.hook('Stop', enter.n);
  return enter;
}

module.exports = { HTTP_EVENTS, MODES, settingsFor, normalize, observe, startProxy, hooked, plainAnswer, submit, playTurn, opening, textBlock, finish };
