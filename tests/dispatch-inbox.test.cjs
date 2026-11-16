require('./fixtures/team-isolation.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');

test('any order, duplication or loss of wake-ups applies each event once in seq order; a forged MAC or an unknown key is refused with its code', async t => {
  const { DispatchInbox } = require('../electron/features/agents/dispatch-inbox.cjs');
  const { DispatchOutbox } = require('../integration/dispatch-outbox.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-inbox-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // Every permutation of five events, plus duplicated wakes and the empty-wake case.
  function* orders(values) {
    if (!values.length) return yield [];
    for (const value of values) for (const rest of orders(values.filter(item => item !== value))) yield [value, ...rest];
  }
  for (const order of [[], ...orders([0, 1, 2, 3, 4])]) {
    const id = randomUUID(), applied = [], refused = [];
    const outbox = new DispatchOutbox({ directory: root, id, projectId: 'terminal', sessionKey: 'synthetic-admission-key' });
    const frames = [
      { type: 'dispatch-declared', id, helperPid: process.pid, agent: 'claude', role: '执行', title: 'Synthetic task', cwd: root, worktree: root,
        requested: { model: 'synthetic-model', effort: 'high', fast: false }, source: 'dispatch', parentId: null, at: 1000 },
      { type: 'dispatch-start', id, agent: 'claude', role: '执行', title: 'Synthetic task', cwd: root, brief: '/brief', out: '/out',
        model: 'synthetic-model', effort: 'high', fast: false, sessionId: 'synthetic-session', startedAt: 1001 },
      { type: 'dispatch-rate', id, outputTokens: 1, activeMs: 10 },
      { type: 'dispatch-rate', id, outputTokens: 2, activeMs: 20 },
      { type: 'dispatch-end', id, model: 'synthetic-model', effort: 'high', fast: false, reason: 'exit', exitCode: 0,
        outputTokens: 2, activeMs: 20, endedAt: 1002 },
    ].map(event => outbox.append(event));
    const inbox = new DispatchInbox({ directory: root, projectId: 'terminal', sessionKey: 'synthetic-admission-key',
      apply: event => { applied.push(event.seq); return true; }, refused: value => refused.push(value.code) });
    try {
      assert.equal((await inbox.accept({ ...frames[0], mac: '0'.repeat(64) })).code, 'dispatch.invalid_event');
      assert.equal((await inbox.accept({ ...frames[0], keyId: '0'.repeat(64) })).code, 'dispatch.session_mismatch');
      for (const index of order) { await inbox.accept(frames[index]); await inbox.accept(frames[index]); }
      await inbox.sweep(); await inbox.sweep();
      assert.deepEqual(applied, [1, 2, 3, 4, 5], JSON.stringify(order));
      assert.deepEqual(refused, ['dispatch.invalid_event', 'dispatch.session_mismatch']);
      assert.equal(outbox.acknowledged(), 5);
      assert.deepEqual(outbox.pending(), []);
    } finally { inbox.dispose(); }
  }
});

test('the inbox refuses traversal, linked files, malformed events and conflicting sequences without acknowledging them', async t => {
  const { DispatchInbox } = require('../electron/features/agents/dispatch-inbox.cjs');
  const { dispatchFrame } = require('../electron/features/agents/dispatch-events.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-inbox-invalid-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let applied = 0;
  const inbox = new DispatchInbox({ directory: root, projectId: 'terminal', sessionKey: 'synthetic-key', apply: () => applied++ });
  t.after(() => inbox.dispose());
  const event = { type: 'dispatch-rate', id: randomUUID(), outputTokens: 1, activeMs: 1 };
  const frame = dispatchFrame(event, { projectId: 'terminal', sessionKey: 'synthetic-key', seq: 2 });
  assert.equal((await inbox.accept({ ...frame, id: '../escape' })).code, 'dispatch.invalid_event');
  assert.equal((await inbox.accept(frame)).accepted, true);
  const conflict = dispatchFrame({ ...event, outputTokens: 2 }, { projectId: 'terminal', sessionKey: 'synthetic-key', seq: 2 });
  assert.equal((await inbox.accept(conflict)).code, 'dispatch.invalid_event');
  assert.equal((await inbox.accept(dispatchFrame({ ...event, outputTokens: -1 }, { projectId: 'terminal', sessionKey: 'synthetic-key', seq: 1 }))).code, 'dispatch.invalid_event');
  assert.equal(applied, 0);
  assert.equal(fs.existsSync(path.join(root, event.id, 'ack.json')), false);
  const link = path.join(root, randomUUID());
  try { fs.symlinkSync(root, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error; return; }
  await inbox.sweep();
  assert.equal(applied, 0);
});

test('main intake sweeps a registered local outbox after sixty seconds with no wake and acknowledges without repeating accounting', async t => {
  const { createDispatchIntake } = require('../electron/features/agents/dispatch-intake.cjs');
  const { dispatchDirectory } = require('../electron/features/agents/dispatch-events.cjs');
  const { DispatchOutbox } = require('../integration/dispatch-outbox.cjs');
  const { AgentCalls } = require('../electron/features/agents/agent-calls.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-inbox-sweep-'));
  const calls = new AgentCalls({ local: false });
  t.mock.timers.enable({ apis: ['setInterval'] });
  let broadcast, changes = 0;
  const delivered = new Promise(resolve => { broadcast = resolve; });
  const intake = createDispatchIntake({ callsOf: () => calls, broadcast: () => { changes++; broadcast(); }, rememberClaudeSource() {}, send() {} });
  const session = { terminalId: 'terminal', sessionKey: 'synthetic-key', bootstrapFile: path.join(root, 'bootstrap.json') };
  const inbox = intake.bindDispatchInbox(session, { id: 'project', kind: 'local' });
  t.after(async () => { intake.disposeDispatchInbox(); await inbox.work; calls.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  const id = randomUUID(), outbox = new DispatchOutbox({ directory: dispatchDirectory(session.bootstrapFile), id,
    projectId: session.terminalId, sessionKey: session.sessionKey });
  outbox.append({ type: 'dispatch-declared', id, helperPid: process.pid, agent: 'claude', role: '执行', title: 'Synthetic sweep', cwd: root, worktree: root,
    requested: { model: 'synthetic-model', effort: 'high', fast: false }, source: 'dispatch', at: Date.now() });
  t.mock.timers.tick(59999); assert.deepEqual(calls.snapshot(), []);
  t.mock.timers.tick(1);
  let timeout;
  try { await Promise.race([delivered, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('The sixty-second sweep did not publish')), 1500); })]); }
  finally { clearTimeout(timeout); }
  await inbox.work; assert.equal(calls.snapshot()[0].items[0].state, 'starting');
  assert.equal(outbox.acknowledged(), 1); assert.equal(changes, 1);
  await inbox.sweep(); assert.equal(changes, 1); assert.deepEqual(outbox.pending(), []);
});
