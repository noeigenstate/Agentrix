const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createSwitches } = require('../electron/features/native-session/switches.cjs');
const { createRouter } = require('../electron/features/native-session/router.cjs');
const { createEventStream } = require('../electron/features/native-session/events.cjs');
const { validEvent, validHandoff, validSwitchAnswer } = require('../electron/features/native-session/validate.cjs');

const settle = async () => { await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)); };
const draft = (version = 1) => ({ version, text: 'Owner draft', images: ['data:image/png;base64,AA=='],
  undelivered: [{ clientMessageId: 'unsent', text: 'Not delivered yet' }] });
function fixture(t, { path: current = 'terminal', state = 'idle', background = { known: true, count: 0 }, sessions: extra = [] } = {}) {
  const session = { identity: {}, path: current, spec: { owner: 'gui', agent: 'claude', projectId: 'p', terminalId: 't', runtimeSessionId: 'old', providerSessionId: 'same-provider' } };
  let live = [session, ...extra], target = current === 'terminal' ? 'api' : 'terminal';
  const activity = { state, background, pending: false, draftBlocked: false }, events = [], preparations = [], commits = [], cancellations = [];
  let fail = false, delayed;
  const switches = createSwitches({ list: () => live, choose: () => ({ path: target }), observe: () => activity,
    publish: (value, payload) => events.push({ terminalId: value.spec.terminalId, payload: structuredClone(payload) }),
    async prepare(value, selected, handoff) {
      preparations.push({ value, selected, handoff });
      if (delayed) await delayed;
      if (fail) throw new Error('Synthetic failure before any input');
      return { session: { ...value, path: selected, identity: {}, spec: { ...value.spec, runtimeSessionId: 'new' } },
        commit() { commits.push(handoff); live = [{ ...value, path: selected, identity: {}, spec: { ...value.spec, runtimeSessionId: 'new' } }]; },
        cancel() { cancellations.push(selected); } };
    } });
  t.after(() => switches.close());
  const answer = action => switches.answer('t', 'old', { switch: { ...switches.state('t'), action } });
  const handoff = value => switches.answer('t', 'old', { handoff: { changeId: switches.state('t').changeId, draft: value || draft() } });
  return { switches, activity, events, preparations, commits, cancellations, answer, handoff,
    target: value => { target = value; }, fail: () => { fail = true; }, delay: value => { delayed = value; }, live: () => live };
}

for (const current of ['terminal', 'api']) test(`I1/I2: ${current} hands draft/images/unsent input over once without submitting it`, async t => {
  const f = fixture(t, { path: current }); f.switches.reconcile(); await settle();
  assert.equal(f.switches.state('t').phase, 'preparing'); assert.equal(f.preparations.length, 0, 'old input stays until its acknowledged handoff');
  assert.deepEqual(f.handoff(), { changeId: 1, version: 1, accepted: true }); await settle();
  assert.equal(f.commits.length, 1); assert.deepEqual(f.commits[0].draft, draft());
  assert.equal(f.switches.state('t').phase, 'stable'); assert.equal(f.switches.waiting(), 0);
  for (let i = 0; i < 4; i++) f.switches.observe('t'); await settle();
  assert.equal(f.commits.length, 1); assert.equal(f.handoff().accepted, false);
});

test('I2: unreadable CLI input and a later edit preserve the old input surface', async t => {
  const f = fixture(t); f.activity.draftBlocked = true; f.switches.reconcile(); await settle();
  assert.equal(f.switches.state('t').phase, 'waiting-turn'); assert.equal(f.switches.state('t').reason, '输入框里有未发送的文字');
  assert.equal(f.handoff().accepted, false); assert.equal(f.preparations.length, 0);
  f.activity.draftBlocked = false; f.switches.observe('t'); await settle();
  let release; f.delay(new Promise(resolve => { release = resolve; })); f.handoff(); await settle();
  f.activity.draftBlocked = true; release(); await settle();
  assert.equal(f.commits.length, 0); assert.equal(f.cancellations.length, 1); assert.equal(f.switches.state('t').phase, 'waiting-turn');
});

test('I3/I7: switch state updates and replay do not arm completion or expand a project', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
  const host = {}, calls = [];
  const context = { quitting: false, sessions: new Map([['t', host]]), scheduleState: () => calls.push('state') };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function structuredEvent('), source.indexOf('async function readNativeConnections(')), context);
  const state = { changeId: 1, current: 'api', target: 'terminal', phase: 'preparing', background: { count: 0, known: true }, requestId: null, reason: null };
  context.structuredEvent('t', { type: 'switch.updated', payload: state, runtimeSessionId: 'r', replay: true });
  assert.equal(calls.length, 0);
  context.structuredEvent('t', { type: 'switch.updated', payload: state, runtimeSessionId: 'r' });
  assert.deepEqual(calls, ['state']); assert.equal(host.switchState, state);
});

test('I4: preparation failure retains the old path with a readable reason and never retries at idle', async t => {
  const f = fixture(t); f.fail(); f.switches.reconcile(); await settle(); f.handoff(); await settle();
  assert.equal(f.commits.length, 0); assert.equal(f.live()[0].path, 'terminal');
  assert.equal(f.switches.state('t').phase, 'stable'); assert.match(f.switches.state('t').reason, /已保留原会话/);
  f.switches.observe('t'); await settle(); assert.equal(f.preparations.length, 1);
});

test('I4: failure during commit restores the source, retrying temporary restore failures without losing a newer draft', async t => {
  let source = { identity: {}, path: 'terminal', spec: { owner: 'gui', agent: 'claude', terminalId: 't', runtimeSessionId: 'old' } };
  let restores = 0, restoredDraft;
  const switches = createSwitches({ list: () => [source], choose: () => ({ path: 'api' }), retryMs: 5,
    observe: () => ({ state: 'idle', background: { known: true, count: 0 } }), publish() {},
    async prepare(value, selected, handoff, _current, restoring) {
      if (restoring && ++restores === 1) throw new Error('Synthetic temporary restore failure');
      const session = { ...value, identity: {}, path: selected, spec: { ...value.spec, runtimeSessionId: restoring ? 'restored' : 'new' } };
      return { session, cancel() {}, commit() {
        source = session;
        if (restoring) restoredDraft = structuredClone(handoff.draft);
        else assert.equal(switches.failed('t', 'new'), true, 'failure can arrive before the commit promise completes');
      } };
    } });
  t.after(() => switches.close());
  switches.reconcile(); await settle();
  switches.answer('t', 't', { handoff: { changeId: switches.state('t').changeId, draft: draft(1) } }); await settle();
  assert.equal(switches.state('t').target, 'terminal'); assert.equal(switches.state('t').phase, 'preparing');
  const changeId = switches.state('t').changeId;
  assert.equal(switches.answer('t', 'new', { handoff: { changeId, draft: draft(2) } }).accepted, true); await settle();
  assert.equal(switches.state('t').phase, 'rolling-back'); assert.match(switches.state('t').reason, /草稿已保留/);
  const deadline = Date.now() + 1000;
  while (switches.state('t').phase !== 'stable' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(restores, 2); assert.equal(switches.state('t').current, 'terminal');
  assert.match(switches.state('t').reason, /已恢复原会话/); assert.deepEqual(restoredDraft, draft(2));
});

test('I5/I6: dispatch workers, shells, and SSH projects never enter switch preparation', async t => {
  const extra = [
    { identity: {}, path: 'api', spec: { terminalId: 'worker', agent: 'claude', owner: 'dispatch' } },
    { identity: {}, path: 'terminal', spec: { terminalId: 'remote', agent: 'codex', kind: 'ssh' } },
    { identity: {}, path: 'terminal', spec: { terminalId: 'shell', agent: null } },
  ];
  const f = fixture(t, { sessions: extra }); f.switches.reconcile(); await settle(); f.handoff(); await settle();
  assert.equal(f.preparations.length, 1); assert.equal(f.preparations[0].value.spec.providerSessionId, 'same-provider');
  assert.ok(f.events.every(event => event.terminalId === 't'));
});

test('I8: quick changes collapse to the latest target and cancel an in-flight obsolete preparation', async t => {
  const f = fixture(t); f.switches.reconcile(); await settle();
  const oldId = f.switches.state('t').changeId;
  let release; f.delay(new Promise(resolve => { release = resolve; })); f.handoff(); await settle();
  f.target('terminal'); f.switches.reconcile(); f.target('api'); f.switches.reconcile();
  assert.equal(f.switches.answer('t', 'old', { handoff: { changeId: oldId, draft: draft(2) } }).accepted, false);
  release(); await settle(); assert.equal(f.commits.length, 0); assert.equal(f.cancellations.length, 1);
  f.handoff(draft(3)); await settle(); assert.equal(f.commits.length, 1);
  assert.equal(f.switches.state('t').current, 'api');
});

test('F9/F24 unchanged routing preserves a background choice; an obsolete failure never overwrites a newer success', async t => {
  const f = fixture(t, { background: { known: false, count: null } }); f.switches.reconcile(); await settle();
  f.answer('wait'); const waiting = structuredClone(f.switches.state('t'));
  f.switches.reconcile(); await settle(); assert.deepEqual(f.switches.state('t'), waiting);
  f.answer('now'); await settle();
  let release; f.delay(new Promise(resolve => { release = resolve; })); f.handoff(); await settle();
  f.target('terminal'); f.switches.reconcile(); f.fail(); release(); await settle();
  assert.equal(f.switches.state('t').phase, 'stable'); assert.equal(f.switches.state('t').reason, null);
});

test('F10 permanent recovery failure stops after a bounded number of attempts and keeps the last draft', async t => {
  let source = { identity: {}, path: 'terminal', spec: { owner: 'gui', agent: 'claude', terminalId: 't', runtimeSessionId: 'old' } }, attempts = 0, retired = 0;
  const switches = createSwitches({ list: () => [source], choose: () => ({ path: 'api' }), retryMs: 1, maxRetries: 2,
    observe: () => ({ state: 'idle', background: { known: true, count: 0 } }), publish() {}, retire() { retired++; },
    async prepare(value, selected, _handoff, _current, restoring) {
      if (restoring) { attempts++; throw new Error('Synthetic restore unavailable'); }
      const session = { ...value, identity: {}, path: selected, spec: { ...value.spec, runtimeSessionId: 'new' } };
      return { session, cancel() {}, commit() { source = session; } };
    } });
  t.after(() => switches.close()); switches.reconcile(); await settle();
  switches.answer('t', 't', { handoff: { changeId: switches.state('t').changeId, draft: draft() } }); await settle();
  switches.failed('t', 'new'); await settle();
  switches.answer('t', 'new', { handoff: { changeId: switches.state('t').changeId, draft: draft(2) } });
  const end = Date.now() + 1000;
  while (switches.state('t').phase !== 'stable' && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(attempts, 2); assert.equal(retired, 1); assert.match(switches.state('t').reason, /重新启动/);
  assert.equal(switches.handoff('t').draft.version, 2);
  switches.observe('t'); await settle(); assert.equal(attempts, 2);
});

for (const background of [{ known: true, count: 2 }, { known: false, count: null }]) test(`background choice is required for ${JSON.stringify(background)} and stale answers are ignored`, async t => {
  const f = fixture(t, { background }); f.switches.reconcile(); await settle();
  assert.equal(f.switches.state('t').phase, 'awaiting-choice');
  const old = f.switches.state('t'); f.target('terminal'); f.switches.reconcile(); await settle();
  f.target('api'); f.switches.reconcile(); await settle();
  assert.equal(f.switches.answer('t', 'old', { switch: { changeId: old.changeId, requestId: old.requestId, action: 'now' } }).accepted, false);
  assert.equal(f.answer('wait').accepted, true); await settle(); assert.equal(f.switches.state('t').phase, 'waiting-background');
  f.activity.background = { known: true, count: 0 }; f.switches.observe('t'); await settle();
  f.handoff(); await settle(); assert.equal(f.commits.length, 1);
});

test('working, approval wait and queued input must end before a switch, including stop followed by idle', async t => {
  const f = fixture(t, { state: 'running' }); f.switches.reconcile(); await settle();
  assert.equal(f.switches.state('t').phase, 'waiting-turn');
  f.activity.state = 'waiting'; f.switches.observe('t'); await settle(); assert.equal(f.preparations.length, 0);
  f.activity.state = 'idle'; f.activity.pending = true; f.switches.observe('t'); await settle(); assert.equal(f.preparations.length, 0);
  f.activity.pending = false; f.switches.observe('t'); await settle(); f.handoff(); await settle(); assert.equal(f.commits.length, 1);
});

test('IPC accepts bounded frozen switch/handoff shapes and rejects extra options, invalid versions and file paths', () => {
  assert.ok(validSwitchAnswer({ switch: { changeId: 1, requestId: 'request', action: 'now' } }));
  assert.ok(validHandoff({ handoff: { changeId: 1, draft: draft() } }));
  for (const bad of [{ ...draft(), version: -1 }, { ...draft(), images: ['/private/file.png'] }, { ...draft(), env: {} }, { ...draft(), undelivered: [{ clientMessageId: 'x', text: 'x', cwd: '/escape' }] }]) {
    assert.equal(validHandoff({ handoff: { changeId: 1, draft: bad } }), false);
  }
  assert.equal(validSwitchAnswer({ switch: { changeId: 1, requestId: 'request', action: 'now', cwd: '/escape' } }), false);
  const stream = createEventStream({ projectId: 'p', terminalId: 't', runtimeSessionId: 'r' }, () => {}, () => 1);
  assert.ok(validEvent(stream.publish('switch.updated', { changeId: 1, current: 'api', target: 'terminal', phase: 'awaiting-choice', background: { count: null, known: false }, requestId: 'request', reason: null })));
});

test('I1: router freezes new input, preserves receipts, and never hands delivered or unknown messages back as unsent', async t => {
  let config = { claudePath: 'api-only', monthlyBudgetUsd: 10 }, source;
  const provider = { credentials: { clear: () => ({ saved: false }) }, apiState: () => ({ status: 'ready' }), usage: { summary: () => ({}) }, create(spec, emit) {
    const stream = createEventStream(spec, emit); source = stream;
    return { start() { stream.provider('provider'); stream.publish('session.state', { state: 'idle', reason: null }); },
      snapshot: () => ({ ...stream.snapshot(), state: 'idle' }), activity: () => ({ known: true, count: 0 }),
      send() { assert.fail('a frozen or previously delivered input cannot reach a provider'); }, close() {} };
  } };
  const router = createRouter({ claude: provider, settings: { get: () => config }, emit() {}, resolveSpec: id => ({ owner: 'gui', projectId: 'p', terminalId: id, agent: 'claude' }), terminal() {} });
  t.after(() => router.close());
  const started = await router.start('t', { agent: 'claude' });
  source.publish('input.receipt', { clientMessageId: 'delivered', status: 'delivered' });
  source.publish('input.receipt', { clientMessageId: 'uncertain', status: 'unknown' });
  config = { ...config, claudePath: 'terminal-only' }; router.reconcile(); await settle();
  assert.equal((await router.send('t', started.runtimeSessionId, { clientMessageId: 'delivered', text: 'already executed' })).status, 'delivered');
  assert.equal((await router.send('t', started.runtimeSessionId, { clientMessageId: 'fresh', text: 'keep me', images: ['data:image/png;base64,AA=='] })).status, 'rejected');
  const handoff = { changeId: router.switchState('t').changeId, draft: { ...draft(), undelivered: ['delivered', 'uncertain', 'fresh'].map(clientMessageId => ({ clientMessageId, text: clientMessageId })) } };
  assert.equal(router.answer('t', started.runtimeSessionId, 'handoff', { handoff }).accepted, true);
  assert.deepEqual(router.snapshot('t').handoff.draft.undelivered.map(input => input.clientMessageId), ['fresh']);
});
