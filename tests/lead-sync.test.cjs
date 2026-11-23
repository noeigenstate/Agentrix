const { test } = require('node:test');
const assert = require('node:assert/strict');
const { leadSteps } = require('../src/features/terminal/lead-steps.ts');
const { agentSettings } = require('../electron/features/agents/agent-settings.cjs');
const { applyLeadStep, pickerAction, pickerResult } = require('../src/features/terminal/lead-picker.ts');
const { hookHarness } = require('./helpers/hook-harness.cjs');
const { leadRoutingScope, leadRoutingSnapshot, subscribeLeadRouting } = require('../src/shared/lead-routing-notices.ts');

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
  }, { submitted: command => observed.push(command), confirmed: setting => observed.push(setting) }), true);
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

test('the effort-only switch opens only /effort and uses the displayed session-only key', async () => {
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
  const observed = [], hooks = { submitted: command => observed.push([command, keys.at(-1)]), confirmed: setting => observed.push(setting) };
  assert.equal(await applyLeadStep(step, terminal, hooks), true);
  assert.deepEqual(keys, ['/effort', '\r', '\x1b[C', 's']);
  assert.deepEqual(observed, [['/effort', '/effort'], 'high']);

  keys.length = 0;
  observed.length = 0;
  const oldEcho = { ...terminal, rows: () => [...(keys.at(-1) === 's' ? [] : frames[keys.at(-1)] ?? []), ...frames.s] };
  assert.equal(await applyLeadStep(step, oldEcho, hooks), true);
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
    './terminal-screen': { readScreen: () => ({ sessionId: terminal.sessionId, rows: [] }), canPasteScreen: () => true, subscribeScreen: () => () => {} },
    './lead-picker.ts': { async applyLeadStep(step, picker, hooks) {
      assert.equal(step.kind, 'effort');
      picker.write('/effort');
      assert.equal(leadRoutingSnapshot(scope).length, 0);
      hooks.submitted('/effort');
      assert.equal(leadRoutingSnapshot(scope)[0].submissions[0].command, '/effort');
      picker.write('\r');
      hooks.confirmed(step.target);
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
