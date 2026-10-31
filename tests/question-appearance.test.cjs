const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// The choice, question, review and waiting cards, the reading composer and the file cards, read as CSS text: the type
// levels sit on the product scale (14/13/12, weights 400/600) and the spacing on the 2/4/8/12/16/24/32 steps.
// themes.css overrides no size or weight of these classes, so one reading covers the mono and light themes.
const reading = path.join(__dirname, '..', 'src', 'features', 'reading');
const strip = css => css.replace(/\/\*[\s\S]*?\*\//g, '');
const rules = file => [...strip(fs.readFileSync(path.join(reading, file), 'utf8')).matchAll(/([^{}]+)\{([^}]*)\}/g)].map(match => ({ selector: match[1].trim(), body: match[2] }));
const declarations = body => body.split(';').map(item => [item.slice(0, item.indexOf(':')).trim(), item.slice(item.indexOf(':') + 1).trim()]).filter(([name]) => name);
const rule = (list, selector) => list.filter(item => item.selector === selector).flatMap(item => declarations(item.body));
const last = (list, selector, property) => rule(list, selector).filter(([name]) => name === property).at(-1)?.[1];
const card = rules('reading.css').filter(item => /\.reading-(choice|question|waiting)/.test(item.selector));
const SPACING = new Set([0, 2, 4, 8, 12, 16, 24, 32]);
const spaced = (list, label) => {
  const off = [];
  for (const item of list) for (const [name, value] of declarations(item.body)) {
    if (!/^(gap|row-gap|column-gap|margin(-[a-z]+)?|padding(-[a-z]+)?)$/.test(name)) continue;
    for (const [, size] of value.replace(/calc\(100% \+ (\d+)px\)/g, '$1px').matchAll(/(\d+(?:\.\d+)?)px/g)) if (!SPACING.has(Number(size))) off.push(`${label} ${item.selector} { ${name}: ${value} }`);
  }
  return off;
};

test('every text size of the cards is 14, 13 or 12 and every weight 400 or 600', () => {
  const sizes = [], weights = [];
  for (const item of card) for (const [name, value] of declarations(item.body)) {
    if (name === 'font-size') sizes.push([item.selector, value]);
    if (name === 'font' && value !== 'inherit') { const [, weight, size] = /^(\d+) calc\((\d+(?:\.\d+)?)px/.exec(value) ?? []; sizes.push([item.selector, `calc(${size}px`]); weights.push([item.selector, weight]); }
    if (name === 'font-weight') weights.push([item.selector, value]);
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
  const css = rules('reading.css'), selector = '.reading-composer textarea';
  assert.equal(last(css, selector, 'padding'), '4px 0');
  assert.equal(last(css, selector, 'min-height'), '32px');
  assert.match(last(css, selector, 'font'), /\/calc\(24px \* var\(--reading-text\)\) /);
});

test('the file cards and the pictures beside them keep their spacing on the scale, their text at 12px and 600', () => {
  const css = rules('reading.css'), flow = rules('reading-flow.css'), files = rules('file-cards.css');
  assert.deepEqual([
    ...spaced(files, 'file-cards.css'),
    ...spaced(flow.filter(item => /file-cards/.test(item.selector)), 'reading-flow.css'),
    ...spaced(css.filter(item => /^\.reading-(generated|generating|composer|commands?(?!-run)|attachments)/.test(item.selector)), 'reading.css'),
  ], []);
  assert.match(last(files, '.file-card-name', 'font'), /^600 calc\(12px /);
  assert.match(last(files, '.file-card-empty', 'font-size'), /calc\(12px /);
});

test('the appearance smoke measures both themes under the GUI lock', () => {
  const smoke = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'question-appearance-smoke.mjs'), 'utf8');
  assert.match(smoke, /withGuiLock\('question-appearance'/);
  assert.match(smoke, /THEMES = \['mono', 'light'\]/);
  assert.match(smoke, /AGENTRIX_DATA_DIR: profile/);
});
