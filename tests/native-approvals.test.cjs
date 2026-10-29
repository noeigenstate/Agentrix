const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
const { spawn } = require('node:child_process');
const { WebSocket } = require('ws');
const { NativeApprovals, MAX_BYTES } = require('../electron/features/terminal/native-approvals.cjs');
const { JsonLines, CodexProtocol, ClaudeProtocol, writeJson } = require('../electron/features/terminal/native-protocol.cjs');
const { createNativeSession, resolveCli } = require('../electron/features/terminal/native-session.cjs');
const { registerNativeIpc } = require('../electron/features/terminal/native-ipc.cjs');
const { terminalLocale, shellEnvironment, zshEnvironment } = require('../electron/zsh-terminal.cjs');

const binding = { provider: 'codex', projectId: 'project', terminalId: 'terminal', sessionId: 'generation-A' };
const request = (id, overrides = {}) => ({ id, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread', turnId: 'turn', itemId: `item-${id}`, command: 'same text', ...overrides } });
function harness(t, options = {}) {
  const failures = [], writes = [];
  const registry = new NativeApprovals(binding, { fail: reason => failures.push(reason), ...options });
  t.after(() => registry.close());
  const protocol = new CodexProtocol(registry);
  const answer = (record, decision = 'accept', extra = {}) => registry.answer(binding, { token: record.token, decision, ...extra }, message => writes.push(message));
  return { registry, protocol, failures, writes, answer, add(id, params) { protocol.server(request(id, params)); return registry.list().at(-1); } };
}
function rejects(h, token) { assert.throws(() => h.registry.answer(binding, { token, decision: 'accept' }, () => assert.fail('stale response wrote'))); }

test('native A → B → identical A-prime, with coalesced/unobserved B, revokes held callbacks', t => {
  const h = harness(t), a = h.add('native-A');
  h.protocol.server({ method: 'serverRequest/resolved', params: { requestId: 'native-A', threadId: 'thread' } });
  const b = h.add('native-B'); h.protocol.client({ id: 'native-B', result: { decision: 'decline' } });
  const next = h.add('native-A-prime', { itemId: a.params.itemId });
  rejects(h, a.token); rejects(h, b.token); h.answer(next);
  assert.deepEqual(h.writes, [{ id: 'native-A-prime', result: { decision: 'accept' } }]);
});

test('identical text supports concurrent requests and native number 1 differs from string 1', t => {
  const h = harness(t), a = h.add(1), b = h.add('1', { itemId: a.params.itemId });
  assert.equal(h.registry.list().length, 2); h.answer(b); h.answer(a, 'decline');
  assert.equal(h.writes[0].id, '1'); assert.equal(h.writes[1].id, 1);
});

for (const field of Object.keys(binding)) test(`immutable ${field} binding rejects a cross-bound response`, t => {
  const h = harness(t), a = h.add(1);
  assert.throws(() => h.registry.answer({ ...binding, [field]: 'other' }, { token: a.token, decision: 'accept' }, () => assert.fail('cross-bound write')));
  assert.equal(h.registry.list().length, 1);
});

for (const first of ['server', 'tui', 'host']) test(`${first}-first response arbitration consumes at most once`, t => {
  const h = harness(t), a = h.add(1), response = { id: 1, result: { decision: 'accept' } };
  if (first === 'host') h.answer(a);
  if (first === 'server') h.protocol.server({ method: 'serverRequest/resolved', params: { requestId: 1, threadId: 'thread' } });
  if (first === 'tui') assert.equal(h.protocol.client(response), true);
  rejects(h, a.token); assert.equal(h.protocol.client(response), false);
  assert.equal(h.writes.length, first === 'host' ? 1 : 0);
});

test('exact pending duplicate is idempotent; conflicting duplicate fails connection closed', t => {
  const h = harness(t); h.add(1); assert.equal(h.protocol.server(request(1)), false); assert.equal(h.registry.list().length, 1);
  h.protocol.server(request(1, { command: 'changed' })); assert.equal(h.registry.closed, true); assert.deepEqual(h.failures, ['native-id-reuse']);
});

test('resolved native ID reuse fails closed rather than manufacturing a new epoch', t => {
  const h = harness(t), a = h.add(1); h.answer(a); h.protocol.server(request(1)); assert.equal(h.registry.closed, true);
});

test('thread/turn completion revokes only its own requests; explicit interruption revokes before forwarding', t => {
  const h = harness(t), a = h.add(1), b = h.add(2, { turnId: 'other-turn' }), c = h.add(3, { threadId: 'other-thread' });
  h.protocol.server({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn' } } });
  rejects(h, a.token); assert.equal(h.registry.list().length, 2);
  h.protocol.client({ id: 12, method: 'turn/interrupt', params: { threadId: 'thread', turnId: 'other-turn' } });
  rejects(h, b.token); h.answer(c);
});

test('a mismatched resolution thread fails all pending authority closed', t => {
  const h = harness(t); h.add(1); h.protocol.server({ method: 'serverRequest/resolved', params: { requestId: 1, threadId: 'different' } }); assert.equal(h.registry.closed, true);
});

test('forged ID, altered input, extra binding fields and unsupported decisions never write', t => {
  const h = harness(t), a = h.add(1);
  rejects(h, 'forged'); assert.throws(() => h.answer(a, 'acceptForSession'));
  assert.throws(() => h.answer(a, 'accept', { updatedInput: { command: 'other' } }));
  assert.throws(() => h.answer(a, 'accept', { requestId: 999 })); assert.deepEqual(h.writes, []);
});

test('timeout, disconnect and restart generations revoke old capabilities', t => {
  let now = 1; const h = harness(t, { now: () => now, ttl: 10 }), a = h.add(1);
  now = 11; rejects(h, a.token); assert.equal(h.registry.closed, true);
  const fresh = harness(t), next = fresh.add(1); rejects(fresh, a.token); fresh.registry.close(); rejects(fresh, next.token);
});

test('bounded pending and tombstone limits fail closed', t => {
  const h = harness(t, { maxPending: 1 }); h.add(1); h.add(2); assert.deepEqual(h.failures, ['request-limit']);
  const seen = harness(t, { maxSeen: 1 }); const a = seen.add(1); seen.answer(a); seen.add(2); assert.equal(seen.registry.closed, true);
});

test('write exceptions consume the capability, revoke every concurrent request and never retry', t => {
  const h = harness(t), a = h.add(1), b = h.add(2); let attempts = 0;
  assert.throws(() => h.registry.answer(binding, { token: a.token, decision: 'accept' }, () => { attempts++; throw new Error('pipe'); }));
  rejects(h, a.token); rejects(h, b.token); assert.equal(attempts, 1);
});

test('native details and response IDs are immutable despite original message and snapshot mutation', t => {
  const h = harness(t), m = request('original'); h.protocol.server(m); const a = h.registry.list()[0];
  m.id = 'forged'; m.params.threadId = 'other'; a.params.command = 'renderer replacement'; a.requestId = 'renderer ID';
  assert.equal(h.registry.list()[0].params.threadId, 'thread'); h.answer(a); assert.equal(h.writes[0].id, 'original');
});

test('a reentrant lifecycle close immediately before write cannot send an old response', t => {
  let closing = false; const h = harness(t, { changed() { if (closing) h.registry.close(); } }), a = h.add(1);
  closing = true; assert.throws(() => h.answer(a)); assert.deepEqual(h.writes, []);
});

test('permissions echo only provider input and use explicit turn scope; deny grants none', t => {
  const h = harness(t), msg = { ...request(1), method: 'item/permissions/requestApproval' }; msg.params.permissions = { network: { enabled: true } };
  h.protocol.server(msg); h.answer(h.registry.list()[0], 'grant');
  assert.deepEqual(h.writes[0], { id: 1, result: { permissions: { network: { enabled: true } }, scope: 'turn' } });
  msg.id = 2; h.protocol.server(msg); h.answer(h.registry.list()[0], 'deny'); assert.deepEqual(h.writes[1].result.permissions, {});
});

test('unknown or malformed permission profiles stay TUI-only; supported filesystem grants preserve paths exactly', t => {
  const h = harness(t); let id = 1;
  for (const permissions of [null, [], { futurePermission: true }, { network: { enabled: 'yes' } }, { fileSystem: { write: 'all' } }, { fileSystem: { entries: [{ access: 'admin', path: {} }] } }]) {
    h.protocol.server({ ...request(id++), method: 'item/permissions/requestApproval', params: { ...request(1).params, permissions } });
    assert.equal(h.registry.list().length, 0);
  }
  const permissions = { fileSystem: { write: ['C:\\owned path\\'], entries: [{ access: 'read', path: { type: 'glob_pattern', pattern: '**/*.txt' } }] } };
  h.protocol.server({ ...request(id), method: 'item/permissions/requestApproval', params: { ...request(1).params, permissions } });
  h.answer(h.registry.list()[0], 'grant'); assert.deepEqual(h.writes[0].result.permissions, permissions);
});

test('provider available decisions restrict cards; unsupported methods remain terminal-only', t => {
  const h = harness(t), a = h.add(1, { availableDecisions: ['decline'] }); assert.deepEqual(a.decisions, ['decline']);
  assert.throws(() => h.answer(a)); assert.equal(h.protocol.server({ id: 2, method: 'unknown/requestApproval', params: {} }), true);
  assert.equal(h.registry.list().length, 1); assert.equal(h.protocol.client({ id: 2, result: {} }), true);
  assert.equal(h.protocol.client({ id: 999, result: {} }), false); assert.equal(h.registry.closed, true);
});

for (const bad of [null, 'text', [], {}, { threadId: 'thread' }]) test(`malformed known request ${JSON.stringify(bad)} fails closed`, t => {
  const h = harness(t); h.protocol.server({ ...request(1), params: bad }); assert.equal(h.registry.closed, true); assert.deepEqual(h.writes, []);
});

test('Claude exact native request_id and original input survive allow; cancellation forbids late answer', t => {
  const h = harness(t), p = new ClaudeProtocol(h.registry), input = { command: 'echo original', nested: { value: 'preserved' } };
  const m = { type: 'control_request', request_id: 'cli-1', request: { subtype: 'can_use_tool', tool_name: 'Bash', tool_use_id: 'tool-1', input } };
  p.server(m); const a = h.registry.list()[0]; input.command = 'mutated externally'; h.answer(a, 'allow');
  assert.equal(h.writes[0].response.request_id, 'cli-1'); assert.equal(h.writes[0].response.response.updatedInput.command, 'echo original');
  p.server({ ...m, request_id: 'cli-2' }); const b = h.registry.list()[0]; p.server({ type: 'control_cancel_request', request_id: 'cli-2' });
  assert.throws(() => h.answer(b, 'deny')); assert.equal(h.writes.length, 1);
});

test('Claude result invalidates all concurrent requests; unknown control subtype fails closed', t => {
  const h = harness(t), p = new ClaudeProtocol(h.registry);
  for (const id of ['a', 'b']) p.server({ type: 'control_request', request_id: id, request: { subtype: 'can_use_tool', tool_name: 'Read', input: {} } });
  assert.equal(h.registry.list().length, 2); p.server({ type: 'result' }); assert.equal(h.registry.list().length, 0);
  p.server({ type: 'control_request', request_id: 'c', request: { subtype: 'hook_callback' } }); assert.equal(h.registry.closed, true);
});

test('Claude duplicate conflict, ID reuse, numeric ID and malformed tool input fail closed', t => {
  const base = { type: 'control_request', request_id: 'cli', request: { subtype: 'can_use_tool', tool_name: 'Read', input: { file_path: 'a' } } };
  for (const mutation of [m => m.request.input = [], m => m.request_id = 1, m => m.request.tool_use_id = {}, m => m.request.tool_name = null]) {
    const h = harness(t), p = new ClaudeProtocol(h.registry), m = structuredClone(base); mutation(m); p.server(m); assert.equal(h.registry.closed, true);
  }
  const h = harness(t), p = new ClaudeProtocol(h.registry); p.server(base); p.server(structuredClone(base)); assert.equal(h.registry.list().length, 1);
  p.server({ ...base, request: { ...base.request, tool_use_id: 'conflict' } }); assert.equal(h.registry.closed, true);
  const reused = harness(t), second = new ClaudeProtocol(reused.registry); second.server(base); reused.answer(reused.registry.list()[0], 'deny'); second.server(base); assert.equal(reused.registry.closed, true);
});

test('malformed JSON-RPC envelopes and unsafe numeric IDs cannot become native requests', t => {
  for (const m of [{}, { method: 3, id: 1 }, { id: 1, result: {}, error: {} }, request(2 ** 54), { ...request(1), jsonrpc: '1.0' }]) {
    const h = harness(t); h.protocol.server(m); assert.equal(h.registry.closed, true);
  }
});

test('fragmented UTF-8, coalesced records and CRLF preserve actual provider message IDs', () => {
  const values = [], failures = [], stream = new JsonLines(m => values.push(m), e => failures.push(e));
  const bytes = Buffer.from(JSON.stringify(request('中文')) + '\r\n' + JSON.stringify(request(2)) + '\n');
  for (const byte of bytes) stream.push(Buffer.from([byte])); stream.end();
  assert.deepEqual(values.map(m => m.id), ['中文', 2]); assert.deepEqual(failures, []);
});

for (const [name, bytes, end] of [
  ['malformed JSON', Buffer.from('{oops}\n')], ['JSON batch array', Buffer.from('[]\n')], ['oversized record', Buffer.from('x'.repeat(MAX_BYTES + 1))],
  ['invalid UTF-8', Buffer.from([0xff, 10])], ['truncated record', Buffer.from('{"id":1}'), true],
]) test(`${name} fails native stream closed`, () => {
  const failures = [], stream = new JsonLines(() => assert.fail('bad record published'), e => failures.push(e)); stream.push(bytes); if (end) stream.end();
  assert.equal(failures.length, 1); stream.push(Buffer.from('{}\n'));
});

test('backpressure, destroyed streams and asynchronous write errors never retry', () => {
  const failures = []; let calls = 0;
  assert.throws(() => writeJson({ write() { calls++; return false; } }, { id: 1 }, e => failures.push(e)));
  assert.equal(calls, 1); assert.deepEqual(failures, ['native-backpressure']);
  assert.throws(() => writeJson({ destroyed: true }, {}, () => {}));
  writeJson({ write(_data, callback) { callback(new Error()); return true; } }, {}, e => failures.push(e)); assert.equal(failures[1], 'native-write-error');
});

test('native IPC rejects legacy, SSH, stale managed sessions and never calls PTY fallback', () => {
  const handles = {}; let session; const writes = [];
  registerNativeIpc({ handle: (name, fn) => handles[name] = fn, findProject: () => ({}), getSession: () => session });
  for (const state of [null, { status: 'shell' }, { native: {}, approvalRemote: true }, { native: {}, status: 'exited' }]) {
    session = { ...state, gate: { input: data => writes.push(data) } }; assert.throws(() => handles['terminal:native-approval']('terminal', { token: 'forged', decision: 'allow' }));
  }
  session = { native: { prompt: () => assert.fail('stale prompt') }, nativeMode: 'claude-sdk', sessionId: 'fresh' };
  assert.throws(() => handles['terminal:managed-prompt']('terminal', 'old', 'test')); assert.deepEqual(writes, []);
});

const fixture = { file: process.execPath, prefix: [path.join(__dirname, 'fixtures/native-cli.cjs')], node: true };
async function waitFor(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('fixture timeout'); await new Promise(resolve => setTimeout(resolve, 10)); }
}
async function proxyFixture(t) {
  const messages = [], launches = []; let socket, address;
  const pty = { spawn(file, args, options) {
    launches.push({ file, args, options }); address = args[args.indexOf('--remote') + 1];
    socket = new WebSocket(address, { headers: { Authorization: `Bearer ${options.env.AGENTRIX_NATIVE_REMOTE_TOKEN}` } });
    socket.on('error', () => {}); socket.on('message', data => messages.push(JSON.parse(data)));
    socket.on('open', () => socket.send(JSON.stringify({ id: 'initialize', method: 'initialize', params: { clientInfo: { name: 'fixture', version: '1' } } })));
    return { onData() {}, onExit() {}, kill() { socket.terminate(); }, write() {}, resize() {} };
  } };
  const terminal = createNativeSession({ binding, mode: 'codex-native', cwd: process.cwd(), env: { ...process.env }, pty, cli: fixture });
  t.after(() => terminal.kill());
  await waitFor(() => messages.some(m => m.id === 'initialize'));
  return { terminal, messages, launches, get socket() { return socket; }, get address() { return address; }, emit(...params) { socket.send(JSON.stringify({ id: 'fixture', method: 'fixture/emit', params })); }, raw(params) { socket.send(JSON.stringify({ id: 'raw', method: 'fixture/raw', params })); } };
}

test('owned Codex startup launches real remote argv, authenticated proxy, stdio adapter and native response', async t => {
  const h = await proxyFixture(t); h.emit(request(1), request('1')); await waitFor(() => h.terminal.registry.list().length === 2);
  const [a, b] = h.terminal.registry.list(); h.terminal.answer({ token: b.token, decision: 'accept' });
  await waitFor(() => h.messages.some(m => m.method === 'fixture/received'));
  assert.equal(h.messages.find(m => m.method === 'fixture/received').params.id, '1');
  h.socket.send(JSON.stringify({ id: 1, result: { decision: 'decline' } })); await waitFor(() => h.terminal.registry.list().length === 0);
  assert.throws(() => h.terminal.answer({ token: a.token, decision: 'accept' }));
  assert.ok(h.launches[0].args.includes('--remote-auth-token-env')); assert.ok(!h.launches[0].args.includes(h.launches[0].options.env.AGENTRIX_NATIVE_REMOTE_TOKEN));
});

test('proxy rejects unauthenticated second clients and reconnect cannot inherit pending authority', async t => {
  const h = await proxyFixture(t); h.emit(request(1)); await waitFor(() => h.terminal.registry.list().length);
  const token = h.terminal.registry.list()[0].token;
  const unauthorized = new WebSocket(h.address); unauthorized.on('error', () => {});
  const code = await new Promise(resolve => unauthorized.once('close', resolve)); assert.equal(code, 1006);
  h.socket.close(); await waitFor(() => h.terminal.registry.closed); assert.throws(() => h.terminal.answer({ token, decision: 'accept' }));
});

test('malformed WebSocket client envelope closes issuing process and pending requests', async t => {
  const h = await proxyFixture(t); h.emit(request(1)); await waitFor(() => h.terminal.registry.list().length); h.socket.send('[]');
  await waitFor(() => h.terminal.registry.closed);
});

test('actual stdio adapter handles fragmented/coalesced server bytes and then closes on malformed output', async t => {
  const h = await proxyFixture(t), line = JSON.stringify(request('fragmented')) + '\n';
  h.raw(line.slice(0, 9)); h.raw(line.slice(9) + JSON.stringify(request('batched')) + '\n');
  await waitFor(() => h.terminal.registry.list().length === 2); h.raw('bad JSON\n'); await waitFor(() => h.terminal.registry.closed);
});

test('actual stdio oversized output fails closed with pending requests', async t => {
  const h = await proxyFixture(t); h.emit(request(1)); await waitFor(() => h.terminal.registry.list().length);
  // Every client frame is bounded too; build an over-limit server record from multiple accepted frames.
  h.raw('x'.repeat(150000)); h.raw('x'.repeat(150000)); await waitFor(() => h.terminal.registry.closed);
});

test('actual child process exit revokes held callbacks', async t => {
  const h = await proxyFixture(t); h.emit(request(1)); await waitFor(() => h.terminal.registry.list().length);
  const token = h.terminal.registry.list()[0].token; h.socket.send(JSON.stringify({ id: 'exit', method: 'fixture/exit' }));
  await waitFor(() => h.terminal.registry.closed); assert.throws(() => h.terminal.answer({ token, decision: 'accept' }));
});

test('oversized and binary WebSocket messages close the native channel', async t => {
  for (const data of [Buffer.from('{}'), 'x'.repeat(MAX_BYTES + 1)]) {
    const h = await proxyFixture(t); h.socket.send(data); await waitFor(() => h.terminal.registry.closed);
  }
});

test('Claude managed startup initializes exact SDK stream flags and answers on original child stdin', async t => {
  const events = [], launches = [], note = 'Before any task, read and follow C:/isolated/skills/model-routing/SKILL.md.';
  const terminal = createNativeSession({ binding: { ...binding, provider: 'claude' }, mode: 'claude-sdk', cwd: process.cwd(), env: { ...process.env, AGENTRIX_READING_NOTE: note }, cli: fixture, event: message => events.push(message), launch: (...args) => { launches.push(args); return spawn(...args); } });
  t.after(() => terminal.kill()); assert.throws(() => terminal.prompt('before initialize'));
  await waitFor(() => events.some(m => m.type === 'managed-ready'));
  assert.deepEqual(launches[0][1].slice(1), ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--permission-prompt-tool', 'stdio', '--verbose', '--append-system-prompt', note]);
  assert.ok(!launches[0][1].includes('--dangerously-skip-permissions'));
  terminal.prompt('harmless fixture prompt'); await waitFor(() => terminal.registry.list().length);
  assert.throws(() => terminal.prompt('overlapping prompt'));
  const a = terminal.registry.list()[0]; assert.equal(a.requestId, 'cli-fixture-1'); terminal.answer({ token: a.token, decision: 'allow' });
  await waitFor(() => events.some(m => m.type === 'result'));
  const text = events.find(m => m.type === 'assistant').message.content[0].text;
  assert.equal(JSON.parse(text).response.response.updatedInput.command, 'harmless fixture prompt');
  terminal.write('ignored PTY key\r'); assert.equal(terminal.registry.list().length, 0);
});

test('process exit kills native request authority even with held renderer token', async t => {
  const h = await proxyFixture(t); h.emit(request(1)); await waitFor(() => h.terminal.registry.list().length);
  const token = h.terminal.registry.list()[0].token; h.terminal.kill(); assert.equal(h.terminal.registry.closed, true); assert.throws(() => h.terminal.answer({ token, decision: 'accept' }));
});

test('production startup/state/preload/UI path is connected; legacy permission endpoint remains closed', () => {
  const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  assert.match(read('electron/main.cjs'), /startTerminal\(id, agent === 'claude' \? 'claude-sdk' : 'codex-native'\)/);
  assert.match(read('electron/main.cjs'), /nativeApprovals: s\?\.native\?\.registry\.list\(\)/);
  assert.match(read('electron/main.cjs'), /registerNativeIpc\(/); assert.match(read('electron/preload.cjs'), /terminal:native-approval/);
  assert.match(read('src/features/reading/ReadingView.tsx'), /terminal\.nativeApprovals\?\.map/);
  assert.match(read('src/features/home/decisions.ts'), /for \(const native of terminal\.nativeApprovals\)/);
  assert.match(read('src/features/terminal/AgentLauncher.tsx'), /Claude SDK（托管）/);
  assert.match(read('electron/features/terminal/ipc.cjs'), /handle\('terminal:approval', \(\) => \(\{ mode: 'terminal-only'/);
  assert.throws(() => resolveCli('codex', { PATH: '' }));
});

for (const [platform, shellKind] of [['win32', 'powershell'], ['linux', 'bash'], ['darwin', 'zsh']]) test(`actual main startTerminal binds native mode and generation without starting a shell on ${platform}`, () => {
  const source = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8'), sessions = new Map();
  const project = { id: 'project', path: process.cwd(), kind: 'local' }, writes = [], deliveries = []; let options;
  const languages = ['zh-Hans-CN', 'en-US'], localeCalls = [], integrations = []; let languageCalls = 0;
  const environment = (kind, helper) => (env, integration) => { integrations.push({ kind, integration }); return helper(env, integration); };
  const terminal = { registry: { close() {} }, onData() {}, onExit() {}, write: data => writes.push(data) };
  const noOp = () => {}, dummy = class { reset() {} dispose() {} output() {} };
  let uuid = 0;
  const context = vm.createContext({ sessions, findProject: () => project, disposeTerminal: noOp, process: { platform, env: {}, execPath: process.execPath }, fs: { existsSync: () => true }, path,
    app: { getPreferredSystemLanguages() { languageCalls++; return languages; } },
    terminalLocale(value) { localeCalls.push(value); return terminalLocale(value, name => name === 'zh_CN.UTF-8'); },
    randomUUID: () => `native-generation-${++uuid}`, restorePlans: new Map(), store: { findTerminal: () => ({ record: {} }), setRestore: noOp }, localShell: () => ({ kind: shellKind }), runtimeDir: 'unused', eventServer: { address: 'unused' },
    createTerminalEnvironment: () => ({}), withoutAppImage: value => value, accountEnvironment: () => ({}), skills: { delivery: (...args) => { deliveries.push(args); return {}; } }, writeSkillFile: noOp, startupNote: () => 'note', READING_NOTE: 'note', handoffFile: () => 'unused', writeHandoff: async () => {}, memoryDir: () => 'unused',
    shellEnvironment: environment('bash', shellEnvironment), zshEnvironment: environment('zsh', zshEnvironment), zshStartup: 'unused', integrationDir: 'unused', pty: { spawn: () => assert.fail('native launch started a shell') },
    createNativeSession: value => { options = value; return terminal; }, scheduleState: noOp, nativeSessionEvent: noOp,
    TerminalTitleTracker: dummy, SubmissionTracker: dummy, ApprovalGuard: require('../electron/features/terminal/approval-guard.cjs').ApprovalGuard,
    ActionLog: dummy, InputGate: class { constructor(write) { this.input = write; } }, PromptQueue: dummy, ConversationLog: dummy,
    CompletionWork: require('../electron/completion-work.cjs').CompletionWork,
    startupErrors: new Map(), captureBranch: noOp, broadcast: noOp, send: noOp, clearTimeout, setTimeout, isTerminalResponse: () => false,
    os: { homedir: () => 'unused' }, publishAction: noOp, publishConversation: noOp,
  });
  vm.runInContext(source.slice(source.indexOf('function startTerminal('), source.indexOf('function disposeTerminal(')), context);
  context.startTerminal('terminal', 'codex-native'); const s = sessions.get('terminal');
  assert.equal(options.mode, 'codex-native'); assert.equal(options.binding.provider, 'codex');
  assert.equal(options.binding.sessionId, s.sessionId); assert.equal(options.binding.projectId, 'project'); assert.equal(options.binding.terminalId, 'terminal');
  assert.equal(s.native, terminal); assert.equal(s.codexActive, true); assert.equal(s.agent, 'codex'); s.gate.input('manual TUI input'); assert.deepEqual(writes, ['manual TUI input']);
  context.startTerminal('sdk-terminal', 'claude-sdk'); const sdk = sessions.get('sdk-terminal'); assert.equal(options.binding.provider, 'claude'); assert.equal(options.binding.sessionId, sdk.sessionId); assert.equal(sdk.agent, 'claude');
  assert.equal(options.mode, 'claude-sdk'); assert.equal(options.binding.projectId, 'project'); assert.equal(options.binding.terminalId, 'sdk-terminal');
  assert.equal(sdk.native, terminal); assert.equal(sdk.codexActive, true); assert.notEqual(s.sessionId, sdk.sessionId);
  assert.equal(JSON.stringify(deliveries), JSON.stringify([
    [project, false, s.sessionId], [project, false, s.sessionId, { agent: 'codex', started: true }],
    [project, false, sdk.sessionId], [project, false, sdk.sessionId, { agent: 'claude', started: true }],
  ]), 'native agent launch claims first-open after CLI resolution, with the right agent');
  assert.equal(s.shellKind, shellKind); assert.equal(sdk.shellKind, shellKind); assert.equal(s.bootstrapFile, null); assert.equal(sdk.bootstrapFile, null);
  assert.equal(languageCalls, platform === 'darwin' ? 2 : 0);
  assert.deepEqual(localeCalls, platform === 'darwin' ? [languages, languages] : []);
  assert.equal(integrations.length, platform === 'win32' ? 0 : 2);
  for (const [index, { kind, integration }] of integrations.entries()) {
    const session = index === 0 ? s : sdk;
    assert.equal(kind, shellKind); assert.equal(integration.locale, platform === 'darwin' ? 'zh_CN.UTF-8' : 'C.UTF-8');
    assert.equal(integration.projectId, session.terminalId); assert.equal(integration.sessionKey, session.sessionKey);
    assert.equal(integration.node, process.execPath); assert.equal(integration.startDir, project.path);
    assert.equal(integration.folder, 'unused'); assert.equal(integration.socket, 'unused'); assert.equal(integration.helper, path.join('unused', 'agent-event.cjs'));
    assert.equal(session.usageEnv.LANG, integration.locale);
    assert.equal(session.usageEnv.ZDOTDIR, platform === 'darwin' ? 'unused' : undefined);
  }
  if (platform === 'win32') assert.equal(options.env.LANG, undefined);
});

function mainExitFixture(terminal, native = true) {
  const source = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
  const s = { native: native ? terminal : null, status: 'codex', ready: true, codexActive: true, error: null,
    completionWork: new (require('../electron/completion-work.cjs').CompletionWork)() };
  const sessions = new Map([['terminal', s]]), restores = [], calls = [];
  const context = vm.createContext({ terminal, s, sessions, id: 'terminal', project: { id: 'project' }, sessionId: 'generation', bootstrapFile: null, skillNoteFile: null, quitting: false,
    endSkillSession: () => calls.push('endSkillSession'), skills: { endSession: () => calls.push('endDelivery') },
    flush: () => calls.push('flush'), stopUsageAccount: () => calls.push('stopUsage'), restorePlans: new Map([['terminal', {}]]),
    store: { setRestore: (_id, value) => restores.push(value) }, broadcast: () => calls.push('broadcast'),
    t: (_message, { code }) => `exit ${code}`,
  });
  // Execute the production listener registration, then drive its actual onExit callback.
  vm.runInContext(source.slice(source.indexOf('  terminal.onExit(({ exitCode }) => {'), source.indexOf('  captureBranch(project);', source.indexOf('  terminal.onExit(({ exitCode }) => {'))), context);
  return { s, sessions, restores, calls, context };
}

test('main onExit publishes asynchronous native startup failure into session error', async t => {
  const terminal = createNativeSession({ binding: { ...binding, provider: 'claude' }, mode: 'claude-sdk', cwd: process.cwd(), env: {}, cli: fixture,
    launch: () => { throw new Error('synthetic startup failure'); } });
  t.after(() => terminal.kill());
  const h = mainExitFixture(terminal);
  await waitFor(() => h.s.status === 'exited');
  assert.equal(h.s.error, 'native-launch-failed'); assert.equal(h.s.ready, false); assert.equal(h.s.codexActive, false);
  assert.ok(h.calls.includes('broadcast')); assert.equal(terminal.registry.closed, true);
});

test('main onExit publishes safe Node subprocess native stream failure', async t => {
  const terminal = createNativeSession({ binding: { ...binding, provider: 'claude' }, mode: 'claude-sdk', cwd: process.cwd(), env: {}, cli: fixture,
    launch: () => spawn(process.execPath, ['-e', 'process.stdin.resume(); process.stdout.write("invalid json\\n")'], { env: {}, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }) });
  t.after(() => terminal.kill());
  const h = mainExitFixture(terminal);
  await waitFor(() => h.s.status === 'exited'); assert.equal(h.s.error, 'malformed-native-stream');
});

test('main onExit retains native error on zero exit and preserves legacy exit handling and generation guard', () => {
  const { EventEmitter } = require('node:events');
  for (const [error, exitCode, expected] of [['native-process-exit', 0, 'native-process-exit'], [null, 0, null], [null, 3, 'exit 3'], ['legacy-transport-error', 2, 'legacy-transport-error']]) {
    const emitter = new EventEmitter(), terminal = { error, onExit: callback => emitter.on('exit', callback) };
    const h = mainExitFixture(terminal, false); emitter.emit('exit', { exitCode });
    assert.equal(h.s.error, expected); assert.equal(h.s.status, 'exited');
    assert.equal(h.restores.length, exitCode ? 0 : 1);
  }
  const emitter = new EventEmitter(), terminal = { error: 'stale', onExit: callback => emitter.on('exit', callback) };
  const h = mainExitFixture(terminal, false); h.sessions.set('terminal', {}); emitter.emit('exit', { exitCode: 1 });
  assert.equal(h.s.error, null); assert.deepEqual(h.calls, []);
});
