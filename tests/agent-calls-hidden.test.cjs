const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const React = require('react');

// The called models' list leaves out the calls main has hidden (ended, no process keeps them) unless their view is open beside the conversation. Source files are
// transpiled the way the other UI tests do it; the open views are read straight from their store instead of a render.
const src = path.join(__dirname, '..', 'src');
const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
before(() => { Object.defineProperty(globalThis, 'document', { configurable: true, value: { documentElement: { dataset: {}, lang: '' } } }); });
after(() => { if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument); else delete globalThis.document; });

const cache = new Map();
const resolve = (from, name) => [name, `${name}.ts`, `${name}.tsx`].map(candidate => path.resolve(path.dirname(from), candidate)).find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
function load(filename) {
  if (cache.has(filename)) return cache.get(filename).exports;
  const mod = new Module(filename, module);
  mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename));
  cache.set(filename, mod);
  const original = mod.require.bind(mod);
  mod.require = name => {
    if (name === 'react') return { ...React, useSyncExternalStore: (subscribe, snapshot) => snapshot() };
    if (name.endsWith('.css')) return {};
    if (name === '@phosphor-icons/react') return new Proxy({}, { get: (_, icon) => () => React.createElement('svg', { 'data-icon': icon }) });
    return name.startsWith('.') ? load(resolve(filename, name)) : original(name);
  };
  mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename);
  return mod.exports;
}
const files = relative => load(path.join(src, relative));
const elements = node => Array.isArray(node) ? node.flatMap(elements) : React.isValidElement(node) ? [node, ...elements(node.props.children)] : [];

const call = (model, items) => ({ agent: 'Codex', provider: 'OpenAI', model, effort: 'max', fast: true, preparing: 0, running: 0, reviewing: 0, tasks: [], rate: null, items });
const item = (id, patch = {}) => ({ id, state: 'done', role: '执行', title: `Task ${id}`, startedAt: 1, endedAt: 2, viewable: true, ...patch });

// What the card lists: the model heads, the calls under them, the "+N" and the empty line.
function card(calls, terminalId) {
  files('shared/i18n.ts').applyLanguage('zh');
  const { CallsCard, ModelHead } = files('features/agents/AgentCalls.tsx'), all = elements(CallsCard({ calls, terminalId }));
  return {
    heads: all.filter(node => node.type === ModelHead).map(node => node.props.name),
    rows: all.filter(node => typeof node.props.className === 'string' && node.props.className.startsWith('activity-call-item')).map(node => node.key),
    more: all.filter(node => node.props.className === 'activity-call-more').map(node => elements(node).find(child => child.type === 'p').props.children),
    empty: all.some(node => node.props.className === 'activity-empty'),
  };
}

test('a hidden call is not listed unless its view is open; a model with no call left has no head; the "+N" counts what is listed; no call at all shows the empty line', () => {
  const store = files('features/agents/subagent-splits.ts'), terminalId = 't-hidden';
  const many = Array.from({ length: 6 }, (_, index) => item(`dispatch:m${index}`, index < 2 ? { hidden: true } : {}));
  const calls = [call('gpt-6.1-sol', [item('a'), item('b', { hidden: true }), item('c', { hidden: false })]), call('claude-opus-5-5', [item('d', { hidden: true })]), call('claude-sonnet-5-5', many)];
  const shown = card(calls, terminalId);
  assert.deepEqual(shown.rows, ['a', 'c', 'dispatch:m2', 'dispatch:m3', 'dispatch:m4', 'dispatch:m5'], 'the hidden ones are left out; a call from an older main (no field) is listed');
  assert.equal(shown.heads.length, 2, 'the model whose calls are all hidden is not drawn, its head included');
  assert.deepEqual(shown.more, [], 'four listed calls are no "+N": the hidden ones are not counted');
  const five = card([call('claude-sonnet-5-5', [...many, item('dispatch:extra')])], terminalId);
  assert.deepEqual([five.rows.length, five.more], [4, ['+1 个']], 'the count is of the listed calls: 5 listed, 4 shown, 1 more');
  store.openSplit(terminalId, 'b');
  assert.deepEqual(card(calls, terminalId).rows.slice(0, 3), ['a', 'b', 'c'], 'a hidden call whose view is open stays');
  store.openSplit(terminalId, 'd');
  assert.equal(card(calls, terminalId).heads.length, 3, 'and so does its model’s head');
  store.closeSplit(terminalId, 'd');
  assert.deepEqual([card(calls, terminalId).rows.includes('d'), card(calls, terminalId).heads.length], [false, 2], 'once the view closes it is gone at once');
  store.closeSplit(terminalId, 'b');
  assert.equal(card(calls, 't-other').rows.includes('b'), false, 'another terminal’s open view does not keep it');
  const none = card([call('gpt-6.1-sol', [item('x', { hidden: true })])], terminalId);
  assert.deepEqual([none.empty, none.heads, none.rows], [true, [], []], 'every call hidden: the existing empty line');
  assert.equal(card([], terminalId).empty, true);
  assert.deepEqual(card([call('gpt-6.1-sol', [])], terminalId).heads.length, 1, 'a model that never had a call keeps its head, as before');
});
