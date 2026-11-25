require('./fixtures/team-isolation.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { AgentCalls } = require('../electron/features/agents/agent-calls.cjs');
const { acceptDispatch, validDispatch } = require('../electron/features/agents/dispatch-events.cjs');

test('receipt observation polls after a watch subscription or watch event fails', { timeout: 6000 }, async () => {
  const { EventEmitter } = require('node:events');
  const { DetachedRuns } = require('../integration/dispatch-outbox.cjs');
  const store = new DetachedRuns(os.tmpdir());
  const setupFailure = () => { throw Object.assign(new Error('watch unavailable'), { code: 'ENOSPC' }); };
  const eventFailure = () => {
    const watcher = new EventEmitter();
    watcher.close = () => {};
    queueMicrotask(() => watcher.emit('error', new Error('watch closed')));
    return watcher;
  };
  await Promise.all([setupFailure, eventFailure].map(async watch => {
    let reads = 0;
    assert.equal(await store.observe(() => ++reads === 2 ? 'receipt' : undefined, 4000, { watch }), 'receipt');
    assert.equal(reads, 2);
  }));
});

test('a terminal restart while a worker runs keeps its row: events under the admission key are accepted until the run ends', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-outbox-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = new AgentCalls({ local: false }), id = randomUUID(); t.after(() => calls.dispose());
  const session = { terminalId: 'terminal', sessionKey: 'synthetic-old-key' };
  const declaration = { type: 'dispatch-declared', id, agent: 'claude', role: '执行', title: 'Synthetic restart', helperPid: process.pid,
    cwd: root, worktree: root, requested: { model: 'synthetic-model', effort: 'high', fast: false }, source: 'dispatch', at: 1000 };
  assert.equal(validDispatch(declaration), true);
  const { DispatchInbox } = require('../electron/features/agents/dispatch-inbox.cjs');
  const { DispatchOutbox } = require('../integration/dispatch-outbox.cjs');
  const applied = [], outbox = new DispatchOutbox({ directory: root, id, projectId: 'terminal', sessionKey: session.sessionKey });
  const inbox = new DispatchInbox({ directory: root, projectId: 'terminal', sessionKey: session.sessionKey,
    apply: (event, key) => { applied.push(event.seq); return acceptDispatch(session, { ...event, sessionKey: key }, calls, undefined, key); } });
  t.after(() => inbox.dispose());
  outbox.append(declaration); await inbox.sweep();
  assert.equal(calls.snapshot()[0].items[0].state, 'starting');
  session.sessionKey = 'synthetic-new-key'; await inbox.rotate(session.sessionKey);
  const route = { model: 'synthetic-model', effort: 'high', fast: false };
  outbox.append({ type: 'dispatch-start', id, agent: 'claude', role: '执行', title: declaration.title, cwd: root, brief: '/brief', out: '/out',
    ...route, sessionId: 'synthetic-session', startedAt: 1001 });
  await inbox.sweep(); assert.equal(calls.snapshot()[0].items[0].state, 'running');
  outbox.append({ type: 'dispatch-end', id, ...route, reason: 'exit', exitCode: 0, outputTokens: 1, activeMs: 10, endedAt: 1002 });
  await inbox.sweep(); await inbox.sweep();
  assert.deepEqual(applied, [1, 2, 3]); assert.equal(calls.snapshot()[0].items.length, 1);
  assert.equal(calls.snapshot()[0].items[0].state, 'done');
  const late = outbox.append({ type: 'dispatch-rate', id, outputTokens: 2, activeMs: 20 });
  assert.equal((await inbox.accept(late)).code, 'dispatch.late_after_end');
  const unknown = new DispatchOutbox({ directory: root, id: randomUUID(), projectId: 'terminal', sessionKey: 'synthetic-old-key' });
  assert.equal((await inbox.accept(unknown.append({ ...declaration, id: unknown.id }))).code, 'dispatch.session_mismatch');
});

test('a failed wake retains signed events on disk and only an authenticated acknowledgment removes them', t => {
  const { DispatchOutbox } = require('../integration/dispatch-outbox.cjs');
  const { dispatchFrame } = require('../electron/features/agents/dispatch-events.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-outbox-ack-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let wakes = 0;
  const id = randomUUID(), key = 'synthetic-private-key';
  const outbox = new DispatchOutbox({ directory: root, id, projectId: 'terminal', sessionKey: key, wake: () => { wakes++; throw new Error('offline'); } });
  const frame = outbox.append({ type: 'dispatch-rate', id, outputTokens: 1, activeMs: 10 });
  assert.equal(wakes, 1); assert.equal(outbox.pending().length, 1);
  assert.equal(JSON.stringify(outbox.pending()).includes(key), false);
  const file = path.join(root, id, 'ack.json');
  fs.writeFileSync(file, '{');
  assert.equal(outbox.acknowledged(), 0); assert.equal(outbox.pending().length, 1);
  fs.writeFileSync(file, JSON.stringify({ type: 'dispatch-ack', id, seq: 1, mac: '0'.repeat(64) }));
  assert.equal(outbox.acknowledged(), 0); assert.equal(outbox.pending().length, 1);
  fs.writeFileSync(file, JSON.stringify(dispatchFrame({ type: 'dispatch-ack', id }, { projectId: 'terminal', sessionKey: key, seq: 1 })));
  assert.equal(outbox.acknowledged(), 1); assert.deepEqual(outbox.pending(), []);
  assert.equal(fs.existsSync(path.join(root, id, `${frame.seq}.json`)), false);
});

test('a lost final wake is replayed before dead-helper inference and records the real outcome once', async t => {
  const { DispatchInbox } = require('../electron/features/agents/dispatch-inbox.cjs');
  const { DispatchOutbox } = require('../integration/dispatch-outbox.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-outbox-final-'));
  const session = { terminalId: 'terminal', sessionKey: 'synthetic-key' }, id = randomUUID(), finished = [];
  let inbox, now = 1000;
  const calls = new AgentCalls({ now: () => now, dispatchAlive: () => false, dispatchReplay: () => inbox.sweep(), finished: (_call, event) => finished.push(event.reason) });
  // This test observes delivery and inferred liveness, with no transcript or provider reader.
  calls.feeds.readDispatch = async () => {};
  inbox = new DispatchInbox({ directory: root, projectId: session.terminalId, sessionKey: session.sessionKey,
    apply: (event, key) => acceptDispatch(session, { ...event, sessionKey: key }, calls, undefined, key) });
  t.after(async () => { inbox.dispose(); await inbox.work; calls.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  const outbox = new DispatchOutbox({ directory: root, id, projectId: session.terminalId, sessionKey: session.sessionKey });
  outbox.append({ type: 'dispatch-declared', id, helperPid: process.pid, agent: 'claude', role: '执行', title: 'Synthetic final wake', cwd: root, worktree: root,
    requested: { model: 'synthetic-model', effort: 'high', fast: false }, source: 'dispatch', at: now });
  const route = { model: 'synthetic-model', effort: 'high', fast: false };
  outbox.append({ type: 'dispatch-start', id, agent: 'claude', role: '执行', title: 'Synthetic final wake', cwd: root, brief: '/brief', out: '/out',
    ...route, sessionId: 'synthetic-session', startedAt: now });
  await inbox.sweep();
  outbox.append({ type: 'dispatch-end', id, ...route, reason: 'exit', exitCode: 0, outputTokens: 1, activeMs: 10, endedAt: now });
  await calls.readModels(null, new Set([id]), calls.calls); now += 1001;
  await calls.readModels(null, new Set([id]), calls.calls); await inbox.sweep();
  assert.equal(calls.snapshot()[0].items[0].failure, null); assert.deepEqual(finished, ['exit']);
  assert.equal(outbox.acknowledged(), 3);
});
