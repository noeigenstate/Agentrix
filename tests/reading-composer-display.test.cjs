const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { popupHarness, elements } = require('./reading-popup-coverage.test.cjs');
const { hookHarness } = require('./helpers/hook-harness.cjs');
const { readingState } = require('../src/features/reading/reading-state.ts');
// The reading view's own verdict for one frame: the screen's state plus `accepting`, which the reading module derives.
const frameState = (frame, terminal) => readingState('claude', frame.rows, undefined, terminal, undefined, frame);
const { COMPOSER_HOLD_MS } = require('../src/features/reading/useHeldTrue.ts');

// Claude Code's busy screen as the repo captured it (2.1.296 and 2.1.302 layouts), and the half-drawn frames a redraw of it
// leaves between two samples of the xterm buffer. No live CLI was run: these frames are assembled from the captured rows.
const fixture = name => fs.readFileSync(path.join(__dirname, 'fixtures/screens', name), 'utf8').split(/\r?\n/);
const IDLE = fixture('claude-idle-2-1-296.txt');
const topRule = IDLE.findIndex(row => row.startsWith('────')), SPINNER = '✶ Cogitating… (12s · ↓ 1.2k tokens · esc to interrupt)';
const withSpinner = rows => rows.map((row, index) => index === topRule - 3 ? SPINNER : row);
const FRAMES = {
  full: withSpinner(IDLE),
  spinnerRowErased: IDLE,
  boxErased: withSpinner(IDLE).map((row, index) => index >= topRule - 1 ? '' : row),
  boxHalfDrawn: withSpinner(IDLE).map((row, index) => index > topRule + 1 ? '' : row),
  blank: IDLE.map(() => ''),
};
// The order a busy redraw walks through, repeated: whole frame, rows erased, rows drawn again.
const REDRAW = ['full', 'spinnerRowErased', 'full', 'boxErased', 'full', 'boxHalfDrawn', 'full', 'blank', 'full'];

// A round in progress: the request, a reply so far and a step still running. A result card for it would be a result before its end.
const ROUND = [{ id: 'u1', role: 'user', text: 'fix the parser', at: 1000 }, { id: 'a1', role: 'assistant', text: 'Looking at it.', at: 2000 },
  { id: 't1', role: 'assistant', at: 3000, tool: { kind: 'command', phrase: '运行测试', target: 'npm test', done: false, failed: false, written: [] } }];

function busyView(t) {
  const h = popupHarness(t, 'claude', FRAMES.full, 'working');
  h.setEntries(ROUND);
  h.props.terminal.cliState = { sessionId: 'fixture-session', revision: 1, state: 'working', updatedAt: 10000 };
  let revision = 1, at = 10000;
  const show = (name, wait = 100) => {
    h.view.rows = FRAMES[name]; h.view.frame = { sessionId: 'fixture-session', revision: ++revision, updatedAt: at += wait };
    h.render(); h.tick(wait);
  };
  const stop = () => elements(h.tree()).find(element => element.props.title === '中断（Esc）');
  // The status line and the feed's liveness: the line is display, `live` is what the round has settled into.
  // With a round in the conversation the line goes to the feed through the decorations, otherwise it follows the feed as a step.
  const decorations = () => elements(h.tree()).find(element => element.props.value && 'beforeResult' in element.props.value)?.props.value;
  const line = () => [...elements(h.tree()), ...elements(decorations()?.status)].some(element => typeof element.props.label === 'string' && /正在思考/.test(element.props.label));
  const card = () => !!decorations()?.beforeResult;
  const live = () => elements(h.tree()).find(element => element.type?.name === 'ConversationFeed').props.live;
  const look = () => ({ line: line(), card: card(), hint: elements(h.tree()).find(element => element.type === 'textarea').props.placeholder, stop: !!stop(), stopDisabled: stop()?.props.disabled });
  const raw = name => { const s = frameState({ rows: FRAMES[name], sessionId: 'fixture-session', revision: ++revision, updatedAt: at + 1 }, h.props.terminal); return { accepting: s.accepting, working: s.working }; };
  show('full');
  return { h, show, look, raw, live, card };
}
const flips = values => values.slice(1).filter((value, index) => JSON.stringify(value) !== JSON.stringify(values[index])).length;

test('reproduction: the raw verdict flips on a busy redraw, the message box does not', t => {
  const { show, look, raw } = busyView(t);
  const steady = look();
  assert.deepEqual(steady, { line: true, card: false, hint: steady.hint, stop: true, stopDisabled: false });
  assert.match(steady.hint, /发消息/);
  const verdicts = [], looks = [];
  for (let round = 0; round < 5; round++) for (const name of REDRAW) { verdicts.push(raw(name)); show(name); looks.push(look()); }
  assert.ok(flips(verdicts) >= 2 * 5, 'the frames themselves flip accepting and working (' + flips(verdicts) + ' flips)');
  assert.equal(flips(looks), 0, 'status line, result card, hint, interrupt button and its enabled state stay as they were');
  assert.deepEqual(looks.at(-1), steady);
});

test('input lost for good: the hint changes after the hold, and returns at once with the box', t => {
  const { show, look } = busyView(t);
  const ready = look().hint;
  show('boxErased', COMPOSER_HOLD_MS - 1); assert.equal(look().hint, ready);
  show('boxErased', 1); assert.match(look().hint, /等待终端输入就绪后发送/); assert.equal(look().stopDisabled, true);
  show('full'); assert.deepEqual(look(), { line: true, card: false, hint: ready, stop: true, stopDisabled: false });
});

test('work over: the interrupt button leaves after the hold, and returns at once with the spinner', t => {
  const { h, show, look } = busyView(t);
  h.props.terminal.cliState = { ...h.props.terminal.cliState, revision: 2, state: 'idle', updatedAt: 10001 };
  show('spinnerRowErased', COMPOSER_HOLD_MS - 1); assert.equal(look().stop, true);
  show('spinnerRowErased', 1); assert.equal(look().stop, false); assert.equal(look().line, false);
  show('full'); assert.equal(look().stop, true); assert.equal(look().line, true);
});

test('a round in progress shows no result card and keeps its hint through a redraw; the card comes once the end has lasted the hold', t => {
  const { h, show, look, live, card } = busyView(t);
  const working = look();
  assert.equal(live(), true); assert.equal(card(), false);
  show('spinnerRowErased', COMPOSER_HOLD_MS - 1);
  assert.deepEqual(look(), working, 'no result card, no 继续修改 hint, status line and button as they were'); assert.equal(live(), true);
  show('full', 1); assert.deepEqual(look(), working);
  // The turn really ends: the host says idle and the spinner row stays gone.
  h.props.terminal.cliState = { ...h.props.terminal.cliState, revision: 2, state: 'idle', updatedAt: 20000 };
  h.setEntries(ROUND.map(entry => entry.tool ? { ...entry, tool: { ...entry.tool, done: true } } : entry));
  show('spinnerRowErased', COMPOSER_HOLD_MS - 1); assert.equal(card(), false); assert.equal(look().line, true);
  show('spinnerRowErased', 1);
  assert.equal(card(), true); assert.equal(look().line, false); assert.match(look().hint, /继续修改/); assert.equal(live(), false);
});

// A menu or dialog is one frame: accepting turns false and waiting true with no hold, and the box shows and blocks in that render.
for (const [file, hint] of [['claude-permission.txt', /等终端处理完后发送/], ['claude-model-menu.txt', /等终端处理完后发送/], ['claude-investigation-single.txt', /等终端处理完后发送/], ['claude-investigation-trust.txt', /等终端处理完后发送/]]) {
  test(file + ': the frame alone holds delivery, and the box blocks in the same render', t => {
    const terminal = { sessionId: 'fixture-session', agentStartedAt: 0, codexActivity: 'working', needsInput: null,
      cliState: { sessionId: 'fixture-session', revision: 1, state: 'working', updatedAt: 10000 } };
    const state = frameState({ rows: fixture(file), sessionId: 'fixture-session', revision: 2, updatedAt: 10001 }, terminal);
    assert.equal(state.waiting, true); assert.equal(state.accepting, false); assert.equal(state.canDeliver, false);

    const { h, show, look } = busyView(t);
    FRAMES.menu = fixture(file); show('menu', 1);
    assert.match(look().hint, hint); assert.ok(!look().stop || look().stopDisabled, 'no live interrupt beside a menu');
    h.edit('ordinary message'); h.keys('Enter');
    assert.deepEqual(h.writes, []); assert.deepEqual(h.pastes, []);
    delete FRAMES.menu;
  });
}

test('the hold timer is cleared when the view goes away, and never fires afterwards', t => {
  t.mock.timers.enable({ apis: ['setTimeout'], now: 0 });
  const harness = hookHarness('src/features/reading/useHeldTrue.ts');
  const render = (value, off = false) => harness.render('useHeldTrue', value, off).result;
  assert.equal(render(true), true);
  assert.equal(render(false), true, 'held while the hold runs');
  const cleared = t.mock.method(global, 'clearTimeout');
  harness.dispose();
  assert.equal(cleared.mock.callCount(), 1, 'the pending hold timer is cleared');
  t.mock.timers.tick(COMPOSER_HOLD_MS * 2);
  assert.equal(render(false), true, 'a disposed hold never ran: the held value is still there');
});
