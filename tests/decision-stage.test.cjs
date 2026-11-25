const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readCss, assertRule } = require('./helpers/css-rules.cjs');
const fs = require('node:fs');
const path = require('node:path');
const en = require('../electron/locales/en.json');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('the decision page with nothing to decide is one stage: the guide, a 760px white box and a hint, the picked project always driving it', () => {
  const home = read('src/features/home/DecisionHome.tsx');
  assert.match(home, /items\.find\(item => item\.decision\) \?\? items\[0\]/, 'with no decision the first project is picked');
  assert.match(home, /<NewWork stage projects=\{projects\} selectedProjectId=\{selected\.project\.id\}/);
  assert.match(home, /takeFocus=\{picked === null\}/, 'the box takes the focus on arrival only: a picked row keeps it for the arrow keys');
  assert.match(home, /onChange=\{pickProject\}/, 'the box\'s picker picks the same row the list does');
  assert.match(home, /event\.key === 'Enter' && !event\.shiftKey && !event\.nativeEvent\.isComposing/, 'Enter starts, Shift+Enter breaks the line, an IME composition is left alone');
  assert.match(home, /new-work-hint[^\n]*输入需求后按 Enter 开始/);
  const css = readCss('src/features/home/home.css');
  assertRule(css, '.new-work.is-stage', { width: 'min(760px, 100%)' });
  assertRule(css, '.new-work-title', { 'font-size': '24px', 'font-weight': '600' });
  assertRule(css, '.new-work-sub', {
    margin: '8px 0 24px', 'font-size': '14px', 'font-weight': '400', color: 'var(--text-2)',
  }, '8px under the title, 24px above the box, the helper colour');
  assertRule(css, '.new-work.is-stage .new-work-input', {
    'min-height': '128px', 'border-radius': '16px', padding: '16px', 'border-color': 'var(--compose-border)', 'box-shadow': 'var(--compose-shadow)',
  });
  assertRule(css, '.home-right.is-stage', { 'padding-bottom': '92px' }, 'the title and the box sit 70px above where the old empty state sat');
  assertRule(css, '.new-work.is-stage .new-work-input:has(textarea:focus-visible)', { 'border-color': 'var(--compose-accent)' });
});

test('the send button is a quiet grey square until there is text, then the brand blue with a white icon', () => {
  const css = readCss('src/features/home/home.css'), themes = readCss('src/shared/styles/themes.css');
  assertRule(css, '.home-layer .new-work-start:not(.primary)', { background: 'var(--bg-hover)' });
  assertRule(css, '.home-layer .new-work-start.primary', { color: '#fff', background: 'var(--compose-accent)' });
  assertRule(themes, '.home-layer', { '--compose-border': 'var(--border)', '--compose-shadow': 'none', '--compose-accent': '#5686c4' });
  assertRule(themes, ':root[data-theme="light"] .home-layer', { '--compose-border': '#cbd5e1', '--compose-shadow': '0 4px 18px rgb(20 30 50 / .04)' });
  // white on #5686c4 is 3.75:1, the 3:1 an icon needs; the pressed shade is darker still
  const luminance = hex => { const [r, g, b] = [1, 3, 5].map(at => parseInt(hex.slice(at, at + 2), 16) / 255).map(v => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const ratio = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  for (const blue of ['#5686c4', '#4a77b4', '#3f6aa3']) assert.ok(ratio('#ffffff', blue) >= 3, `${blue} carries a white icon`);
  assert.ok(ratio('#5686c4', '#ffffff') >= 3, 'the focused border reads against the white box');
});

test('the project list recedes: idle sessions are plain names, only the picked one has its fill, its state line and a bold name', () => {
  const inbox = read('src/features/home/DecisionInbox.tsx'), css = readCss('src/features/home/home.css');
  assert.match(inbox, /group === 'working' \? sessionLine\(item\) : item\.id === selectedId \? tag : ''/);
  assert.match(inbox, /\(decision \|\| group === 'working'\) && <span className=\{`inbox-tag/, 'an idle session has no tag in the list');
  assertRule(css, '.inbox-text b', { 'font-weight': '400', color: 'var(--text-2)' });
  assertRule(css, '.inbox-row:is([aria-selected="true"], .has-decision) .inbox-text b', { color: 'var(--text-1)', 'font-weight': '600' });
  assertRule(css, '.inbox-row.is-compact', { height: '36px' });
  assert.deepEqual(css.blocks.filter(({ selector }) => selector.includes('.inbox-row[aria-selected="true"]::before')), [], 'the new reference has no selection bar');
  assertRule(css, '.home-head h1', { 'font-size': '14px', 'font-weight': '600' });
});

test('the new texts have English translations', () => {
  for (const text of ['描述一个想法，让 Agentrix 帮你实现。', '描述你想构建的功能、修复的问题，或粘贴截图…', '输入需求后按 Enter 开始', '开始 (Enter)', '添加图片']) assert.ok(text in en, text);
});
