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

test('a dismissed dialog leaves one reopen action and never copies options or writes keys', () => {
  const WaitingCard = loadWaitingCard(), opened = [], root = WaitingCard({ title: 'Exit plan mode?', terminalId: 'fixture', onOpenTerminal: () => opened.push('fixture') });
  const html = renderToStaticMarkup(root); assert.ok(html.includes('Exit plan mode?')); assert.equal(root.props.role, 'status');
  const buttons = elements(root).filter(node => node.type === 'button'); assert.equal(buttons.length, 1); buttons[0].props.onClick();
  assert.deepEqual(opened, ['fixture']); assert.equal(elements(root).some(node => ['input', 'select', 'option', 'li'].includes(node.type)), false);
});
