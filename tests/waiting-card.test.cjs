const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const en = require('../electron/locales/en.json');

const root = path.join(__dirname, '..', 'src', 'features', 'reading');
const translate = text => en[text] ?? text;
function loadWaitingCard() {
  const filename = path.join(root, 'WaitingCard.tsx');
  const mod = new Module(filename, module);
  mod.filename = filename; mod.paths = Module._nodeModulePaths(root);
  const original = mod.require.bind(mod);
  mod.require = name => name.endsWith('.css') ? {} : name.endsWith('i18n') ? { t: translate } : original(name);
  mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText, filename);
  return mod.exports.WaitingCard;
}

const elements = node => Array.isArray(node) ? node.flatMap(elements) : React.isValidElement(node) ? [node, ...elements(node.props.children)] : [];

test('the waiting card names the situation, shows the dialog heading when it is known and offers one button', () => {
  const WaitingCard = loadWaitingCard();
  const html = renderToStaticMarkup(React.createElement(WaitingCard, { title: 'Exit plan mode?', terminalId: 'terminal', onOpenTerminal() {} }));
  assert.match(html, /class="reading-choice reading-waiting"/);
  assert.match(html, /<strong>[^<]+<\/strong>/);
  assert.match(html, /<p class="reading-waiting-heading">Exit plan mode\?<\/p>/);
  assert.equal(html.match(/<button/g).length, 1);
  assert.doesNotMatch(renderToStaticMarkup(React.createElement(WaitingCard, { title: null, terminalId: 'terminal', onOpenTerminal() {} })), /reading-waiting-heading/);
});

test('the waiting card button only opens the terminal: it presses no key and focus only tells the window which terminal is in use', () => {
  const WaitingCard = loadWaitingCard(), calls = [], previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { agentrix: new Proxy({}, { get: (_, name) => (...args) => calls.push([name, ...args]) }) } });
  try {
    const opened = [], tree = WaitingCard({ title: 'Review your answers', terminalId: 'terminal', onOpenTerminal: () => opened.push('open') });
    const [button] = elements(tree).filter(node => node.type === 'button');
    button.props.onClick();
    assert.deepEqual(opened, ['open']);
    tree.props.onFocus();
    assert.deepEqual(calls, [['terminalFocus', 'terminal', false]]);
    assert.equal(tree.props.role, 'group'); assert.equal(tree.props.tabIndex, -1);
    assert.equal(tree.props['aria-label'], tree.props.children[0].props.children.props.children, 'the group is named by the same sentence');
  } finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous); else delete globalThis.window;
  }
});

test('the waiting card reuses the choice card frame and the 32px result button, in every theme', () => {
  const css = fs.readFileSync(path.join(root, 'choice-waiting.css'), 'utf8'), result = fs.readFileSync(path.join(root, 'result-card.css'), 'utf8');
  assert.match(result, /\.result-button \{[^}]*height: 32px/);
  assert.match(css, /\.reading-waiting-heading \{[^}]*color: var\(--text-2\)/);
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|rgba?\(/i, 'colours come from the theme tokens');
});
