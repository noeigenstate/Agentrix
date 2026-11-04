const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const os = require('node:os');
const { WebSocket } = require('ws');
const { createNativeSession } = require('../electron/features/terminal/native-session.cjs');
const until = async check => { const end = Date.now() + 4000; while (!check()) { if (Date.now() > end) throw new Error('synthetic resume timeout'); await new Promise(resolve => setTimeout(resolve, 5)); } };

async function fixture(t) {
  const events = [], exits = [], requests = [], cli = { file: 'synthetic-only', prefix: [] };
  let socket, args, output;
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() { this.emit('exit', 0); } });
  child.stdin.on('data', data => { for (const line of data.toString().trim().split('\n')) requests.push(JSON.parse(line)); });
  const terminal = createNativeSession({ binding: { provider: 'codex', sessionId: 'pty', terminalId: 't', projectId: 'p' }, mode: 'codex-native',
    cwd: os.tmpdir(), env: {}, cli: cli, resumeThreadId: 'same-thread', launch: file => { assert.equal(file, cli.file); return child; },
    event: message => events.push(message), pty: { spawn(file, argv, options) {
      assert.equal(file, cli.file); args = argv;
      socket = new WebSocket(argv[argv.indexOf('--remote') + 1], { headers: { Authorization: 'Bearer ' + options.env.AGENTRIX_NATIVE_REMOTE_TOKEN } });
      socket.on('error', () => {});
      return { onData(fn) { output = fn; }, onExit() {}, kill() { socket.terminate(); }, resize() {}, write() {} };
    } } });
  terminal.onExit(value => exits.push(value));
  t.after(async () => { terminal.kill(); if (socket && socket.readyState !== WebSocket.CLOSED) await new Promise(resolve => socket.once('close', resolve)); });
  await until(() => socket?.readyState === WebSocket.OPEN);
  return { terminal, events, exits, requests, args, socket, output: text => output(text),
    server: message => child.stdout.write(JSON.stringify(message) + '\n'),
    resume: () => socket.send(JSON.stringify({ id: '17', method: 'thread/resume', params: { threadId: 'same-thread' } })) };
}
test('Codex TUI resumes the requested thread and only the matching typed RPC response proves readiness', async t => {
  const f = await fixture(t);
  assert.deepEqual(f.args.slice(-2), ['resume', 'same-thread']);
  f.output('\x1b]0;same-thread\x07'); assert.equal(f.events.length, 0, 'title text is not readiness');
  f.server({ method: 'agentrix/threadResumed', params: { threadId: 'same-thread', requestId: '17' } });
  f.server({ id: '17', result: { thread: { id: 'same-thread', status: { type: 'idle' } } } });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(f.events.some(event => event.method === 'agentrix/threadResumed'), false);
  f.resume(); await until(() => f.requests.length === 1);
  f.server({ id: 17, result: { thread: { id: 'same-thread', status: { type: 'idle' } } } });
  assert.equal(f.events.some(event => event.method === 'agentrix/threadResumed'), false);
  f.server({ id: '17', result: { thread: { id: 'same-thread', status: { type: 'idle' } } } });
  await until(() => f.events.some(event => event.method === 'agentrix/threadResumed'));
  assert.deepEqual(f.events.find(event => event.method === 'agentrix/threadResumed').params, { threadId: 'same-thread', requestId: '17' });
  assert.equal(f.exits.length, 0);
});
for (const response of [{ error: { code: -1, message: 'Synthetic failure' } }, { result: { thread: { id: 'another-thread', status: { type: 'idle' } } } },
  { result: { thread: { id: 'same-thread', status: { type: 'active' } } } }]) test(`a failed or wrong Codex resume cannot commit: ${JSON.stringify(response)}`, async t => {
  const f = await fixture(t); f.resume(); await until(() => f.requests.length === 1); f.server({ id: '17', ...response });
  await until(() => f.exits.length); assert.equal(f.events.some(event => event.method === 'agentrix/threadResumed'), false);
});
