// The reading view hides the 【交付】 block that closes a reply; the homework card still reads the whole reply.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const ts = require('typescript');
const { parseDelivery, withoutDelivery } = require('../src/features/home/delivery.ts');

const stubs = {
  './Markdown': { Markdown: ({ text }) => React.createElement('p', { className: 'md' }, text) },
  './FileCards': { FileCards: () => null, previewable: () => false },
  './action-text': { stepVerb: step => step.kind },
  './PathText': { PathText: ({ text }) => text }, './useReadingPaths': { useReadingPaths: () => ({ ref: { current: null } }) },
  './reading-paths': { pathTooltip: () => '', markReadingPaths() {} },
  './file-popup': { showPopup() {} }, './i18n': { currentLanguage: () => 'en', t: text => text },
  './UserAvatar': { UserAvatar: () => null }, './PendingPromptEntries': { UserMessage: () => null },
  './MessageMenu': { MessageCard: props => React.createElement('div', { 'data-text': props.text, 'data-has-menu': String(Boolean(props.quote)) }, props.children) },
  './Timeline': { AgentMark: () => null, AgentTurnItem: ({ children }) => React.createElement('section', null, children), stepTime: () => '', TimelineStep: ({ children }) => React.createElement('section', null, children) },
  './ResultCard': { groupSummary: () => '', ImageProgress: () => null, StepState: () => null },
  './useVisibleTail': require('../src/features/reading/useVisibleTail.ts'),
};
function loadFeed() {
  const file = path.join(__dirname, '../src/features/reading/ConversationFeed.tsx'), mod = new Module(file, module);
  mod.filename = file; mod.paths = Module._nodeModulePaths(path.dirname(file)); const original = mod.require.bind(mod);
  mod.require = name => {
    const key = name.startsWith('.') ? './' + path.basename(name) : name;
    if (Object.hasOwn(stubs, key)) return stubs[key];
    if (name.endsWith('.css')) return {};
    if (name === '@phosphor-icons/react') return new Proxy({}, { get: () => () => null });
    if (key === './result-round') return require('../src/features/reading/result-round.ts');
    if (key === './reply-files') return require('../src/features/reading/reply-files.ts');
    return original(name);
  };
  mod._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText, file);
  return mod.exports.ConversationFeed;
}
const draw = text => renderToStaticMarkup(React.createElement(loadFeed(), { entries: [{ id: 'r1', at: 1, role: 'assistant', text }], agent: 'claude', projectId: 'p', live: false, onError: assert.fail }));

const FIX = '【交付】\n问题：预处理太慢\n原因：线程池被占满\n结果：从 41 秒降到 12 秒';
const OPTIMIZE = '## 交付\n- **优化**：批量解码\n- **解决**: 预处理阻塞\n- **对比**：0.51 秒到 0.12 秒';

test('the reading view hides a complete trailing 交付 block, and the homework card still reads it', () => {
  const reply = `改好了，测试全部通过。\n\n${FIX}`;
  const html = draw(reply);
  assert.match(html, /改好了，测试全部通过。/);
  assert.doesNotMatch(html, /交付|预处理太慢|线程池被占满/, 'the block is not drawn');
  assert.equal(parseDelivery(reply).kind, 'fix', 'the full reply still gives the homework card its summary');
  assert.match(html, new RegExp(`data-text="改好了，测试全部通过。"`), 'copy and quote take the shown text');
  assert.equal(withoutDelivery(reply), '改好了，测试全部通过。');
});

test('a partial or mid-reply 交付 block stays visible', () => {
  const partial = '做完了。\n\n【交付】\n问题：只写了问题\n结果：没有原因';
  const middle = `${FIX}\n\n以上是总结，后面还有一段补充说明。`;
  const midHeading = '先看这一行 【交付】 不在行首\n问题：x\n原因：y\n结果：z';
  for (const reply of [partial, middle, '【交付】\n还没写完', 'No block here.']) {
    assert.equal(withoutDelivery(reply), reply);
  }
  assert.match(draw(partial), /只写了问题/); assert.match(draw(middle), /后面还有一段补充说明/); assert.match(draw(middle), /线程池被占满/);
  assert.equal(withoutDelivery(midHeading), midHeading);
});

test('fix and optimize blocks, Markdown labels and English labels are hidden when they close the reply', () => {
  assert.equal(withoutDelivery(`Done.\n\n${OPTIMIZE}`), 'Done.');
  assert.equal(withoutDelivery('Done.\n\n**交付**\n- **问题**: a\n- **原因**: b\n- **结果**: c'), 'Done.');
  assert.equal(withoutDelivery('Done.\n\nDelivery:\nProblem: login fails\nCause: token expired\nResult: fixed'), 'Done.');
  assert.equal(withoutDelivery('Done.\r\n\r\n【交付】\r\n优化：x\r\n解决：y\r\n对比：z\r\n'), 'Done.');
  assert.equal(withoutDelivery('Done.\n\n### 交付\n**原因**：b\n**问题**：a\n**结果**：c'), 'Done.', 'label order does not matter');
  const twice = '【交付】\n问题：旧\n原因：旧\n结果：旧\n\n又改了一次。\n\n【交付】\n问题：新\n原因：新\n结果：新';
  assert.equal(withoutDelivery(twice), '【交付】\n问题：旧\n原因：旧\n结果：旧\n\n又改了一次。', 'only the last, closing block goes');
  assert.doesNotMatch(draw(`Done.\n\n${OPTIMIZE}`), /批量解码|优化/);
});
