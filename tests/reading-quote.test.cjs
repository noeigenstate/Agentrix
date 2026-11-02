const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { QUOTE_LINES, QUOTE_CHARS, splitQuote, quoteExcerpt, withQuote } = require('../src/features/reading/message-quote.ts');

// The rendering and send-flow tests of quotes sit beside the harnesses they use, in reading-ui.test.cjs.

test('a quote is the message\'s own words: at most 6 lines and 400 characters, cut with an ellipsis', () => {
  assert.equal(QUOTE_LINES, 6); assert.equal(QUOTE_CHARS, 400);
  const nine = Array.from({ length: 9 }, (_, index) => `line ${index + 1}`).join('\n');
  assert.equal(quoteExcerpt(nine), 'line 1\nline 2\nline 3\nline 4\nline 5\nline 6…');
  assert.equal(quoteExcerpt(nine.split('\n').slice(0, 6).join('\n')), 'line 1\nline 2\nline 3\nline 4\nline 5\nline 6', 'exactly six lines is not cut');
  assert.equal(quoteExcerpt('x'.repeat(500)), `${'x'.repeat(400)}…`);
  assert.equal(quoteExcerpt('x'.repeat(400)), 'x'.repeat(400), 'exactly 400 characters is not cut');
  assert.equal(quoteExcerpt(`a${'😀'.repeat(250)}`), `a${'😀'.repeat(199)}…`, 'a cut never leaves half a character');
});

test('blank lines and trailing spaces are dropped, and an empty message has nothing to quote', () => {
  assert.equal(quoteExcerpt('a\n\n  \nb  \r\nc'), 'a\nb\nc');
  assert.equal(quoteExcerpt('  \n\n'), '');
});

test('quoting a message that carries a quote takes its words only, so quotes never nest', () => {
  assert.equal(quoteExcerpt('> old\n> older\n\nnew words'), 'new words');
  assert.equal(quoteExcerpt('> only a quote'), '');
});

test('a quote is "> " lines, a blank line, then the words; a message without one is untouched', () => {
  assert.equal(withQuote('a\nb', 'hi'), '> a\n> b\n\nhi');
  assert.equal(withQuote(undefined, 'hi'), 'hi');
  assert.equal(withQuote('', 'hi'), 'hi');
  assert.ok(withQuote('/status', 'hi').startsWith('> /status'), 'quoted slash text opens with "> ", never as a command');
});

test('the leading quote block is read back exactly', () => {
  assert.deepEqual(splitQuote(withQuote('x\ny', 'z')), { quote: 'x\ny', rest: 'z' });
  assert.deepEqual(splitQuote('> a\n> b\n\nhi'), { quote: 'a\nb', rest: 'hi' });
  assert.deepEqual(splitQuote('> a\r\n\r\nhi'), { quote: 'a', rest: 'hi' });
  assert.deepEqual(splitQuote('> a\nthen'), { quote: 'a', rest: 'then' });
  assert.deepEqual(splitQuote('>\n> b\n\nhi'), { quote: '\nb', rest: 'hi' });
  assert.deepEqual(splitQuote('plain words'), { quote: null, rest: 'plain words' });
  assert.deepEqual(splitQuote('>=5 items\n> later'), { quote: null, rest: '>=5 items\n> later' }, 'only "> " opens a quote, and only at the start');
  assert.deepEqual(splitQuote('words\n> not leading'), { quote: null, rest: 'words\n> not leading' });
});

test('the quote styles use theme tokens and the spacing scale only', () => {
  const css = fs.readFileSync(path.join(__dirname, '../src/features/reading/reading-quote.css'), 'utf8');
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i, 'no literal colours');
  const scale = new Set([0, 2, 4, 8, 12, 16, 20, 24, 32, 40, 48, 64]);
  const spacing = [...css.matchAll(/(?:padding|margin|gap|top|right|left|bottom)[a-z-]*:\s*([^;}]+)/g)].flatMap(match => match[1].match(/-?\d+(?:\.\d+)?px/g) ?? []);
  for (const value of spacing) assert.ok(scale.has(Math.abs(parseFloat(value))), `${value} is off the spacing scale`);
});
