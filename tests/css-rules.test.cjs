const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseCss } = require('./helpers/css-rules.cjs');

test('CSS rule keys preserve selector lists, scoped variables, percentage frames and repeated declarations', () => {
  const sheet = parseCss(`
    :root { --ink: black; }
    :root[data-theme="light"] { --ink: navy; }
    :is(.card, .panel), [data-name="a,b"] {
      color: black;
      color: var(--ink);
    }
    @media (prefers-color-scheme: dark) {
      :root { --ink: white; }
      @container (max-width: 300px) {
        .card { color: silver; }
      }
    }
    @keyframes fade {
      0%, 20% { opacity: 0; }
      100% { opacity: 1; }
    }
  `);
  const dark = '@media (prefers-color-scheme: dark)';
  assert.equal(sheet.rule(':root')['--ink'], 'black');
  assert.equal(sheet.rule(':root[data-theme="light"]')['--ink'], 'navy');
  assert.equal(sheet.rule(':root', dark)['--ink'], 'white');
  assert.equal(sheet.rule('.card', dark, '@container (max-width: 300px)').color, 'silver');
  assert.equal(sheet.rule('.card'), undefined);
  assert.equal(sheet.rule(':is(.card, .panel)').color, 'var(--ink)');
  assert.equal(sheet.rule('[data-name="a,b"]').color, 'var(--ink)');
  const group = ':is(.card, .panel), [data-name="a,b"]';
  assert.deepEqual(sheet.declarations.filter(({ selector }) => selector === group).map(({ value }) => value), ['black', 'var(--ink)']);
  assert.equal(sheet.rule('20%', '@keyframes fade').opacity, '0');
  assert.equal(sheet.rule('100%', '@keyframes fade').opacity, '1');
});
