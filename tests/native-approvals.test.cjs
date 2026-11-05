const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { WebSocket } = require('ws');
const { createNativeSession } = require('../scripts/codex-terminal-probe.cjs');
const { JsonLines, CodexProtocol, writeJson, MAX_BYTES } = require('../scripts/codex-protocol.cjs');
const { registerNativeIpc } = require('../electron/features/terminal/native-ipc.cjs');
const { isolatedEnvironment } = require('../scripts/native-approval-probe.cjs');
const binding = { provider: 'codex', projectId: 'fixture', terminalId: 'fixture', sessionId: 'generation' };
const request = id => ({ id, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread', turnId: 'turn', itemId: 'item', command: 'echo fixture' } });
const cli = { file: process.execPath, prefix: [path.join(__dirname, 'fixtures/native-cli.cjs')], node: true };
async function until(check) {
  const end = Date.now() + 5000;
  while (!check()) { if (Date.now() > end) throw new Error('native fixture timed out'); await new Promise(resolve => setTimeout(resolve, 10)); }
}
async function fixture(t) {
  const messages = [], outputs = [], writes = [], exits = [], launches = []; let socket, address, data;
  const pty = { spawn(file, args, options) {
    launches.push({ file, args }); address = args[args.indexOf('--remote') + 1];
    socket = new WebSocket(address, { headers: { Authorization: 'Bearer ' + options.env.AGENTRIX_NATIVE_REMOTE_TOKEN } });
    socket.on('error', () => {});
    socket.on('message', bytes => { const message = JSON.parse(bytes); messages.push(message);
      if (message.method?.endsWith('requestApproval')) data?.('TUI: Confirm echo fixture? [y/n]'); });
    socket.on('open', () => socket.send(JSON.stringify({ id: 'init', method: 'initialize', params: {} })));
    return { onData(fn) { data = fn; }, onExit() {}, resize() {}, kill() { socket.terminate(); }, write(key) {
      writes.push(key); if (key === 'n') { const held = messages.find(m => m.method?.endsWith('requestApproval')); socket.send(JSON.stringify({ id: held.id, result: { decision: 'decline' } })); }
    } };
  } };
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentrix-native-fixture-'));
  const terminal = createNativeSession({ binding, mode: 'codex-native', cwd: home, env: isolatedEnvironment(home), pty, cli: cli });
  terminal.onData(text => outputs.push(text)); terminal.onExit(value => exits.push(value)); t.after(() => terminal.kill());
  await until(() => messages.some(m => m.id === 'init'));
  return { terminal, messages, outputs, writes, exits, launches, get socket() { return socket; }, get address() { return address; },
    emit(...messages) { socket.send(JSON.stringify({ id: 'emit', method: 'fixture/emit', params: messages })); },
    raw(text) { socket.send(JSON.stringify({ id: 'raw', method: 'fixture/raw', params: text })); }, until };
}

if (require.main === module) {
test('Codex requests reach the TUI unchanged and only the owner TUI can answer them', async t => {
  const h = await fixture(t), frame = request('permission'); h.emit(frame);
  await until(() => h.messages.some(m => m.id === frame.id));
  assert.deepEqual(h.messages.find(m => m.id === frame.id), frame);
  assert.ok(h.outputs.some(text => text.includes('Confirm echo fixture?')));
  for (const removed of ['registry', 'answer', 'answerQuestion', 'prompt']) assert.equal(h.terminal[removed], undefined);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(h.messages.some(m => m.method === 'fixture/received'), false, 'the host never answered the waiting request');
  h.terminal.write('n'); await until(() => h.messages.some(m => m.method === 'fixture/received'));
  assert.deepEqual(h.messages.find(m => m.method === 'fixture/received').params, { id: frame.id, result: { decision: 'decline' } });
  assert.deepEqual(h.writes, ['n']);
  h.socket.send(JSON.stringify({ id: frame.id, result: { decision: 'accept' } }));
  await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(h.messages.filter(m => m.method === 'fixture/received').length, 1);
});

test('all retired host channels refuse every payload without reading sessions or writing keys', () => {
  const handlers = {};
  registerNativeIpc({ handle: (name, run) => handlers[name] = run, getSession: () => assert.fail('no host session authority'), findProject: assert.fail });
  for (const run of Object.values(handlers)) for (const payload of [null, {}, { decision: 'accept', token: 'synthetic-only' }]) assert.throws(() => run('fixture', payload), /Answer in the terminal/);
});

test('proxy correlates typed IDs, rejects duplicates, conflicts, forged responses and cross-thread resolutions', () => {
  const failures = [], p = new CodexProtocol(reason => failures.push(reason));
  assert.equal(p.server(request(1)), true); assert.equal(p.server(request('1')), true); assert.equal(p.server(request(1)), false);
  assert.equal(p.client({ id: '1', result: {} }), true); assert.equal(p.client({ id: '1', result: {} }), false);
  assert.equal(p.client({ id: 1, result: {} }), true); assert.deepEqual(failures, []);
  assert.equal(p.server(request(1)), false); assert.deepEqual(failures, ['native-id-reuse']);
  const other = new CodexProtocol(reason => failures.push(reason)); other.server(request('a'));
  assert.equal(other.server({ method: 'serverRequest/resolved', params: { requestId: 'a', threadId: 'other' } }), false);
  const forged = new CodexProtocol(); assert.equal(forged.client({ id: 'unknown', result: {} }), false);
});

test('unanswered requests have no expiry timer or host-generated cancellation', t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  const p = new CodexProtocol(); assert.equal(p.server(request('held')), true); t.mock.timers.tick(24 * 60 * 60 * 1000);
  assert.equal(p.closed, false); assert.equal(p.client({ id: 'held', result: { decision: 'cancel' } }), true);
});

test('native provider binding refuses managed Claude before starting any process', () => {
  assert.throws(() => createNativeSession({ binding: { ...binding, provider: 'claude' }, mode: 'claude-sdk', env: {}, cli: cli, launch: () => assert.fail('must not launch') }), /Invalid native/);
});

test('authenticated proxy rejects an uninvited client and closes on binary or malformed client input', async t => {
  const h = await fixture(t), other = new WebSocket(h.address); other.on('error', () => {});
  assert.equal(await new Promise(resolve => other.once('close', resolve)), 1006);
  h.socket.send(Buffer.from('{}')); await until(() => h.exits.length > 0); assert.equal(h.terminal.error, 'malformed-client-stream');
});

test('actual stdio handles fragmented records then fails closed on malformed or oversized output', async t => {
  const h = await fixture(t), line = JSON.stringify(request('fragmented')) + '\n';
  h.raw(line.slice(0, 9)); h.raw(line.slice(9) + JSON.stringify(request('batched')) + '\n');
  await until(() => h.messages.some(m => m.id === 'fragmented') && h.messages.some(m => m.id === 'batched'));
  h.raw('bad JSON\n'); await until(() => h.exits.length > 0);
  const large = await fixture(t); large.raw('x'.repeat(150000)); large.raw('x'.repeat(150000)); await until(() => large.exits.length > 0);
});

test('JSON framing rejects invalid UTF-8, incomplete and oversized frames without exposing diagnostics', () => {
  for (const bytes of [Buffer.from([0xff]), Buffer.from('{}'), Buffer.from('x'.repeat(MAX_BYTES + 1))]) {
    const failures = [], lines = new JsonLines(() => assert.fail('no full JSON frame'), reason => failures.push(reason)); lines.push(bytes); lines.end(); assert.equal(failures.length, 1);
  }
  assert.throws(() => writeJson({ destroyed: true }, {}, assert.fail), /unavailable/);
});

test('manual native TUI keys never become inferred prompts or rearm completion', () => {
  const { registerTerminalIpc } = require('../electron/features/terminal/ipc.cjs'), listeners = {}, writes = [];
  const { SubmissionTracker } = require('../electron/terminal-input.cjs');
  const session = { native: {}, nativeInputRequests: new Set(['approval']), draftSubmissions: new SubmissionTracker({ captureText: false }),
    status: 'codex', codexActive: true, approval: { invalidate() {} }, gate: { input: data => writes.push(data) }, submissions: { write: () => assert.fail('native keys are not prompt records') } };
  registerTerminalIpc({ handle() {}, listen: (name, run) => listeners[name] = run, getSession: () => session,
    getProjectById: () => assert.fail('TUI answers cannot acknowledge a round'), expectCompletion: assert.fail, pollAfterSubmission: assert.fail });
  for (const data of ['synthetic free-text answer', '\r', '1', '\x1b']) listeners['terminal:write']('fixture', data);
  assert.deepEqual(writes, ['synthetic free-text answer', '\r', '1', '\x1b']);
  assert.equal(session.draftSubmissions.hasText, false); assert.equal(session.draftSubmissions.text, '');
  session.nativeInputRequests.clear(); listeners['terminal:write']('fixture', 'actual draft');
  assert.equal(session.draftSubmissions.hasText, true); assert.equal(session.draftSubmissions.text, '', 'the observer stores no raw native input');
});

}
module.exports = { fixture, request, until };
