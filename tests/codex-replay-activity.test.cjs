require('./fixtures/team-isolation.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { createCodexRuntime } = require('../electron/features/codex-app-server/index.cjs');
const { createEvents } = require('../electron/features/codex-app-server/events.cjs');
const { createRouter } = require('../electron/features/native-session/router.cjs');

// An in-process peer speaking 0.166 envelopes: no executable, account directory or network.
// The resumed thread's history is what an earlier process left behind, newest turn first.
const HISTORY = [
  { id: 'crashed', status: 'inProgress', items: [
    { id: 'command-crashed', type: 'commandExecution', command: 'npm test', status: 'inProgress' },
    { id: 'tool-crashed', type: 'mcpToolCall', server: 'files', tool: 'read', status: 'inProgress' }] },
  { id: 'stopped', status: 'interrupted', items: [{ id: 'command-stopped', type: 'commandExecution', command: 'npm run build', status: 'inProgress' }] },
  { id: 'done', status: 'completed', items: [{ id: 'command-done', type: 'commandExecution', command: 'git status', status: 'completed', exitCode: 0 }] },
];
function server(cwd, running = false) {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = null;
  child.kill = () => { child.exitCode = 0; child.emit('exit', 0); child.emit('close', 0); };
  const send = message => child.stdout.write(JSON.stringify(message) + '\n');
  const thread = id => ({ thread: { id, turns: [], cwd, status: { type: 'idle' } }, cwd, model: 'gpt-6.1-sol', reasoningEffort: 'high', serviceTier: 'default', sandbox: { type: 'readOnly' } });
  child.stdin = new Writable({ write(bytes, _encoding, done) {
    for (const line of bytes.toString().trim().split('\n')) {
      const request = JSON.parse(line); if (request.id == null) continue;
      queueMicrotask(() => {
        const p = request.params || {};
        if (['thread/resume', 'turn/start', 'turn/steer', 'turn/interrupt'].includes(request.method) && !p.threadId) return send({ id: request.id, error: { code: -32602, message: 'missing threadId' } });
        const result = request.method === 'initialize' ? { userAgent: 'codex/0.166.0' }
          : request.method === 'thread/start' ? thread('fresh-thread') : request.method === 'thread/resume' ? thread(p.threadId)
            : request.method === 'thread/turns/list' ? { data: HISTORY, nextCursor: null } : request.method === 'turn/start' ? { turn: { id: 'live', status: 'inProgress', items: [] } } : {};
        // The provider may still be running the newest turn: its live item arrives while the history is being read.
        if (running && request.method === 'thread/turns/list') send({ method: 'item/started', params: { threadId: p.threadId, turnId: 'crashed', item: HISTORY[0].items[0] } });
        send({ id: request.id, result });
      });
    }
    done();
  } });
  return { child, notify: (method, params) => send({ method, params: { threadId: 'old-thread', ...params } }) };
}
async function until(predicate) {
  for (let n = 0; n < 200; n++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error('offline peer timeout');
}

test('a resumed thread’s unfinished history is not running work: a new conversation starts, and work started here still blocks it', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-replay-offline-')), peers = [], sessions = [];
  const provider = createCodexRuntime({ resolveExecutable: async () => 'fake-only', spawnProcess: () => { peers.push(server(root)); return peers.at(-1).child; } });
  const create = provider.create.bind(provider);
  provider.create = (...args) => { sessions.push(create(...args)); return sessions.at(-1); };
  const router = createRouter({ codex: provider, claude: { apiState: () => ({ status: 'no_key' }) }, emit() {}, settings: { get: () => ({}) },
    resolveSpec: () => ({ terminalId: 't', projectId: 'p', owner: 'gui', cwd: root, providerSessionId: 'old-thread', env: { CODEX_HOME: root, PATH: '' } }) });
  t.after(async () => { await router.close(); fs.rmSync(root, { force: true, recursive: true }); });
  const { runtimeSessionId } = await router.start('t', { agent: 'codex', resume: true });
  const [session] = sessions, [peer] = peers, status = id => session.snapshot().items.find(item => item.itemId === id)?.status;
  assert.deepEqual(session.activity(), { known: true, count: 0 }, 'nothing an earlier process left behind is running here');
  assert.deepEqual(['command-crashed', 'tool-crashed', 'command-stopped', 'command-done'].map(status), ['unknown', 'unknown', 'interrupted', 'completed'],
    'a recorded interruption is shown as one; a result nobody recorded is unknown, never running and never done');
  assert.deepEqual(router.snapshot('t').events.filter(event => event.type === 'item.upsert').map(event => event.payload.status).sort(), ['completed', 'interrupted', 'unknown', 'unknown']);

  await router.send('t', runtimeSessionId, { clientMessageId: 'next', text: 'go on' });
  peer.notify('item/started', { turnId: 'live', item: { id: 'command-live', type: 'commandExecution', command: 'npm run watch', status: 'inProgress' } });
  peer.notify('item/started', { turnId: 'live', item: { id: 'spawn', type: 'collabAgentToolCall', tool: 'spawnAgent', receiverThreadIds: ['child-thread'], status: 'inProgress' } });
  await until(() => session.activity().count === 2);
  peer.notify('turn/completed', { turn: { id: 'live', status: 'completed', items: [] } });
  await until(() => session.snapshot().state === 'idle');
  assert.equal(session.activity().count, 1, 'the sub-agent started in this process is still background work');
  assert.deepEqual(['command-live', 'command-crashed', 'command-stopped'].map(status), ['interrupted', 'unknown', 'interrupted'], 'a later turn’s end does not rewrite history');
  await assert.rejects(router.newConversation('t', runtimeSessionId), /请等待当前任务结束/);
  peer.notify('item/completed', { turnId: 'live', item: { id: 'close', type: 'collabAgentToolCall', tool: 'closeAgent', receiverThreadIds: ['child-thread'], status: 'completed' } });
  await until(() => session.activity().count === 0);
  assert.notEqual((await router.newConversation('t', runtimeSessionId)).runtimeSessionId, runtimeSessionId);
});

test('an item this process saw live is not settled by its own copy in the replayed history', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-replay-live-')), seen = [];
  const session = createCodexRuntime({ resolveExecutable: async () => 'fake-only', spawnProcess: () => server(root, true).child })
    .create({ terminalId: 't', projectId: 'p', owner: 'gui', cwd: root, env: { CODEX_HOME: root, PATH: '' } }, event => seen.push(event));
  t.after(async () => { await session.close(); fs.rmSync(root, { force: true, recursive: true }); });
  await session.resume({ providerSessionId: 'old-thread' });
  const status = id => session.snapshot().items.find(item => item.itemId === id)?.status;
  assert.deepEqual([status('command-crashed'), status('tool-crashed'), session.activity().count], ['in-progress', 'unknown', 1], 'the live command still runs; only what nobody saw live is unknown');
  assert.deepEqual(seen.filter(event => event.itemId === 'command-crashed').map(event => [event.replay, event.payload.status]), [[false, 'in-progress']], 'and its replayed copy was not sent after it');
});

test('a replayed item published straight into the event store is settled before it is kept or sent', () => {
  const seen = [], events = createEvents({ projectId: 'p', terminalId: 't', runtimeSessionId: 'r', providerSessionId: 'thread' }, event => seen.push(event), () => 1);
  for (const [itemId, kind, status] of [['old-command', 'command', 'in-progress'], ['old-tool', 'tool', 'pending'], ['old-shell', 'command', 'running'], ['old-done', 'command', 'completed']]) {
    events.publish('item.upsert', { kind, status, content: {} }, { itemId, turnId: 'old-turn', replay: true });
  }
  assert.equal(events.activity().count, 0);
  events.binding.turnId = 'live'; events.beginTurn();
  events.notification('item/started', { turnId: 'live', item: { id: 'live-command', type: 'commandExecution', command: 'npm test', status: 'inProgress' } });
  assert.equal(events.activity().count, 1, 'a command of the live turn counts while it runs');
  events.notification('item/completed', { turnId: 'live', item: { id: 'live-command', type: 'commandExecution', command: 'npm test', status: 'completed', exitCode: 0 } });
  events.finishTurn('completed');
  assert.equal(events.activity().count, 0, 'and the count returns to zero when the turn completes');
  const statuses = ['unknown', 'unknown', 'unknown', 'completed'];
  assert.deepEqual(events.snapshot().items.slice(0, 4).map(item => item.status), statuses);
  assert.deepEqual(seen.filter(event => event.replay).map(event => event.payload.status), statuses, 'the window is sent the settled status too');
});
