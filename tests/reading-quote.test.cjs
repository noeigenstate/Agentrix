const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { readingMarked } = require('../src/features/reading/markdown-escape.ts');
const { QUOTE_LINES, QUOTE_CHARS, splitQuote, quoteExcerpt, plainExcerpt, withQuote } = require('../src/features/reading/message-quote.ts');

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

test('one blank line stays between blocks and counts toward the 6 lines; its edges, repeats and trailing spaces go', () => {
  assert.equal(quoteExcerpt('a\n\n  \n\nb  \r\nc'), 'a\n\nb\nc');
  assert.equal(quoteExcerpt('\n\n  a\n\n'), '  a', 'blank edges are dropped');
  assert.equal(quoteExcerpt('  \n\n'), '', 'an empty message has nothing to quote');
  assert.equal(quoteExcerpt('1\n2\n3\n4\n5\n\n7'), '1\n2\n3\n4\n5…', 'the blank line is the 6th line, and nothing hangs before the ellipsis');
  assert.equal(quoteExcerpt('1\n2\n3\n4\n\n6'), '1\n2\n3\n4\n\n6', 'six lines with a blank one are not cut');
  assert.ok(quoteExcerpt(`${'x'.repeat(100)}\n\n${'y'.repeat(400)}`).length <= QUOTE_CHARS + 1, 'a blank line never lifts the character bound');
});

test('a paragraph after a list stays its own block in the sent quote, so it never nests in the last item', () => {
  const excerpt = quoteExcerpt('读取分块：\n- 保留偏移量\n- 补上换行\n\n文件结束时冲刷剩余内容。');
  const sent = withQuote(excerpt, '继续');
  assert.equal(sent, '> 读取分块：\n> - 保留偏移量\n> - 补上换行\n>\n> 文件结束时冲刷剩余内容。\n\n继续');
  assert.deepEqual(splitQuote(sent), { quote: excerpt, rest: '继续' });
  assert.match(readingMarked.parse(excerpt), /<\/ul>\s*<p>文件结束时冲刷剩余内容。<\/p>/, 'the paragraph is outside the list');
  assert.doesNotMatch(readingMarked.parse(excerpt.replace('\n\n', '\n')), /<\/ul>\s*<p>/, 'without the blank line it would be a lazy continuation');
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

test('the chip shows the excerpt as one clean line: Markdown markers dropped, lists and lines joined', () => {
  assert.equal(plainExcerpt('我读了 `parser.cjs`，问题出在分块读取：\n1. 读到半行时没有保留偏移量；\n2. 文件末尾没有换行。'),
    '我读了 parser.cjs，问题出在分块读取： 读到半行时没有保留偏移量； 文件末尾没有换行。');
  assert.equal(plainExcerpt('## Title\n- **bold** and *it* and ~~gone~~\n> quoted\n[a link](https://x.y/z) end'), 'Title bold and it and gone quoted a link end');
  assert.equal(plainExcerpt('3) third\n+ plus item'), 'third plus item');
  assert.equal(plainExcerpt('snake_case stays'), 'snake_case stays', 'single underscores are words, not emphasis');
  assert.equal(plainExcerpt('a…'), 'a…'); assert.equal(plainExcerpt(''), '');
});

test('the quote block is laid out by the Markdown renderer and the chip is one line with an ellipsis', () => {
  const read = file => fs.readFileSync(path.join(__dirname, '../src/features/reading', file), 'utf8');
  const css = read('reading-quote.css');
  assert.doesNotMatch(/\.reading-user-quote \{[^}]*\}/.exec(css)[0], /pre-wrap/, 'not raw pre-wrapped text');
  assert.match(css, /\.reading-quote > span \{[^}]*white-space: nowrap/); assert.match(css, /\.reading-quote > span \{[^}]*text-overflow: ellipsis/);
  assert.match(read('PendingPromptEntries.tsx'), /<blockquote className="reading-user-quote"><Markdown text=\{quote\} \/><\/blockquote>/);
  assert.match(read('ReadingQuote.tsx'), /plainExcerpt\(quote\.excerpt\)/);
});
