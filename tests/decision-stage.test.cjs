const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const en = require('../electron/locales/en.json');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const rule = (css, selector) => css.split(/\r?\n/).find(line => line.startsWith(`${selector} {`)) ?? assert.fail(`${selector} has a rule`);

test('the decision page with nothing to decide is one stage: the guide, a 760px white box and a hint, the picked project always driving it', () => {
  const home = read('src/features/home/DecisionHome.tsx');
  assert.match(home, /items\.find\(item => item\.decision\) \?\? items\[0\]/, 'with no decision the first project is picked');
  assert.match(home, /<NewWork stage projects=\{projects\} selectedProjectId=\{selected\.project\.id\}/);
  assert.match(home, /takeFocus=\{picked === null\}/, 'the box takes the focus on arrival only: a picked row keeps it for the arrow keys');
  assert.match(home, /onChange=\{pickProject\}/, 'the box\'s picker picks the same row the list does');
  assert.match(home, /event\.key === 'Enter' && !event\.shiftKey && !event\.nativeEvent\.isComposing/, 'Enter starts, Shift+Enter breaks the line, an IME composition is left alone');
  assert.match(home, /new-work-hint[^\n]*输入需求后按 Enter 开始/);
  const css = read('src/features/home/home.css');
  assert.ok(rule(css, '.new-work.is-stage').includes('width: min(760px, 100%)'));
  assert.ok(rule(css, '.new-work-title').includes('font-size: 24px; font-weight: 600'));
  const sub = rule(css, '.new-work-sub');
  assert.ok(sub.includes('margin: 8px 0 24px') && sub.includes('font-size: 14px; font-weight: 400') && sub.includes('var(--text-2)'), '8px under the title, 24px above the box, the helper colour');
  const box = css.split(/\r?\n/).find(line => line.startsWith('.new-work.is-stage .new-work-input {'));
  for (const part of ['min-height: 128px', 'border-radius: 16px', 'padding: 16px', 'var(--compose-border)', 'var(--compose-shadow)']) assert.ok(box.includes(part), part);
  assert.ok(rule(css, '.home-right.is-stage').includes('padding-bottom: 92px'), 'the title and the box sit 70px above where the old empty state sat');
  assert.ok(css.includes('.new-work.is-stage .new-work-input:has(textarea:focus-visible) { border-color: var(--compose-accent); }'));
});

test('the send button is a quiet grey square until there is text, then the brand blue with a white icon', () => {
  const css = read('src/features/home/home.css'), themes = read('src/shared/styles/themes.css');
  assert.ok(rule(css, '.home-layer .new-work-start:not(.primary)').includes('background: var(--bg-hover)'));
  const filled = rule(css, '.home-layer .new-work-start.primary');
  assert.ok(filled.includes('color: #fff') && filled.includes('background: var(--compose-accent)'));
  assert.match(themes, /\.home-layer \{ --compose-border: var\(--border\); --compose-shadow: none; --compose-accent: #5686c4;/);
  assert.match(themes, /:root\[data-theme="light"\] \.home-layer \{ --compose-border: #cbd5e1; --compose-shadow: 0 4px 18px rgb\(20 30 50 \/ \.04\); \}/);
  // white on #5686c4 is 3.75:1, the 3:1 an icon needs; the pressed shade is darker still
  const luminance = hex => { const [r, g, b] = [1, 3, 5].map(at => parseInt(hex.slice(at, at + 2), 16) / 255).map(v => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const ratio = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  for (const blue of ['#5686c4', '#4a77b4', '#3f6aa3']) assert.ok(ratio('#ffffff', blue) >= 3, `${blue} carries a white icon`);
  assert.ok(ratio('#5686c4', '#ffffff') >= 3, 'the focused border reads against the white box');
});

test('the project list recedes: idle sessions are plain names, only the picked one has its fill, its state line and a bold name', () => {
  const inbox = read('src/features/home/DecisionInbox.tsx'), css = read('src/features/home/home.css');
  assert.match(inbox, /group === 'working' \? sessionLine\(item\) : item\.id === selectedId \? tag : ''/);
  assert.match(inbox, /\(decision \|\| group === 'working'\) && <span className=\{`inbox-tag/, 'an idle session has no tag in the list');
  assert.ok(rule(css, '.inbox-text b').includes('font-weight: 400') && rule(css, '.inbox-text b').includes('var(--text-2)'));
  assert.ok(css.includes('.inbox-row:is([aria-selected="true"], .has-decision) .inbox-text b { color: var(--text-1); font-weight: 600; }'));
  assert.ok(rule(css, '.inbox-row.is-compact').includes('height: 36px'));
  assert.doesNotMatch(css, /inbox-row\[aria-selected="true"\]::before/, 'the new reference has no selection bar');
  assert.ok(rule(css, '.home-head h1').includes('font-size: 14px; font-weight: 600'));
});

test('the new texts have English translations', () => {
  for (const text of ['描述一个想法，让 Agentrix 帮你实现。', '描述你想构建的功能、修复的问题，或粘贴截图…', '输入需求后按 Enter 开始', '开始 (Enter)', '添加图片']) assert.ok(text in en, text);
});
