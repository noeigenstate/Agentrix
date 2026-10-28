const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

// Render the real task components without loading route/account controls or a native window.
const source = fs.readFileSync(path.join(__dirname, '../src/features/agents/ActivityPane.tsx'), 'utf8');
const exportsObject = {};
const context = vm.createContext({ require, exports: exportsObject, module: { exports: exportsObject },
  t: text => text, useNow: () => Date.now(), Circle: () => null, CircleNotch: () => null });
vm.runInContext(ts.transpileModule(source.slice(source.indexOf('export function elapsedClock(')) + '\nmodule.exports = PromptList;', {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText, context);
const markup = terminal => renderToStaticMarkup(React.createElement(context.module.exports, { terminal }));

test('empty tasks never show the completed user prompt during completion, background rounds or interrupted/unknown activity', () => {
  for (const codexActivity of ['complete', 'working', 'interrupted', 'unknown']) {
    const html = markup({ codexActive: true, codexActivity, prompts: [], task: 'A finished user request.', taskTitle: 'Original finished prompt.', lastCompletedAt: Date.now() });
    assert.match(html, />没有待处理的提示<\/p>/);
    assert.doesNotMatch(html, /finished|已完成|is-done|<time>|title=/);
  }
  assert.match(markup({ codexActive: false, prompts: [], task: 'Old request.' }), />还没有开始任务<\/p>/);
});

test('current and queued user tasks retain their summaries, original text, states and clocks', () => {
  const now = Date.now();
  const html = markup({ codexActive: true, codexActivity: 'working', task: 'An earlier completed task.', prompts: [
    { id: 'current', text: 'Current request with details.', summary: 'Current request.', state: 'working', at: now - 60000 },
    { id: 'queued', text: 'A real queued request.', summary: 'Queued request.', state: 'queued', at: now - 10000 },
  ] });
  assert.match(html, /class="is-working" title="Current request with details\.\n正在处理 · 1:0\d"/);
  assert.match(html, /title="A real queued request\.\n排队中 · 0:1\d"/);
  assert.equal((html.match(/<time>/g) || []).length, 2);
  assert.doesNotMatch(html, /earlier completed|没有待处理/);
});
