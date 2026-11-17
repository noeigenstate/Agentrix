const { test } = require('node:test');
const assert = require('node:assert/strict');
const jsx = require('react/jsx-runtime');
const { hookHarness } = require('./helpers/hook-harness.cjs');
const { popupHarness, elements } = require('./reading-popup-coverage.test.cjs');
const fs = require('node:fs');
const path = require('node:path');
const screens = require('../src/features/terminal/terminal-screen.ts');
const { canPasteScreen, beginScreenPaste, recordScreenPaste, hasScreenPaste } = screens;
const { DIALOG_SETTLE } = require('../src/features/reading/reading-ready.ts');
const { registerReadingTerminal, mountReadingTerminal } = require('../src/features/terminal/terminal-popup.ts');
const { parseAgentScreen } = require('../src/features/agents/agent-screen.ts');

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

function pasteReceiver(readScreen, paste) {
  const source = fs.readFileSync(path.join(__dirname, '../src/features/terminal/TerminalPane.tsx'), 'utf8');
  const start = source.indexOf('    const offPaste = '), end = source.indexOf('    const selection = ', start);
  assert.ok(start > 0 && end > start);
  let receive;
  // The actual receiver, including its final pre-paste guard. No xterm, preload or PTY is started.
  return (id, sessionId) => {
    Function('window', 'disposed', 'id', 'sessionId', 'readScreen', 'currentAgent', 'terminal', 'canPasteScreen', 'recordScreenPaste', 'hasScreenPaste', source.slice(start, end))(
      { agentrix: { onTerminalPaste(fn) { receive = fn; } } }, false, id, sessionId, readScreen, { current: 'claude' },
      { paste, input: paste }, canPasteScreen, recordScreenPaste, hasScreenPaste);
    return receive;
  };
}

test('a tracked paste refuses a parsed prompt; pending output and untracked callers still paste', () => {
  const writes = []; let frame = { rows: prompt, pending: false };
  const receive = pasteReceiver(() => frame, text => writes.push(text))('terminal', 'session');
  for (const lineBreak of [undefined, '\x1b\r']) {
    const receipt = beginScreenPaste('terminal', 'session', 'held words');
    receive({ id: 'terminal', sessionId: 'session', text: 'held words', lineBreak });
    assert.equal(receipt.status, 'refused');
  }
  assert.deepEqual(writes, []);
  receive({ id: 'terminal', sessionId: 'session', text: 'owner paste' });
  assert.deepEqual(writes, ['owner paste'], 'untracked callers retain their normal terminal behavior');
  frame = { rows: ['────', '❯ ', '────'], pending: true };
  const receipt = beginScreenPaste('terminal', 'session', 'held words');
  receive({ id: 'terminal', sessionId: 'session', text: 'held words' });
  assert.equal(receipt.status, 'accepted'); assert.deepEqual(writes, ['owner paste', 'held words']);
});

test('send-to-agent reaches an untracked receiver during pending output and reports actual success', async t => {
  const { agentHarness } = require('./send-to-agent.test.cjs');
  const h = agentHarness(t, 'claude', { working: true }), paste = h.bridge.pasteTerminal;
  const receive = pasteReceiver(() => ({ rows: h.rows(), parsed: true, pending: true }), text => { void paste('relay', text, 'session'); })('relay', 'session');
  h.bridge.pasteTerminal = async (id, text, sessionId) => { receive({ id, text, sessionId }); return { ok: true }; };
  assert.equal(await h.finish(h.sendToAgent('relay', 'session', 'claude', 'relay during output')), null);
  assert.deepEqual(h.received, ['relay during output']); assert.equal(h.pastes.length, 1);
});

// The real screen registry, parser, popup mounting and fitting. A PTY redraw is represented by a null frame followed
// by the same prompt at its new width; the popup harness never assigns instances itself.
function resizingPrompt(t, wrappedOption = false) {
  const h = popupHarness(t, 'claude');
  const saved = { style: global.getComputedStyle, observer: global.ResizeObserver };
  window.setTimeout = setTimeout; window.clearTimeout = clearTimeout;
  global.getComputedStyle = node => ({ getPropertyValue: name => String(name === 'width' ? node.clientWidth : name === 'height' ? node.clientHeight : 0) });
  global.ResizeObserver = class { observe() {} disconnect() {} };
  const container = width => ({ clientWidth: width, clientHeight: 400,
    appendChild(node) { this.insertBefore(node); }, insertBefore(node) { node.parentElement = this; } });
  const card = container(wrappedOption ? 800 : 400), popup = container(wrappedOption ? 1200 : 800), element = { parentElement: card, nextSibling: null, contains: () => false };
  let lines = ['────', '❯ ', '────'], parsed = () => {}, resized = () => {};
  const option = "  2. Yes, and don't ask again for npm test commands in", folder = 'D:\\work\\workspace\\long-project-folder';
  const atWidth = title => wrappedOption
    ? ['─'.repeat(terminal.cols), title, '$ npm test', '', '❯ 1. Yes',
      ...(terminal.cols < 100 ? [option, '     ' + folder] : [option + ' ' + folder]), '  3. No', 'Esc to cancel']
    : [title, ...(terminal.cols < 60 ? ['$ echo a long command', '  whose context wraps'] : ['$ echo a long command whose context wraps']), ...prompt.slice(1)];
  const terminal = { cols: wrappedOption ? 80 : 40, rows: 20, element, options: { scrollback: 0 },
    _core: { _renderService: { dimensions: { css: { cell: { width: 10, height: 20 } } }, clear() {} } },
    buffer: { active: { baseY: 0, getLine: index => ({ translateToString: () => lines[index] ?? '' }) } },
    onWriteParsed(fn) { parsed = fn; return { dispose() {} }; }, onResize(fn) { resized = fn; return { dispose() {} }; },
    resize(cols, rows) { this.cols = cols; this.rows = rows; lines = ['redrawing']; resized(); }, refresh() {}, focus() {}, blur() {},
  };
  const unregister = screens.registerScreen(h.props.terminal.id, terminal, h.props.terminal.sessionId);
  const off = screens.subscribeParsed(h.props.terminal.id, frame => { h.view.rows = frame.rows; h.view.frame = frame; });
  const unregisterPopup = registerReadingTerminal(h.props.terminal.id, h.props.terminal.sessionId, terminal);
  const draw = next => { lines = next; parsed(); h.render(); };
  t.after(() => { off(); unregisterPopup(); unregister(); global.getComputedStyle = saved.style; global.ResizeObserver = saved.observer; });
  return { ...h, draw, prompt: (title = prompt[0]) => draw(atWidth(title)),
    mount: () => mountReadingTerminal(h.props.terminal.id, h.props.terminal.sessionId, popup, false) };
}

test('an explicit close survives real popup fit and restore resizes with a short null redraw', t => {
  const h = resizingPrompt(t); h.prompt(); assert.ok(h.popup());
  const restore = h.mount(); h.render(); h.prompt();
  h.popup().props.onClose(); h.render(); restore(); h.render();
  assert.equal(h.popup(), undefined); h.tick(100); h.prompt(); assert.equal(h.popup(), undefined);
  h.props.autoFocus = true; h.render(); h.props.autoFocus = false; h.render(); h.prompt();
  assert.equal(h.popup(), undefined, 'collapse and another redraw preserve explicit dismissal');
});

test('a wrapped Claude Bash option moving between label and detail keeps dismissal across fit and restore', t => {
  const h = resizingPrompt(t, true); h.prompt(); assert.ok(h.popup());
  const narrow = parseAgentScreen('claude', h.view.rows).choice.options[1];
  assert.match(narrow.detail, /long-project-folder/); assert.doesNotMatch(narrow.label, /long-project-folder/);
  const restore = h.mount(); h.render(); h.prompt();
  const wide = parseAgentScreen('claude', h.view.rows).choice.options[1];
  assert.match(wide.label, /long-project-folder/); assert.equal(wide.detail, '');
  h.popup().props.onClose(); h.render(); restore(); h.render(); h.prompt();
  assert.equal(h.popup(), undefined, 'returning the path to detail cannot create another episode');
});

test('an open popup adopts real rewraps and a new prompt without remounting', t => {
  const h = resizingPrompt(t); h.prompt(); const key = h.popup().key, instance = h.view.frame.instances.claude;
  const restore = h.mount(); h.render(); h.prompt();
  assert.notEqual(h.view.frame.instances.claude, instance, 'exact approval instance really changed');
  assert.equal(h.popup().key, key, 'the same popup survives fitting and redraw');
  h.prompt('Run the next command?'); assert.equal(h.popup().key, key, 'a new episode is adopted in place');
  h.popup().props.onClose(); h.render(); h.prompt('Run the next command?');
  assert.equal(h.popup(), undefined, 'explicit close dismisses the adopted episode too');
  restore();
});

test('a long null gap or returned input ends the dismissed prompt episode', t => {
  const h = resizingPrompt(t); h.prompt(); h.popup().props.onClose(); h.render();
  h.draw(['redrawing']); h.tick(DIALOG_SETTLE); h.prompt(); assert.ok(h.popup());
  h.popup().props.onClose(); h.render(); h.draw(['────', '❯ ', '────']); h.prompt(); assert.ok(h.popup());
});

test('collapse reopens an implicit popup on the next parsed frame in the selected visible card', t => {
  const h = resizingPrompt(t); h.props.autoFocus = true; h.prompt();
  h.props.autoFocus = false; h.render(); assert.equal(h.popup(), undefined);
  h.prompt(); assert.ok(h.popup());
});
