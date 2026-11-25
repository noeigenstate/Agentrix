const { test } = require('node:test');
const assert = require('node:assert/strict');
const { findMatches, matchFrom, stepMatch } = require('../src/features/files/editor-find.ts');

test('a search finds every place the words occur, ignoring case unless asked, never overlapping', () => {
  const text = 'Alpha alpha ALPHA aa\naaaa';
  assert.deepEqual(findMatches(text, 'alpha', false).map(match => match.start), [0, 6, 12]);
  assert.deepEqual(findMatches(text, 'alpha', true).map(match => match.start), [6]);
  assert.deepEqual(findMatches(text, 'aa', true).map(match => [match.start, match.end]), [[18, 20], [21, 23], [23, 25]], 'next one after the end of the last');
  assert.deepEqual(findMatches(text, '', false), []);
  assert.deepEqual(findMatches('中文 搜索 中文', '中文', false).map(match => match.start), [0, 6]);
  assert.deepEqual(findMatches('İstanbul istanbul', 'istanbul', false).map(match => match.start), [9], 'a text whose lower case is longer keeps its case');
});

test('the match shown first is the one at or after the caret, going round at either end', () => {
  const matches = [{ start: 2, end: 4 }, { start: 10, end: 12 }, { start: 20, end: 22 }];
  assert.equal(matchFrom(matches, 0), 0);
  assert.equal(matchFrom(matches, 10), 1);
  assert.equal(matchFrom(matches, 21), 0, 'after the last: the first');
  assert.equal(matchFrom([], 5), -1);
  assert.deepEqual([stepMatch(0, 3, 1), stepMatch(2, 3, 1), stepMatch(0, 3, -1), stepMatch(0, 0, 1)], [1, 0, 2, -1]);
});

test('Enter confirms an IME composition in the find field without moving the match', t => {
  const { hookHarness } = require('./helpers/hook-harness.cjs');
  const { elements, stubGlobals } = require('./helpers/renderer-fixtures.cjs');
  const noop = () => {}, listeners = new Map(), text = '中文和中文';
  const node = { value: text, selectionStart: 0, selectionEnd: 0, scrollTop: 0, scrollLeft: 0, clientHeight: 100, clientWidth: 800,
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; },
    addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) };
  let h;
  stubGlobals(t, { requestAnimationFrame: noop, getComputedStyle: () => ({ lineHeight: '24px' }),
    ResizeObserver: class { observe() {} disconnect() {} },
    document: { addEventListener: noop, removeEventListener: noop,
      createElement: () => ({ style: {}, setAttribute: noop, getBoundingClientRect: () => ({ width: 120 }) }) } }, () => h?.dispose());
  h = hookHarness('src/features/files/CodeEditor.tsx', {
    '@phosphor-icons/react': { ArrowUp: noop, ArrowDown: noop, X: noop }, './i18n': { t: value => value },
    './editor-find': require('../src/features/files/editor-find.ts'),
    './editor-git': { findConflicts: () => [], lineMarks: () => new Map() },
  });
  const editor = { current: node }, render = () => elements(h.render('CodeEditor', { editor, text, diff: null, onResolve: noop }).result);
  render();
  listeners.get('keydown')({ key: 'f', ctrlKey: true, preventDefault: noop });
  const input = () => render().find(node => node.props?.['aria-label'] === '查找' && node.type === 'input').props;
  input().onChange({ target: { value: '中文' } });
  const enter = (isComposing, preventDefault) => input().onKeyDown({ key: 'Enter', nativeEvent: { isComposing }, preventDefault });
  enter(true, assert.fail); render(); assert.equal(node.selectionStart, 0);
  enter(false, noop); render(); assert.equal(node.selectionStart, 3);
});
