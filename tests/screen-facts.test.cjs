const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseAgentScreen } = require('../src/features/agents/agent-screen.ts');
const { cliInputDraft } = require('../src/features/reading/cli-panel.ts');
const screen = require('../src/features/terminal/terminal-screen.ts');

const footer = ['  ⏺ Opus 5.5 · demo · ctx 4%   ● high · /effort', '  ⏸ manual mode on · ← for agents'];
const half = ['────', '❯ Press up to edit queued messages', '────', ...footer];
const typed = ['────', '❯ my own words', '────', ...footer];
function terminal(initial) {
  let rows = initial, parsed;
  return { get rows() { return rows.length; }, buffer: { active: { baseY: 0, getLine: index => ({ translateToString: () => rows[index] }) } },
    onWriteParsed(callback) { parsed = callback; return { dispose() {} }; }, onResize() { return { dispose() {} }; }, draw(next) { rows = next; parsed(); } };
}
function setup(t, rows, agent) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const before = global.window, sent = [];
  global.window = { setTimeout, agentrix: { screenFacts: (id, facts) => sent.push({ id, ...facts }) } };
  t.after(() => { global.window = before; });
  const term = terminal(rows);
  screen.setScreenAgent('facts', agent);
  const dispose = screen.registerScreen('facts', term, 'one');
  t.after(() => { dispose(); screen.setScreenAgent('facts', null); screen.setQueueCount('facts', 0); });
  return { term, sent };
}

test('a half frame without the queue row keeps the placeholder', () => {
  const parsed = parseAgentScreen('claude', half);
  assert.equal(cliInputDraft('claude', half, parsed), 'Press up to edit queued messages', 'no queue row, no count: typed words');
  assert.equal(cliInputDraft('claude', half, { ...parsed, queued: 2 }), '', 'main holds two queued: the placeholder');
  const own = parseAgentScreen('claude', typed);
  assert.equal(cliInputDraft('claude', typed, { ...own, queued: 2 }), 'my own words', 'a real draft stays one');
});

test('facts are sent on change only, for the current session', t => {
  const { term, sent } = setup(t, typed, 'claude');
  assert.equal(sent.length, 1, 'once at the first parsed frame');
  assert.equal(sent[0].sessionId, 'one'); assert.equal(sent[0].draft, true); assert.equal(sent[0].inputPresent, true);
  assert.deepEqual(Object.keys(sent[0]).sort(), ['busy', 'dialog', 'draft', 'id', 'inputPresent', 'menu', 'queueShown', 'revision', 'sessionId']);
  term.draw([...typed]); term.draw([...typed, 'x']);
  assert.equal(sent.length, 1, 'a frame with the same facts sends nothing');
  term.draw(['────', '❯', '────', ...footer]);
  assert.equal(sent.length, 2); assert.equal(sent[1].draft, false); assert.ok(sent[1].revision > sent[0].revision);
});

test('a queue count change on an unchanged frame reaches the parsed subscribers and main', t => {
  const { sent } = setup(t, half, 'claude'), frames = [];
  t.after(screen.subscribeParsed('facts', frame => frames.push(frame)));
  assert.equal(sent.at(-1).draft, true);
  const before = frames.length, revision = sent.at(-1).revision;
  screen.setQueueCount('facts', 1);
  assert.equal(frames.length, before + 1); assert.equal(frames.at(-1).queued, 1);
  assert.equal(sent.at(-1).draft, false); assert.ok(sent.at(-1).revision > revision);
});

test('a terminal that is not Claude sends nothing', t => {
  const codex = setup(t, typed, 'codex');
  codex.term.draw(['────', '❯', '────', ...footer]);
  screen.setQueueCount('facts', 3);
  assert.equal(codex.sent.length, 0);
});

test('busy is the working line only, never a running ! command', t => {
  const { term, sent } = setup(t, ['! sleep 10', '  ⎿ Running…', '────', '❯', '────', ...footer], 'claude');
  assert.equal(sent.at(-1).busy, false);
  term.draw(['✶ Befuddling… (2s)', '────', '❯', '────', ...footer]);
  assert.equal(sent.at(-1).busy, true);
});
