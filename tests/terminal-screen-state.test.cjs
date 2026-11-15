const { test } = require('node:test');
const assert = require('node:assert/strict');
const screen = require('../src/features/terminal/terminal-screen.ts');

function terminal(initial = ['initial']) {
  let rows = initial, parsed;
  return { get rows() { return rows.length; }, buffer: { active: { baseY: 0, getLine: index => ({ translateToString: () => rows[index] }) } },
    onWriteParsed(callback) { parsed = callback; return { dispose() {} }; }, onResize() { return { dispose() {} }; },
    paint(next) { rows = next; }, draw(next) { rows = next; parsed(); } };
}

test('screen revisions and timestamps track changed frames, never repeated cached reads', t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const before = global.window; global.window = { setTimeout }; t.after(() => { global.window = before; });
  const term = terminal(), dispose = screen.registerScreen('versioned', term, 'one'); t.after(dispose);
  const first = screen.readScreen('versioned'); t.mock.timers.tick(5000);
  assert.equal(screen.readScreen('versioned').revision, first.revision); assert.equal(screen.readScreen('versioned').updatedAt, first.updatedAt);
  term.draw(['new']); const next = screen.readScreen('versioned');
  assert.equal(next.sessionId, 'one'); assert.ok(next.revision > first.revision); assert.equal(next.updatedAt, 6000);
});

test('session replacement clears subscriber snapshots and preserves their subscription to the new terminal', t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const before = global.window; global.window = { setTimeout }; t.after(() => { global.window = before; });
  const first = terminal(['old dialog']), offOne = screen.registerScreen('replace', first, 'one'), frames = [];
  const unsubscribe = screen.subscribeScreen('replace', frame => frames.push(frame)); t.after(unsubscribe);
  const oldRevision = frames.at(-1).revision;
  const beforeReplace = frames.length;
  const next = terminal(['new prompt']), offTwo = screen.registerScreen('replace', next, 'two'); t.after(offTwo);
  assert.deepEqual(frames[beforeReplace].rows, []); assert.equal(frames[beforeReplace].sessionId, 'two');
  assert.deepEqual(frames.at(-1).rows, ['new prompt'], 'the replacement publishes its parsed frame immediately');
  offOne(); first.draw(['late old write']); t.mock.timers.tick(100);
  assert.deepEqual(frames.at(-1).rows, ['new prompt']); assert.equal(frames.at(-1).sessionId, 'two'); assert.ok(frames.at(-1).revision > oldRevision);
  offTwo(); assert.deepEqual(frames.at(-1).rows, []); assert.equal(frames.at(-1).sessionId, null);
});

test('background output does not refresh an old working marker over a newer host completion', t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const before = global.window; global.window = { setTimeout }; t.after(() => { global.window = before; });
  const rows = ['✶ Working…', '────', '❯ ', '────'], term = terminal(rows);
  const dispose = screen.registerScreen('background', term, 'one'); t.after(dispose);
  const first = screen.readScreen('background');
  t.mock.timers.tick(2000); term.draw([...rows, 'A background log line']);
  const frame = screen.readScreen('background');
  assert.ok(frame.updatedAt > first.updatedAt); assert.equal(frame.stateUpdatedAt.claude, first.stateUpdatedAt.claude);
  const terminalState = { sessionId: 'one', cliState: { sessionId: 'one', revision: 1, state: 'idle', updatedAt: 2000 } };
  assert.equal(screen.cliStateFor('claude', frame, terminalState).working, false);
});

test('a completed parse publishes readiness even when the rows are unchanged', t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const before = global.window; global.window = { setTimeout }; t.after(() => { global.window = before; });
  const term = terminal(['────', '❯ ', '────']), writes = [], frames = [];
  term.write = (_data, done) => writes.push(done);
  const dispose = screen.registerScreen('parsed', term, 'one'); t.after(dispose);
  const off = screen.subscribeScreen('parsed', frame => frames.push(frame)); t.after(off);
  const first = screen.readScreen('parsed');
  screen.writeScreen('parsed', 'spinner one'); screen.writeScreen('parsed', 'spinner two');
  term.paint(['half drawn input']);
  assert.deepEqual(screen.readScreen('parsed').rows, first.rows, 'pending output never exposes a partially drawn input');
  term.paint(first.rows);
  writes.shift()();
  assert.ok(frames.at(-1).revision > first.revision, 'a completed parse publishes immediately, with more output queued');
  assert.equal(frames.at(-1).parsed, true);
  assert.equal(screen.readScreen('parsed').pending, true, 'approval still knows about outstanding writes');
  const second = frames.at(-1);
  writes.shift()();
  assert.ok(frames.at(-1).revision > second.revision, 'identical rows are a new completed parse');
  assert.deepEqual(frames.at(-1).rows, first.rows);
  assert.equal(screen.readScreen('parsed').revision, frames.at(-1).revision, 'cached reads invent no parse');
  dispose(); const replacement = screen.registerScreen('parsed', term, 'one'); t.after(replacement);
  assert.notEqual(screen.readScreen('parsed').epoch, first.epoch, 'a remount of the same session is another terminal epoch');
});
