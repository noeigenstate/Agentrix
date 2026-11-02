const { test } = require('node:test');
const assert = require('node:assert/strict');
const { hookHarness } = require('./helpers/hook-harness.cjs');

test('mounting a live terminal without focus never calls focus, even transiently', t => {
  const previous = { document: global.document, observer: global.ResizeObserver };
  global.document = { activeElement: {} }; global.ResizeObserver = class { observe() {} disconnect() {} };
  t.after(() => { global.document = previous.document; global.ResizeObserver = previous.observer; });
  let focused = 0, blurred = 0, fit = 0;
  const parent = { insertBefore(element) { element.parentElement = this; } }, host = { appendChild(element) { element.parentElement = this; } };
  const element = { parentElement: parent, nextSibling: null, contains: () => false };
  const terminal = { element, rows: 24, refresh() {}, focus() { focused++; }, blur() { blurred++; } };
  const h = hookHarness('src/features/terminal/terminal-popup.ts', { './terminal-fit.ts': { fitTerminal() { fit++; } } });
  const unregister = h.render('registerReadingTerminal', 'fixture', 'runtime', terminal).result;
  const restore = h.render('mountReadingTerminal', 'fixture', 'runtime', host, false).result;
  assert.equal(element.parentElement, host); assert.equal(focused, 0); assert.equal(fit, 1);
  restore(); assert.equal(element.parentElement, parent); assert.equal(focused, 0); assert.equal(blurred, 0);
  const explicit = h.render('mountReadingTerminal', 'fixture', 'runtime', host).result;
  assert.equal(focused, 1); explicit(); unregister();
});

test('ReadingTerminalPopup forwards the no-focus choice to the actual mounting boundary', t => {
  const previous = global.document, calls = [];
  global.document = { addEventListener() {}, removeEventListener() {} }; t.after(() => { global.document = previous; });
  const h = hookHarness('src/features/reading/ReadingTerminalPopup.tsx', {
    '@phosphor-icons/react': { TerminalWindow() {}, X() {} }, './i18n': { t: text => text }, './reading-terminal-popup.css': {},
    './terminal-popup': { mountReadingTerminal(...args) { calls.push(args); return () => {}; } },
  });
  h.render('ReadingTerminalPopup', { terminalId: 'fixture', sessionId: 'runtime', command: '', focus: false, onReady() {}, onClose() {}, onError: assert.fail });
  assert.equal(calls.length, 1); assert.equal(calls[0][3], false); h.dispose();
});
