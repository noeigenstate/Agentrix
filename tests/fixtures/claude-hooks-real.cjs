// What the real-CLI hook tests share: the hook settings Agentrix hands Claude Code in each channel, a hook receiver and a
// timeline that records, in the order the test process sees them, the hooks, the screen, the model requests and the keys
// pressed. Order is the whole proof, so nothing here sleeps and nothing measures a bound: every wait is for an event.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
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
  // The CLI also names the project's folder under its config by the path with every other character a dash.
  for (const folder of [run, f.cwd]) for (const form of [folder.replace(/[^A-Za-z0-9]/g, '-'), folder, folder.replaceAll('\\', '\\\\'), slashes(folder)]) text = text.split(form).join('<run>');
  return text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>').replace(/(?:toolu|msg)_[0-9A-Za-z]+/g, '<id>')
    .replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, '<time>').replace(/127\.0\.0\.1:\d+/g, '127.0.0.1:<port>');
}

const strip = text => text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g, ' ').replace(/\x1b[()][0-9A-Za-z]/g, '').replace(/\x1b./g, '');
// What the terminal draws, as the lab of lane K0b found it: the footer says "esc to interrupt" while a turn runs and "? for shortcuts"
// when it is idle, and the permission dialog asks "Do you want to ...".
const SCREEN = { working: /esc to interrupt/, dialog: /Do you want to (?:proceed|make this edit|create)/, idle: /\? for shortcuts/, answer: /HOOK_ACK/ };

// How long one step may wait for what it expects before the test fails and says what it saw. Not a bound on any interval:
// a turn against the local stub takes a few seconds, so this only turns a hang into a diagnosis well before the test's
// own timeout.
const STEP_LIMIT_MS = Number(process.env.AGENTRIX_REAL_STEP_MS) || 60000;

// Everything the test process sees, in the order it sees it. `at` is only recorded for the latency artifact; no assertion reads it.
function observe(now = () => performance.now()) {
  const timeline = [], waiting = [], markers = { ...SCREEN };
  let screen = '', recent = '';
  const note = entry => {
    Object.assign(entry, { n: timeline.length, at: now() }); timeline.push(entry);
    for (const waiter of [...waiting]) if (waiter.test(entry)) { waiting.splice(waiting.indexOf(waiter), 1); clearTimeout(waiter.timer); waiter.resolve(entry); }
    return entry;
  };
  // What a failed wait reports: the events seen so far and the end of the screen, as text.
  const seen = () => `events: ${timeline.map(entry => entry.type === 'hook' ? entry.event : entry.type === 'screen' ? `screen:${entry.name}` : entry.type).join(' ') || 'none'}\n`
    + `screen (last 1500 characters):\n${recent.slice(-1500)}`;
  // Resolves with the first entry after `after` that passes `test`: at once if it is already there, otherwise when it arrives;
  // fails with what was seen when nothing came within STEP_LIMIT_MS.
  const when = (test, after = -1, what = 'an event') => {
    const found = timeline.find(entry => entry.n > after && test(entry));
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const waiter = { test: entry => entry.n > after && test(entry), resolve };
      waiter.timer = setTimeout(() => { waiting.splice(waiting.indexOf(waiter), 1); reject(new Error(`no ${what} after entry ${after} within ${STEP_LIMIT_MS} ms; ${seen()}`)); }, STEP_LIMIT_MS);
      waiting.push(waiter);
    });
  };
  // One chunk can draw several markers at once (the answer and the idle footer of a short turn): each is noted, in the order
  // the screen drew them, before the text is let go.
  const chunk = data => {
    const text = strip(data);
    screen = (screen + text).slice(-8000); recent = (recent + text).slice(-8000);
    const drawn = Object.entries(markers).map(([name, pattern]) => [name, pattern?.exec(screen)?.index]).filter(([, index]) => index !== undefined)
      .sort((a, b) => a[1] - b[1]);
    for (const [name] of drawn) note({ type: 'screen', name });
    if (drawn.length) screen = '';
  };
  return { timeline, markers, note, when, chunk,
    hook: (event, after) => when(entry => entry.type === 'hook' && entry.event === event, after, `${event} hook`),
    screen: (name, after) => when(entry => entry.type === 'screen' && entry.name === name, after, `screen "${name}" (${markers[name]})`) };
}

// A recording forward proxy, for the proxy tests: HTTP requests go on to their target and are listed by URL; a CONNECT
// tunnel, which Claude Code's HTTP hooks open even to an http:// URL, goes on to its host and is listed as `CONNECT host:port`.
async function startProxy(t) {
  const requests = [], tunnels = new Set();
  const server = http.createServer((request, response) => {
    requests.push(request.url);
    const forwarded = http.request(new URL(request.url), { method: request.method, headers: request.headers, agent: false }, answer => { response.writeHead(answer.statusCode, answer.headers); answer.pipe(response); });
    forwarded.on('error', () => response.writeHead(502).end());
    request.pipe(forwarded);
  });
  server.on('connect', (request, client, head) => {
    requests.push(`CONNECT ${request.url}`);
    const { hostname, port } = new URL(`http://${request.url}`);
    const upstream = net.connect(Number(port), hostname, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); upstream.write(head); upstream.pipe(client); client.pipe(upstream);
    });
    for (const socket of [client, upstream]) { tunnels.add(socket); socket.on('error', () => { client.destroy(); upstream.destroy(); }); socket.on('close', () => tunnels.delete(socket)); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { for (const socket of tunnels) socket.destroy(); server.closeAllConnections(); server.close(); });
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}

// Whether a request the proxy listed went to the hook receiver, forwarded by URL or tunnelled to its host.
const toReceiver = (entry, receiver) => { const { origin, host } = new URL(receiver.hooks.url); return entry.startsWith(`${origin}/h/`) || entry === `CONNECT ${host}`; };

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

// Answers a permission dialog with its first choice once the CLI says it is waiting for the owner. A key sent as soon as the
// dialog is drawn can arrive before the dialog reads keys and is lost; the permission_prompt Notification (6 s after the
// dialog, K0b) only comes once it waits.
async function allow(session, after) {
  await session.observer.when(entry => entry.type === 'hook' && entry.event === 'Notification' && entry.payload?.notification_type === 'permission_prompt',
    after, 'permission_prompt Notification');
  session.input.key('1');
}

// One plain turn: the prompt, the answer on the screen and, when Agentrix is there to hear it, the Stop hook. Resolves with the Enter entry.
async function playTurn(session, text = 'HOOK_PROMPT one') {
  const enter = await submit(session, text);
  await session.observer.screen('answer', enter.n);
  if (['http', 'command', 'command-async'].includes(session.mode)) await session.observer.hook('Stop', enter.n);
  return enter;
}

module.exports = { HTTP_EVENTS, ASYNC_OK, MODES, settingsFor, normalize, observe, startProxy, toReceiver, hooked, plainAnswer, submit, playTurn, allow, opening, textBlock, finish };
