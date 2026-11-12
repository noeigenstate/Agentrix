const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { popupHarness, elements } = require('./reading-popup-coverage.test.cjs');
const { hookHarness } = require('./helpers/hook-harness.cjs');
const { cliStateFor } = require('../src/features/agents/agent-screen-state.ts');
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

function busyView(t) {
  const h = popupHarness(t, 'claude', FRAMES.full, 'working');
  h.props.terminal.cliState = { sessionId: 'fixture-session', revision: 1, state: 'working', updatedAt: 10000 };
  let revision = 1, at = 10000;
  const show = (name, wait = 100) => {
    h.view.rows = FRAMES[name]; h.view.frame = { sessionId: 'fixture-session', revision: ++revision, updatedAt: at += wait };
    h.render(); h.tick(wait);
  };
  const stop = () => elements(h.tree()).find(element => element.props.title === '中断（Esc）');
  const look = () => ({ hint: elements(h.tree()).find(element => element.type === 'textarea').props.placeholder, stop: !!stop(), stopDisabled: stop()?.props.disabled });
  const raw = name => { const s = cliStateFor('claude', { rows: FRAMES[name], sessionId: 'fixture-session', revision: ++revision, updatedAt: at + 1 }, h.props.terminal); return { accepting: s.accepting, working: s.working }; };
  show('full');
  return { h, show, look, raw };
}
const flips = values => values.slice(1).filter((value, index) => JSON.stringify(value) !== JSON.stringify(values[index])).length;

test('reproduction: the raw verdict flips on a busy redraw, the message box does not', t => {
  const { show, look, raw } = busyView(t);
  const steady = look();
  assert.deepEqual(steady, { hint: steady.hint, stop: true, stopDisabled: false });
  assert.match(steady.hint, /发消息/);
  const verdicts = [], looks = [];
  for (let round = 0; round < 5; round++) for (const name of REDRAW) { verdicts.push(raw(name)); show(name); looks.push(look()); }
  assert.ok(flips(verdicts) >= 2 * 5, 'the frames themselves flip accepting and working (' + flips(verdicts) + ' flips)');
  assert.equal(flips(looks), 0, 'hint, interrupt button and its enabled state stay as they were');
  assert.deepEqual(looks.at(-1), steady);
});

test('input lost for good: the hint changes after the hold, and returns at once with the box', t => {
  const { show, look } = busyView(t);
  const ready = look().hint;
  show('boxErased', COMPOSER_HOLD_MS - 1); assert.equal(look().hint, ready);
  show('boxErased', 1); assert.match(look().hint, /等待终端输入就绪后发送/); assert.equal(look().stopDisabled, true);
  show('full'); assert.deepEqual(look(), { hint: ready, stop: true, stopDisabled: false });
});

test('work over: the interrupt button leaves after the hold, and returns at once with the spinner', t => {
  const { h, show, look } = busyView(t);
  h.props.terminal.cliState = { ...h.props.terminal.cliState, revision: 2, state: 'idle', updatedAt: 10001 };
  show('spinnerRowErased', COMPOSER_HOLD_MS - 1); assert.equal(look().stop, true);
  show('spinnerRowErased', 1); assert.equal(look().stop, false);
  show('full'); assert.equal(look().stop, true);
});

// A menu or dialog is one frame: accepting turns false and waiting true with no hold, and the box shows and blocks in that render.
for (const [file, hint] of [['claude-permission.txt', /等终端处理完后发送/], ['claude-model-menu.txt', /等终端处理完后发送/], ['claude-investigation-single.txt', /等终端处理完后发送/], ['claude-investigation-trust.txt', /等终端处理完后发送/]]) {
  test(file + ': the frame alone holds delivery, and the box blocks in the same render', t => {
    const terminal = { sessionId: 'fixture-session', agentStartedAt: 0, codexActivity: 'working', needsInput: null,
      cliState: { sessionId: 'fixture-session', revision: 1, state: 'working', updatedAt: 10000 } };
    const state = cliStateFor('claude', { rows: fixture(file), sessionId: 'fixture-session', revision: 2, updatedAt: 10001 }, terminal);
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
