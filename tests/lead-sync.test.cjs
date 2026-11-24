const { test } = require('node:test');
const assert = require('node:assert/strict');
const { leadSteps } = require('../src/features/terminal/lead-steps.ts');
const { agentSettings } = require('../electron/features/agents/agent-settings.cjs');
const { applyLeadStep, pickerAction, pickerResult } = require('../src/features/terminal/lead-picker.ts');
const { hookHarness } = require('./helpers/hook-harness.cjs');
const { leadRoutingScope, leadRoutingSnapshot, leadRoutingNotices, routingNotice, subscribeLeadRouting, trackLeadRouting } = require('../src/shared/lead-routing-notices.ts');

// In conductor mode a changed lead seat reaches the running Claude Code as the commands the owner would type.
test('a changed lead model reapplies its effort, while a matched or unknown seat types nothing', () => {
  const running = { model: 'claude-opus-5-5', effort: 'medium', fast: false };
  assert.deepEqual(leadSteps({ model: 'claude-fable-5-2', effort: 'medium' }, running),
    [{ kind: 'model', target: 'claude-fable-5-2' }, { kind: 'effort', target: 'medium' }]);
  assert.deepEqual(leadSteps({ model: 'claude-opus-5-5', effort: 'high' }, running), [{ kind: 'effort', target: 'high' }]);
  assert.deepEqual(leadSteps({ model: 'sonnet', effort: 'low' }, running),
    [{ kind: 'model', target: 'sonnet' }, { kind: 'effort', target: 'low' }]);
  assert.deepEqual(leadSteps({ model: 'opus', effort: 'medium' }, running), [], 'an alias matches the release of its line');
  assert.deepEqual(leadSteps({ model: 'claude-opus-5-5[1m]', effort: 'medium' }, running), [], 'the context variant is the same model');
  assert.deepEqual(leadSteps({ model: 'claude-fable-5-2', effort: 'high' }, { model: null, effort: null, fast: null }), [], 'nothing before the first reply names the model');
  assert.deepEqual(leadSteps(null, running), []);
});

test('steps combine effort and Ultracode before fast and keep fast local and known', () => {
  const seat = { model: 'claude-fable-5-2', effort: 'max', ultracode: true, fast: true };
  const actual = { model: 'Fable 5.2', effort: 'high', fast: false, ultracode: null };
  assert.deepEqual(leadSteps(seat, actual), [
    { kind: 'effort', target: 'max', ultracode: true }, { kind: 'fast', target: true, model: seat.model },
  ]);
  assert.deepEqual(leadSteps(seat, actual, true), [{ kind: 'effort', target: 'max', ultracode: true }]);
  assert.deepEqual(leadSteps(seat, { ...actual, fast: null, effort: 'max', ultracode: true }), []);
  assert.deepEqual(leadSteps({ model: seat.model, effort: 'high' }, { ...actual, ultracode: true, fast: true }),
    [{ kind: 'effort', target: '', ultracode: false }, { kind: 'fast', target: false, model: seat.model }]);
});

test('Claude model echoes match the routed release or alias without hiding a different release', () => {
  const echo = { type: 'user', message: { content: '<local-command-stdout>Set model to `Fable 5.2` and saved as your default for new sessions</local-command-stdout>' } };
  const fable = agentSettings({ model: null, effort: 'medium', fast: false }, 'claude', echo);
  assert.equal(fable.model, 'Fable 5.2');
  assert.deepEqual(leadSteps({ model: 'claude-fable-5-2', effort: 'high' }, fable), [{ kind: 'effort', target: 'high' }]);
  assert.deepEqual(leadSteps({ model: 'claude-fable-5-2', effort: 'medium' }, { ...fable, model: 'Fable 5.2 (1M)' }), []);
  assert.deepEqual(leadSteps({ model: 'opus[1m]', effort: 'medium' }, { ...fable, model: 'Opus 5.5' }), []);
  assert.deepEqual(leadSteps({ model: 'claude-opus-5-5', effort: 'medium' }, { ...fable, model: 'opus' }), []);
  assert.deepEqual(leadSteps({ model: 'claude-fable-5-1', effort: 'medium' }, fable)[0], { kind: 'model', target: 'claude-fable-5-1' });
  const local = { type: 'user', message: { content: '<local-command-stdout>Set model to `Fable 5.2` for this session only</local-command-stdout>' } };
  assert.equal(agentSettings(null, 'claude', local).model, 'Fable 5.2');
});

test('the model picker selects a verified release through the session-only shortcut', () => {
  const step = { kind: 'model', target: 'claude-fable-5-2' };
  const rows = ['  Select model', '  > 1. Default (recommended)  Use the default model (currently Fable 5.2)',
    '    2. Fable                  Fable 5.2 · Most capable', '  s to use this session only · Enter to save · Esc to cancel'];
  assert.equal(pickerAction(step, rows).key, '\x1b[B');
  rows[1] = rows[1].replace('>', ' ');
  rows[2] = rows[2].replace('  ', ' >');
  assert.equal(pickerAction(step, rows).key, 's');
  assert.notEqual(pickerAction({ ...step, target: 'claude-fable-5-1' }, rows).key, 's');
  assert.equal(pickerAction(step, rows.slice(0, -1)), null);
});

// Rows as Claude Code 2.1.331 drew them in a 60-column SSH terminal: labels carry the release and descriptions wrap.
test('an alias seat finds its line when the picker labels lines by release', () => {
  const rows = ['  Select model', '  Your pick is the default for new sessions. For other ', '  models, use --model.', '',
    '  ❯ 1.  Default (recommended)  Opus 5.5', '    2.  Opus 5.5 ✔             For complex work and ', '                               everyday tasks',
    '    3.  Fable 5.2              For your toughest ', '                               challenges',
    '    4.  Sonnet 5.5             Most efficient for ', '                               simpler tasks',
    '    5.  Haiku 5.5              Fastest for quick ', '                               answers', '    ▸   More models             ', '',
    '  s to use this session only · Enter to save · Esc to cancel'];
  assert.equal(pickerAction({ kind: 'model', target: 'haiku' }, rows).key, '\x1b[B');
  rows[4] = rows[4].replace('❯', ' '); rows[11] = rows[11].replace('    5.', '  ❯ 5.');
  assert.equal(pickerAction({ kind: 'model', target: 'haiku' }, rows).key, 's');
  assert.equal(pickerAction({ kind: 'model', target: 'sonnet' }, rows).key, '\x1b[A');
  assert.equal(pickerAction({ kind: 'model', target: 'claude-haiku-5-5' }, rows).key, 's');
});

test('the effort slider uses the label under its caret and never selects an unavailable effort', () => {
  const rows = ['  Effort', '                             ──────────▲───────────────────────────────      Ultracode off',
    '                             low     medium     high     xhigh      max      Tab to toggle',
    '  ←/→ to adjust · s to use this session only · Enter to save · Esc to cancel'];
  assert.equal(pickerAction({ kind: 'effort', target: 'high' }, rows).key, '\x1b[C');
  assert.equal(pickerAction({ kind: 'effort', target: 'medium' }, rows).key, 's');
  assert.equal(pickerAction({ kind: 'effort', target: 'ultracode' }, rows), null);
  assert.equal(pickerAction({ kind: 'effort', target: 'medium' }, rows.slice(0, -1)), null);
});

test('the effort slider uses Enter only when the selected effort advertises a session-only Enter', async () => {
  const keys = [];
  const slider = (caret, footer) => ['  Effort', '                             Faster                             Smarter',
    `                             ${caret}      Ultracode  off`,
    '                             low     medium     high     xhigh      max      Tab to toggle', '', footer];
  const save = '  ←/→ to adjust · s to use this session only · Enter to save · Esc to cancel';
  const sessionOnly = '  ←/→ to adjust · Enter to use this session only · Esc to cancel';
  const frames = [
    slider('────────────────────▲─────────────────────', save),
    slider('──────────────────────────────▲───────────', save),
    slider('────────────────────────────────────────▲─', sessionOnly),
    ['Set effort level to max (this session only): Maximum capability with deepest reasoning.'],
  ];
  const step = { kind: 'effort', target: 'max' };
  assert.equal(pickerAction(step, [...frames[2].slice(0, -1), 'Enter to save · Esc to cancel']), null);
  assert.equal(pickerAction(step, frames[2]).key, '\r');
  assert.equal(pickerAction({ kind: 'effort', target: 'xhigh' }, frames[2]).key, '\x1b[D');
  const observed = [];
  assert.equal(await applyLeadStep(step, {
    rows: () => frames[keys.length - 2] ?? [],
    inputMatches: command => keys.at(-1) === command,
    active: () => true,
    ready: () => !keys.length || keys.length === 5,
    write: key => keys.push(key),
  }, { submitted: command => observed.push(command), observed: (_, changed) => observed.push(changed.effort) }), true);
  assert.deepEqual(keys, ['/effort', '\r', '\x1b[C', '\x1b[C', '\r']);
  assert.deepEqual(observed, ['/effort', 'max']);
});

test('only a matching cache confirmation or session-only echo advances the switch', () => {
  const step = { kind: 'model', target: 'claude-fable-5-2' };
  const rows = ['Switch model?', 'Your next response will be slower and use more tokens', '> 1. Yes, switch to Fable 5.2', '  2. No, go back'];
  assert.equal(pickerResult(step, rows), 'confirm');
  assert.equal(pickerResult(step, rows.filter(row => !row.startsWith('Your'))), null);
  assert.equal(pickerResult(step, ['Set model to Fable 5.2 for this session only']), 'applied');
  assert.equal(pickerResult(step, ['Set model to Fable 5.2 and saved as your default for new sessions']), null);
});

test('the effort-only switch uses the session-only key and does not accept an old confirmation', async t => {
  const step = leadSteps({ model: 'claude-fable-5-2', effort: 'high' }, { model: 'Fable 5.2', effort: 'medium' })[0];
  const keys = [];
  const slider = (mark) => ['Effort', mark, 'low     medium     high', '←/→ to adjust · s to use this session only · Enter to save · Esc to cancel'];
  const frames = {
    '\r': slider('──────────▲───────────'),
    '\x1b[C': slider('────────────────────▲─'),
    s: ['Set effort level to high (this session only): Thorough'],
  };
  const terminal = {
    rows: () => frames[keys.at(-1)] ?? [],
    inputMatches: command => keys.at(-1) === command,
    active: () => true,
    ready: () => !keys.length || keys.at(-1) === 's',
    write: key => keys.push(key),
  };
  assert.equal(await applyLeadStep(step, { ...terminal, active: () => false }), false);
  assert.deepEqual(keys, []);
  const observed = [], hooks = { submitted: command => observed.push([command, keys.at(-1)]), observed: (_, changed) => observed.push(changed.effort) };
  assert.equal(await applyLeadStep(step, terminal, hooks), true);
  assert.deepEqual(keys, ['/effort', '\r', '\x1b[C', 's']);
  assert.deepEqual(observed, [['/effort', '/effort'], 'high']);

  keys.length = 0;
  observed.length = 0;
  const { promise: promptAfterConfirm, resolve: afterConfirm } = Promise.withResolvers();
  const oldEcho = { ...terminal,
    rows: () => [...(keys.at(-1) === 's' ? [] : frames[keys.at(-1)] ?? []), ...frames.s],
    ready: () => { if (keys.at(-1) === 's') afterConfirm(); return terminal.ready(); },
  };
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const stale = applyLeadStep(step, oldEcho, hooks);
  await promptAfterConfirm;
  t.mock.timers.tick(5000);
  assert.equal(await stale, false);
  assert.deepEqual(observed, [['/effort', '/effort']], 'a matching but unchanged confirmation is not reported as a new result');
});

test('an unavailable effort sends one Escape and waits for the empty prompt', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const keys = [];
  let empty = false;
  const { promise: opened, resolve: open } = Promise.withResolvers();
  const { promise: escaped, resolve: escape } = Promise.withResolvers();
  const picker = ['Effort', '────────────────────▲─────────────────────', 'low     medium     high     xhigh      max',
    '←/→ to adjust · s to use this session only · Enter to save · Esc to cancel'];
  let settled = false;
  const result = applyLeadStep({ kind: 'effort', target: 'auto' }, {
    rows: () => empty ? ['Cancelled', '❯'] : picker,
    inputMatches: command => keys.at(-1) === command,
    ready: () => !keys.length || empty,
    active: () => true,
    write(key) {
      keys.push(key);
      if (key === '\r') open();
      if (key === '\x1b') escape();
    },
  }).then(applied => { settled = true; return applied; });
  await opened;
  t.mock.timers.tick(3000);
  await escaped;
  await Promise.resolve();
  assert.equal(settled, false);
  empty = true;
  t.mock.timers.tick(150);
  assert.equal(await result, false);
  assert.deepEqual(keys, ['/effort', '\r', '\x1b']);
});

const sessionSave = '←/→ to adjust · s to use this session only · Enter to save · Esc to cancel';
const sessionEnter = 'Enter to use this session only · Esc to cancel';
function slider(ultracode, effort = 'high', footer = sessionSave) {
  const marker = effort === 'high' ? '────────────────────▲───────────' : '──────────────────────────────▲─';
  return ['Effort', marker + (ultracode === null ? '' : `   Ultracode  ${ultracode ? 'on' : 'off'}`),
    'low     medium     high     xhigh' + (ultracode === null ? '' : '    Tab to toggle'), footer];
}

function screenDriver(frames) {
  const keys = [], events = [];
  const stage = () => frames[keys.length - 2];
  return { keys, events, driver: {
    rows: () => stage()?.rows ?? [], write: key => keys.push(key),
    active: () => true, ready: () => !keys.length || stage()?.ready === true, inputMatches: command => keys.at(-1) === command,
  }, hooks: { submitted() {}, observed: (_, changed) => events.push(changed), failure: reason => events.push(reason) } };
}

test('Ultracode opens, closes or combines with effort in one selector, with wrapped feedback', async () => {
  const cases = [
    ['', true, [slider(false), slider(true, 'high', sessionEnter)], ['Ultracode on (this session only): dynamic workflows on every task.'],
      ['\t', '\r'], { ultracode: true }],
    ['', false, [slider(true), slider(false)], ['Ultracode off (this session only): Effort stays high.'],
      ['\t', 's'], { ultracode: false }],
    ['xhigh', false, [slider(true), slider(true, 'xhigh'), slider(false, 'xhigh')],
      ['  ⎿  Set effort level to xhigh (this session only): Deeper reasoning', '     than high · Ultracode off'],
      ['\x1b[C', '\t', 's'], { effort: 'xhigh', ultracode: false }],
  ];
  for (const [target, ultracode, frames, echo, actions, change] of cases) {
    const { driver, hooks, keys, events } = screenDriver([...frames.map(rows => ({ rows })), { ready: true, rows: echo }]);
    assert.equal(await applyLeadStep({ kind: 'effort', target, ultracode }, driver, hooks), true);
    assert.deepEqual(keys, ['/effort', '\r', ...actions]);
    assert.deepEqual(events, [change]);
  }
});

test('an already matched selector closes silently, and a missing Ultracode toggle still applies effort', async () => {
  const noop = screenDriver([{ rows: slider(true, 'high', sessionEnter) }, { ready: true }]);
  assert.equal(await applyLeadStep({ kind: 'effort', target: 'high', ultracode: true }, noop.driver, noop.hooks), true);
  assert.deepEqual(noop.keys, ['/effort', '\r', '\x1b']);
  assert.deepEqual(noop.events, [{}]);

  const unsupported = screenDriver([{ rows: slider(null) }, { rows: slider(null, 'xhigh') },
    { ready: true, rows: ['Set effort level to xhigh (this session only): Deeper reasoning'] }]);
  assert.equal(await applyLeadStep({ kind: 'effort', target: 'xhigh', ultracode: true }, unsupported.driver, unsupported.hooks), false);
  assert.deepEqual(unsupported.keys, ['/effort', '\r', '\x1b[C', 's']);
  assert.deepEqual(unsupported.events, [{ effort: 'xhigh' }]);
});

test('fast commands report success, CLI refusals and a model takeover', async () => {
  const outcomes = [
    [true, ['↯ Fast mode ON · $16/$80 per Mtok'], true, [{ fast: true }]],
    [false, ['Fast mode OFF'], true, [{ fast: false }]],
    [true, ['  ⎿  Fast mode unavailable: Fast mode requires usage', '     credits · /usage-credits to turn them on'],
      false, ['Fast mode requires usage credits · /usage-credits to turn them on']],
    [true, ['↯ Fast mode ON · model set to Opus 5.5 · $16/$80 per Mtok'], false, [{ fast: true }, 'model set to Opus 5.5']],
  ];
  for (const [target, rows, success, expected] of outcomes) {
    const { driver, hooks, keys, events } = screenDriver([{ ready: true, rows }]);
    assert.equal(await applyLeadStep({ kind: 'fast', target, model: 'claude-fable-5-2' }, driver, hooks), success);
    assert.deepEqual(keys, [target ? '/fast on' : '/fast off', '\r']);
    assert.deepEqual(events, expected);
  }
});

test('routing notices keep the full fast command and describe each confirmed change or refusal', () => {
  const t = (text, values = {}) => text.replace(/\{(\w+)\}/g, (_, key) => values[key]);
  for (const [notice, message] of [
    [{ model: 'Fable 5.2', effort: 'max', fast: true }, '已按模型路由切换到 Fable 5.2 · max · 快速'],
    [{ model: 'Fable 5.2', effort: 'max', ultracode: true }, '已按模型路由切换到 Fable 5.2 · max · Ultracode'],
    [{ fast: true }, '已按模型路由开启快速模式'],
    [{ fast: false }, '已按模型路由关闭快速模式'],
    [{ ultracode: true }, '已按模型路由开启 Ultracode'],
    [{ ultracode: false }, '已按模型路由关闭 Ultracode'],
    [{ fastError: { target: true, reason: 'Exact CLI reason' }, incomplete: true }, '快速模式未开启：Exact CLI reason'],
    [{ fastError: { target: false, reason: 'Exact CLI reason' }, incomplete: true }, '快速模式未关闭：Exact CLI reason'],
  ]) assert.equal(routingNotice(notice, t), message);
  const scope = 'fast-command-receipt';
  const route = trackLeadRouting(scope);
  route.submit('/fast on', 100)(200);
  route.finish({ fast: true });
  const cmd = args => `<command-name>/fast</command-name><command-message>fast</command-message><command-args>${args}</command-args>`;
  const entry = (id, original, at = 150) => ({ id, original, at, text: '/fast', role: 'user' });
  assert.deepEqual([...leadRoutingNotices([entry('off', cmd('off')), entry('on', cmd('on')), entry('old', cmd('on'), 99)], leadRoutingSnapshot(scope))],
    [['on', { fast: true }]]);
  assert.deepEqual([...leadRoutingNotices([entry('raw', '/fast on')], leadRoutingSnapshot(scope))], [['raw', { fast: true }]]);
});

test('a new owner draft does not hide a fast confirmation or receive any keys', async () => {
  const { driver, hooks, keys, events } = screenDriver([{ rows: ['Fast mode OFF', '❯ new owner draft'] }]);
  assert.equal(await applyLeadStep({ kind: 'fast', target: false, model: 'claude-fable-5-2' }, driver, hooks), true);
  assert.deepEqual(keys, ['/fast off', '\r']);
  assert.deepEqual(events, [{ fast: false }]);
});

test('the real xterm screen registry recognizes a prompt with an Ultracode border and protects its draft', async t => {
  const { Terminal } = require('@xterm/xterm');
  const { canPasteScreen, readScreen, registerScreen, setScreenAgent } = require('../src/features/terminal/terminal-screen.ts');
  const id = 'lead-ultracode-screen', terminal = new Terminal({ cols: 70, rows: 10 }), previous = global.window;
  global.window = { setTimeout, agentrix: { screenFacts() {} } };
  setScreenAgent(id, 'claude');
  const unregister = registerScreen(id, terminal, 'pty');
  t.after(() => { unregister(); setScreenAgent(id, null); terminal.dispose(); global.window = previous; });
  const write = draft => new Promise(resolve => terminal.write(
    '\x1b[2J\x1b[H' + ['● high · ultracode · /effort', '───────── ultracode ─', `❯ ${draft}`, '─────────────────────'].join('\r\n'), resolve));
  await write('');
  assert.equal(canPasteScreen('claude', readScreen(id), true), true);
  await write('owner draft');
  assert.equal(canPasteScreen('claude', readScreen(id), true), false);
});

test('lead sync registers only submitted conductor commands under the live conversation', async t => {
  const terminal = { id: 'lead', sessionId: 'pty', agent: 'claude', codexActive: true, readingHistory: { threadId: 'conversation' },
    agentSettings: { model: 'Fable 5.2', effort: 'medium' } };
  const scope = leadRoutingScope(terminal), leads = { claude: { model: 'claude-fable-5-2', effort: 'high' } };
  const native = Promise.resolve({ conductor: false, leads });
  const keys = [];
  let seats = native, reload;
  const previous = global.window;
  global.window = { agentrix: { skillSeats: () => seats, onSkills: load => { reload = load; }, answerTerminal: (_id, key) => keys.push(key) } };
  const harness = hookHarness('src/features/terminal/lead-sync.ts', {
    './i18n': { t: text => text },
    './terminal-screen': { readScreen: () => ({ sessionId: terminal.sessionId, rows: [] }), canPasteScreen: () => true, subscribeScreen: () => () => {} },
    './lead-picker.ts': { async applyLeadStep(step, picker, hooks) {
      assert.equal(step.kind, 'effort');
      picker.write('/effort');
      assert.equal(leadRoutingSnapshot(scope).length, 0);
      hooks.submitted('/effort');
      assert.equal(leadRoutingSnapshot(scope)[0].submissions[0].command, '/effort');
      picker.write('\r');
      hooks.observed({ effort: step.target }, { effort: step.target });
      return true;
    } },
  });
  t.after(() => { harness.dispose(); global.window = previous; });
  harness.render('LeadSync', { projectId: 'project', terminal });
  await native;
  assert.deepEqual(keys, []);
  const completed = new Promise(resolve => {
    const off = subscribeLeadRouting(() => {
      const outcome = leadRoutingSnapshot(scope)[0]?.outcome;
      if (outcome) { off(); resolve(outcome); }
    });
  });
  seats = Promise.resolve({ conductor: true, leads });
  reload();
  assert.deepEqual(await completed, { effort: 'high', incomplete: false });
  assert.deepEqual(keys, ['/effort', '\r']);
});

test('lead sync returns to old targets and retries a failure only after its inputs change', async t => {
  let terminal = { id: 'lead-retry', sessionId: 'pty', agent: 'claude', codexActive: true,
    agentSettings: { model: 'Fable 5.2', effort: 'low', fast: false, ultracode: null } };
  const scope = leadRoutingScope(terminal), attempts = [];
  let effort = 'medium', reload, frame, fail = false;
  const previous = global.window;
  global.window = { agentrix: { skillSeats: async () => ({ conductor: true, leads: { claude: { model: 'claude-fable-5-2', effort } } }),
    onSkills: load => { reload = load; }, answerTerminal() {} } };
  const harness = hookHarness('src/features/terminal/lead-sync.ts', {
    './i18n': { t: text => text },
    './terminal-screen': { readScreen: () => ({ sessionId: terminal.sessionId, rows: [] }), canPasteScreen: () => true,
      subscribeScreen: (_id, callback) => { frame = callback; return () => {}; } },
    './lead-picker.ts': { async applyLeadStep(step, _picker, hooks) {
      attempts.push(step.target);
      hooks.submitted('/effort');
      if (!fail) hooks.observed({ effort: step.target }, { effort: step.target });
      return !fail;
    } },
  });
  t.after(() => { harness.dispose(); global.window = previous; });
  const render = () => harness.render('LeadSync', { projectId: 'project', terminal });
  const change = async (effect, incomplete) => {
    const count = leadRoutingSnapshot(scope).length;
    const ended = new Promise(resolve => {
      const off = subscribeLeadRouting(() => {
        const routes = leadRoutingSnapshot(scope), result = routes.at(-1)?.outcome;
        if (routes.length > count && result) { off(); resolve(result); }
      });
    });
    effect();
    assert.equal((await ended).incomplete, incomplete);
    await Promise.resolve();
  };
  const route = target => { effort = target; reload(); };
  const observed = patch => { terminal = { ...terminal, agentSettings: { ...terminal.agentSettings, ...patch } }; render(); };
  await change(render, false);
  observed({ effort: 'medium' });
  await change(() => route('high'), false);
  observed({ effort: 'high' });
  await change(() => route('medium'), false);
  observed({ effort: 'medium' });
  await change(() => observed({ effort: 'high' }), false);
  observed({ effort: 'medium' });
  fail = true;
  await change(() => route('max'), true);
  frame(); frame(); reload();
  await Promise.resolve();
  assert.deepEqual(attempts, ['medium', 'high', 'medium', 'medium', 'max']);
  await change(() => observed({ fast: true }), true);
  await change(() => route('xhigh'), true);
  await change(() => route('max'), true);
  assert.deepEqual(attempts, ['medium', 'high', 'medium', 'medium', 'max', 'max', 'xhigh', 'max']);
});

test('a fast refusal is the same message in the routing notice and the terminal error', async t => {
  const terminal = { id: 'lead-fast-error', sessionId: 'pty', agent: 'claude', codexActive: true,
    agentSettings: { model: 'Fable 5.2', effort: 'high', fast: false, ultracode: null } };
  const calls = [], reason = 'Fast mode requires usage credits · /usage-credits to turn them on';
  const previous = global.window;
  global.window = { agentrix: { skillSeats: async () => ({ conductor: true, leads: { claude: { model: 'Fable 5.2', effort: 'high', fast: true } } }),
    answerTerminal() {}, leadFastSettings: async (_id, request) => { calls.push(request); return { ok: true, value: request.token ? null : 'token' }; } } };
  const translate = (text, values = {}) => text.replace(/\{(\w+)\}/g, (_, key) => values[key]);
  const harness = hookHarness('src/features/terminal/lead-sync.ts', {
    './i18n': { t: translate },
    './terminal-screen': { readScreen: () => ({ sessionId: terminal.sessionId, rows: [] }), canPasteScreen: () => true, subscribeScreen: () => () => {} },
    './lead-picker.ts': { async applyLeadStep(_step, _picker, hooks) { hooks.submitted('/fast on'); hooks.failure(reason); return false; } },
  });
  t.after(() => { harness.dispose(); global.window = previous; });
  const { promise, resolve } = Promise.withResolvers();
  harness.render('LeadSync', { projectId: 'project', terminal, onError: resolve });
  const message = await promise;
  assert.equal(message, `快速模式未开启：${reason}`);
  assert.equal(message, routingNotice(leadRoutingSnapshot(leadRoutingScope(terminal)).at(-1).outcome, translate));
  assert.deepEqual(calls, [{ sessionId: 'pty', target: true }, { token: 'token', confirmed: false }]);
});
