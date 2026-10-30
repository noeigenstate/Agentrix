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

// The choice cards' styles, read as text: sizes on the scale, 32px hit areas, readable text in both themes.
const strip = css => css.replace(/\/\*[\s\S]*?\*\//g, '');
const rules = css => [...strip(css).matchAll(/([^{}]+)\{([^}]*)\}/g)].map(match => ({ selector: match[1].trim(), body: match[2] }));
const sharedRules = rules(fs.readFileSync(path.join(__dirname, '..', 'src', 'shared', 'styles', 'styles.css'), 'utf8'));
const cardRules = rules(fs.readFileSync(path.join(root, 'reading.css'), 'utf8')).filter(rule => /\.reading-(choice|question|waiting)/.test(rule.selector));
const declarations = body => body.split(';').map(item => [item.slice(0, item.indexOf(':')).trim(), item.slice(item.indexOf(':') + 1).trim()]).filter(([name]) => name);
const declared = (list, selector, property) => list.filter(rule => rule.selector === selector).flatMap(rule => declarations(rule.body))
  .filter(([name]) => name === property).at(-1)?.[1];

test('the choice and question cards keep their spacing on the 2/4/8/12/16/20/24/32 scale', () => {
  const scale = new Set([0, 2, 4, 8, 12, 16, 20, 24, 32]), off = [];
  for (const rule of cardRules) for (const [name, value] of declarations(rule.body)) {
    if (!/^(gap|margin(-[a-z]+)?|padding(-[a-z]+)?)$/.test(name)) continue;
    for (const [, size] of value.matchAll(/(\d+(?:\.\d+)?)px/g)) if (!scale.has(Number(size))) off.push(`${rule.selector} { ${name}: ${value} }`);
  }
  assert.deepEqual(off, []);
});

test('the text actions of the choice and question cards have a 32px hit area, and the waiting card has one type size', () => {
  const action = cardRules.find(rule => rule.selector.includes('.reading-choice-head') && rule.selector.endsWith('.text-button') && /min-height: 32px/.test(rule.body) && /min-width: 32px/.test(rule.body));
  assert.ok(action, 'open terminal, cancel and chat about it share one rule');
  assert.match(action.selector, /\.reading-question-head/); assert.match(action.selector, /\.reading-question-actions/);
  assert.match(cardRules.find(rule => rule.selector === '.reading-question-head').body, /min-height: 32px/);
  const waiting = rules(fs.readFileSync(path.join(root, 'choice-waiting.css'), 'utf8')).find(rule => rule.selector === '.reading-waiting .result-button');
  assert.match(waiting.body, /font-size: inherit/, 'the 32px button speaks in the card\'s size, not its own 14px');
});

test('a disabled choice or question option resolves to full opacity over the shared button rule', () => {
  // Both ReadingChoice and ReadingQuestion use .reading-choice-option on their disabled buttons. That selector has
  // higher specificity than button:disabled; without its own value, the shared button rule still applies.
  const shared = declared(sharedRules, 'button:disabled', 'opacity');
  const option = declared(cardRules, '.reading-choice-option:disabled', 'opacity');
  const important = value => /\s*!important\s*$/i.test(value ?? '');
  const resolved = important(shared) && !important(option) ? shared : option ?? shared ?? '1';
  assert.equal(Number(resolved.replace(/\s*!important\s*$/i, '')), 1, `resolved opacity: option=${option}, shared=${shared}`);
});

test('the permission hint margin and chat action gap resolve to the spacing scale', () => {
  const scale = new Set([0, 2, 4, 8, 12, 16, 20, 24, 32]);
  const hint = cardRules.find(rule => rule.selector === '.reading-choice-hint');
  const margin = declarations(hint.body).filter(([name]) => name === 'margin' || name === 'margin-bottom').at(-1);
  const parts = margin?.[1].trim().split(/\s+/);
  const bottom = margin?.[0] === 'margin-bottom' ? parts?.[0] : parts?.[2] ?? parts?.[0];
  assert.ok(bottom !== undefined && scale.has(parseFloat(bottom)), `hint bottom margin must replace the user-agent margin: ${bottom}`);
  const action = cardRules.find(rule => rule.selector.includes('.reading-question-actions') && rule.selector.endsWith('.text-button'));
  const actionGap = declarations(action.body).filter(([name]) => name === 'gap').at(-1)?.[1];
  const sharedGap = declared(sharedRules, '.text-button', 'gap');
  assert.ok(scale.has(parseFloat(actionGap ?? sharedGap)), `resolved chat action gap: ${actionGap ?? sharedGap}`);
});

// WCAG contrast of the colours the cards put text in (a permission card's numbers, details, hints and actions).
function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map(at => parseInt(hex.slice(at, at + 2), 16) / 255).map(value => value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a, b) => { const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (high + 0.05) / (low + 0.05); };

test('every text colour of the choice cards reads at 4.5:1 on its background in the dark and light themes', () => {
  const themes = fs.readFileSync(path.join(__dirname, '..', 'src', 'shared', 'styles', 'themes.css'), 'utf8');
  const dark = /^:root \{([\s\S]*?)^\}/m.exec(themes)[1], light = /^:root\[data-theme="light"\] \{([\s\S]*?)^\}/m.exec(themes)[1];
  // The highlighted option's number (accent) and detail (text-1 there), the context and hint rows, and the actions.
  const pairs = [['--warning', '--bg-selected'], ['--text-1', '--bg-selected'], ['--text-2', '--bg-card'], ['--text-2', '--bg-app'], ['--text-3', '--bg-card'], ['--text-1', '--bg-card']];
  for (const [name, block] of [['dark', dark], ['light', light]]) {
    const token = key => new RegExp(`${key}:\\s*(#[0-9a-fA-F]{6})`).exec(block)?.[1];
    for (const [text, background] of pairs) {
      assert.ok(token(text) && token(background), `${name}: ${text} on ${background}`);
      assert.ok(contrast(token(text), token(background)) >= 4.5, `${name}: ${text} on ${background} is ${contrast(token(text), token(background)).toFixed(2)}:1`);
    }
  }
});
