const test = require('node:test');
const assert = require('node:assert/strict');
const { readCss } = require('./helpers/css-rules.cjs');
const fs = require('node:fs');
const path = require('node:path');

// The choice and question cards use the product scale for type and spacing in both themes.
const reading = readCss('src/features/reading/reading.css');
const card = reading.declarations.filter(({ selector }) => /\.reading-(choice|question|waiting)/.test(selector));
const last = (list, selector, property) => list.findLast(item => item.selector === selector && item.property === property)?.value;
const SPACING = new Set([0, 2, 4, 8, 12, 16, 24, 32]);
const spaced = (list, label) => {
  const off = [];
  for (const { selector, property: name, value } of list) {
    if (!/^(gap|row-gap|column-gap|margin(-[a-z]+)?|padding(-[a-z]+)?)$/.test(name)) continue;
    for (const [, size] of value.replace(/calc\(100% \+ (\d+)px\)/g, '$1px').matchAll(/(\d+(?:\.\d+)?)px/g)) if (!SPACING.has(Number(size))) off.push(`${label} ${selector} { ${name}: ${value} }`);
  }
  return off;
};

test('every text size of the cards is 14, 13 or 12 and every weight 400 or 600', () => {
  const sizes = [], weights = [];
  for (const { selector, property: name, value } of card) {
    if (name === 'font-size') sizes.push([selector, value]);
    if (name === 'font' && value !== 'inherit') {
      const [, weight, size] = /^(\d+) calc\((\d+(?:\.\d+)?)px/.exec(value) ?? [];
      sizes.push([selector, `calc(${size}px`]);
      weights.push([selector, weight]);
    }
    if (name === 'font-weight') weights.push([selector, value]);
  }
  for (const [selector, value] of sizes) {
    if (value === 'inherit') continue;
    assert.match(value, /^calc\((14|13|12)px \* var\(--reading-text\)\)$|^calc\((14|13|12)px$/, `${selector}: ${value}`);
  }
  for (const [selector, value] of weights) assert.ok(['400', '600'].includes(value), `${selector}: weight ${value}`);
});

test('one title level per card: 14px at 600; the body is 13px; details, hints and head actions are 12px', () => {
  for (const selector of ['.reading-choice-head strong', '.reading-question-title']) {
    assert.equal(last(card, selector, 'font-size'), 'calc(14px * var(--reading-text))', selector);
    assert.equal(last(card, selector, 'font-weight'), '600', selector);
  }
  assert.equal(last(card, '.reading-choice', 'font-size'), 'calc(13px * var(--reading-text))', 'the card speaks in the body size');
  assert.equal(last(card, '.reading-choice-label b', 'font-weight'), '400', 'option titles are told by fill and number, not weight');
  assert.equal(last(card, '.reading-question-review dd', 'font-weight'), undefined, 'review answers keep the body weight');
  assert.equal(last(card, '.reading-question-warning', 'font-weight'), undefined, 'the warning keeps the body weight beside its icon');
  for (const selector of ['.reading-choice-label small', '.reading-choice-hint', '.reading-question-review dt', '.reading-question-tab', '.reading-choice-head button', '.reading-question-head .text-button', '.reading-choice-option kbd'])
    assert.equal(last(card, selector, 'font-size'), 'calc(12px * var(--reading-text))', selector);
  assert.match(last(card, '.reading-choice-context', 'font'), /^400 calc\(12px /);
  for (const selector of ['.reading-choice-number', '.reading-question-mark']) assert.match(last(card, selector, 'font'), /^600 calc\(12px /, selector);
});

test('the reading composer textarea is one 32px line: 4px padding around a 24px line, never shorter', () => {
  const input = reading.rule('.reading-composer textarea');
  assert.equal(input.padding, '4px 0');
  assert.equal(input['min-height'], '32px');
  assert.match(input.font, /\/calc\(24px \* var\(--reading-text\)\) /);
});

test('the file cards and the pictures beside them keep their spacing on the scale, their text at 12px and 600', () => {
  const css = reading.declarations, flow = readCss('src/features/reading/reading-flow.css').declarations;
  const files = readCss('src/features/reading/file-cards.css').declarations;
  assert.deepEqual([
    ...spaced(files, 'file-cards.css'),
    ...spaced(flow.filter(item => /file-cards/.test(item.selector)), 'reading-flow.css'),
    ...spaced(css.filter(item => /^\.reading-(generated|generating|composer|commands?(?!-run)|attachments)/.test(item.selector)), 'reading.css'),
  ], []);
  assert.match(last(files, '.file-card-name', 'font'), /^600 calc\(12px /);
  assert.match(last(files, '.file-card-empty', 'font-size'), /calc\(12px /);
});

// The tokens of a theme, by block: the dark base on :root, the light overrides under :root[data-theme="light"]; a var() resolves through the same set.
const themes = readCss('src/shared/styles/themes.css');
const resolve = (set, name) => { const value = set[name]; return value.startsWith('var(') ? resolve(set, value.slice(4, -1)) : value; };
const luminance = hex => { const [r, g, b] = [1, 3, 5].map(at => parseInt(hex.slice(at, at + 2), 16) / 255).map(v => v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4); return .2126 * r + .7152 * g + .0722 * b; };
const contrast = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + .05) / (lo + .05); };

test('a disabled .button is muted, not faded: its text stays 4.5:1 on its own fill in both themes, and a checked box is neutral', () => {
  const css = readCss('src/shared/styles/styles.css'), style = css.rule('button.button:disabled');
  assert.ok(style, 'one rule outranks every variant colour, the primary button included');
  assert.equal(style.opacity, '1', 'opacity would fade text and fill together');
  assert.equal(style.color, 'var(--text-3)'); assert.equal(style.background, 'var(--bg-control)');
  const dark = themes.rule(':root'), light = { ...dark, ...themes.rule(':root[data-theme="light"]') };
  for (const [theme, set] of [['mono', dark], ['light', light]]) assert.ok(contrast(resolve(set, '--text-3'), resolve(set, '--bg-control')) >= 4.5, `${theme}: disabled text on the control fill`);
  const mark = last(card, ':is(.reading-question-option, .reading-question-input).is-checked .reading-question-mark', 'background');
  assert.equal(mark, 'var(--text-1)', 'a checked box is filled with the text colour; the warning accent stays on the card edge');
});

test('the appearance smoke measures both themes under the GUI lock', () => {
  const smoke = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'question-appearance-smoke.mjs'), 'utf8');
  assert.match(smoke, /withGuiLock\('question-appearance'/);
  assert.match(smoke, /THEMES = \['mono', 'light'\]/);
  assert.match(smoke, /AGENTRIX_DATA_DIR: profile/);
});
