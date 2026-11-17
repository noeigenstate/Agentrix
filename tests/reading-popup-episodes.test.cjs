const { test } = require('node:test');
const assert = require('node:assert/strict');
const jsx = require('react/jsx-runtime');
const { hookHarness } = require('./helpers/hook-harness.cjs');
const { popupHarness, elements } = require('./reading-popup-coverage.test.cjs');
const fs = require('node:fs');
const path = require('node:path');
const { canPasteScreen, beginScreenPaste, recordScreenPaste } = require('../src/features/terminal/terminal-screen.ts');

const prompt = ['Do you want to proceed?', '❯ 1. Yes', '  2. No', 'Esc to cancel'];

test('a hidden project does not spend its prompt opening; showing it opens the popup', t => {
  const h = popupHarness(t, 'claude');
  h.props.visible = false; h.view.rows = prompt; h.view.frame = { epoch: 1, instances: { claude: 1 } }; h.render();
  assert.equal(h.popup(), undefined);
  h.props.visible = true; h.render(); assert.ok(h.popup());
  h.props.visible = false; h.render(); assert.equal(h.popup(), undefined);
  h.props.visible = true; h.render(); assert.ok(h.popup(), 'visibility loss rearms this instance');
});

test('collapse then expand and split deselection rearm the same prompt', t => {
  const h = popupHarness(t, 'claude'); h.props.autoFocus = true; h.view.rows = prompt; h.render(); assert.ok(h.popup());
  h.props.autoFocus = false; h.render(); assert.equal(h.popup(), undefined);
  h.props.autoFocus = true; h.render(); assert.ok(h.popup());
  h.props.active = false; h.render(); assert.equal(h.popup(), undefined);
  h.props.active = true; h.render(); assert.ok(h.popup());
});

test('explicit dismissal keeps prompt A closed, but prompt B in the same conversation opens', t => {
  const h = popupHarness(t, 'claude'); h.view.rows = prompt; h.view.frame = { epoch: 1, instances: { claude: 1 } }; h.render();
  h.popup().props.onClose(); h.render(); assert.equal(h.popup(), undefined); assert.ok(h.waiting());
  h.props.visible = false; h.render(); h.props.visible = true; h.render(); assert.equal(h.popup(), undefined);
  h.view.rows = ['Run the next command?', ...prompt.slice(1)]; h.view.frame.instances.claude = 2; h.render();
  assert.ok(h.popup(), 'another instance needs its own opening, with no idle frame between');
});

test('an implicit popup failure rearms it for the next visible visit', t => {
  const h = popupHarness(t, 'claude'); h.view.rows = prompt; h.render();
  h.popup().props.onClose(false, true); h.render(); assert.equal(h.popup(), undefined);
  h.props.visible = false; h.render(); h.props.visible = true; h.render(); assert.ok(h.popup());
});

test('a run-mode handoff rearms the prompt without opening it during the switch', t => {
  const h = popupHarness(t, 'claude'); h.view.rows = prompt; h.render(); assert.ok(h.popup());
  h.props.handoff = { locked: true, incoming: null, offer() {}, take() {} }; h.render(); assert.equal(h.popup(), undefined);
  h.props.handoff.locked = false; h.render(); assert.ok(h.popup());
});

// Mount the real popup with DOM ownership and xterm mounting as stand-ins. The listener and close controls are real.
function popupSurface(t, failMount = false) {
  const before = global.document, listeners = new Map(), closed = [], errors = [], panel = {};
  const host = { closest: () => panel };
  global.document = { addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) };
  const h = hookHarness('src/features/reading/ReadingTerminalPopup.tsx', {
    'react/jsx-runtime': { ...jsx, jsx: (type, props) => { if (props.className === 'terminal-host') props.ref.current = host; return jsx.jsx(type, props); } },
    '@phosphor-icons/react': { TerminalWindow() {}, X() {} }, './reading-terminal-popup.css': {}, './i18n': { t: text => text },
    './terminal-popup': { mountReadingTerminal() { if (failMount) throw Error('mount failed'); return () => {}; } },
  });
  t.after(() => { h.dispose(); global.document = before; });
  const tree = h.render('ReadingTerminalPopup', { terminalId: 'this-split', sessionId: 'session', command: '', onReady() {},
    onClose: (...args) => closed.push(args), onError: message => errors.push(message) }).result;
  return { tree, closed, errors, switchTo(project, terminalId, event = 'pointerdown') {
    listeners.get(event)({ target: { closest: () => ({ dataset: { terminalId }, closest: () => project === 'same' ? panel : {} }) } });
  } };
}

test('popup clicks and focus in another project never close it; another split closes implicitly', t => {
  const h = popupSurface(t);
  for (const event of ['pointerdown', 'focusin']) h.switchTo('other', 'other-terminal', event);
  assert.deepEqual(h.closed, []);
  h.switchTo('same', 'other-terminal'); assert.deepEqual(h.closed, [[false, true]]);
});

test('popup mount failure is implicit; X, backdrop and popup cancellation are explicit', t => {
  const h = popupSurface(t, true); assert.deepEqual(h.closed, [[false, true]]); assert.match(h.errors[0], /mount failed/);
  const nodes = elements(h.tree);
  nodes.find(node => node.type === 'button').props.onClick();
  h.tree.props.onMouseDown({ button: 0, target: h.tree, currentTarget: h.tree, preventDefault() {} });
  nodes.find(node => node.type === 'dialog').props.onCancel({ preventDefault() {} });
  assert.deepEqual(h.closed.slice(1), [[], [], []]);
});

test('the paste receiver refuses a prompt or pending output, including lineBreak packets', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/features/terminal/TerminalPane.tsx'), 'utf8');
  const start = source.indexOf('    const offPaste = '), end = source.indexOf('    const selection = ', start);
  assert.ok(start > 0 && end > start);
  const writes = []; let receive, frame = { rows: prompt, pending: false };
  // The actual receiver, including its final pre-paste guard. No xterm, preload or PTY is started.
  Function('window', 'disposed', 'id', 'sessionId', 'readScreen', 'currentAgent', 'terminal', 'canPasteScreen', 'recordScreenPaste', source.slice(start, end))(
    { agentrix: { onTerminalPaste(fn) { receive = fn; } } }, false, 'terminal', 'session', () => frame, { current: 'claude' },
    { paste: text => writes.push(text), input: text => writes.push(text) }, canPasteScreen, recordScreenPaste);
  const receipt = beginScreenPaste('terminal', 'session', 'held words');
  for (const lineBreak of [undefined, '\x1b\r']) receive({ id: 'terminal', sessionId: 'session', text: 'held words', lineBreak });
  assert.deepEqual(writes, []);
  assert.equal(receipt.status, 'refused', 'the receiver supplies positive no-write evidence, even if IPC accepted the request');
  frame = { rows: ['────', '❯ ', '────'], pending: true };
  receive({ id: 'terminal', sessionId: 'session', text: 'held words' }); assert.deepEqual(writes, []);
  frame.pending = false; receive({ id: 'terminal', sessionId: 'session', text: 'held words' }); assert.deepEqual(writes, ['held words']);
});
