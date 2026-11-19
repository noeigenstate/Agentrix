const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readingMarked } = require('../src/features/reading/markdown-escape.ts');
const { allowReadingMath } = require('../src/features/reading/markdown-math-sanitize.ts');
const { menuText, selectedWithin } = require('../src/features/reading/message-menu.ts');
const { quoteExcerpt, splitQuote, withQuote } = require('../src/features/reading/message-quote.ts');

const sample = String.raw`\[
\frac{u^{n+1}-u^n}{\Delta t}
=\underbrace{F(u^n)}_{\text{显式}}
+\underbrace{G(u^{n+1})}_{\text{隐式}}。
\]
这里 \(u^n\) 已知，\(u^{n+1}\) 要求解。`;
const parse = source => readingMarked.parse(source);
const count = (html, pattern) => [...html.matchAll(pattern)].length;

test('the reported Codex reply renders one display and two inline formulas', () => {
  const html = parse(sample);
  assert.equal(count(html, /class="katex-display"/g), 1);
  assert.equal(count(html, /class="katex"/g), 3);
  const visible = html.replace(/<annotation\b[^>]*>[\s\S]*?<\/annotation>|data-reading-math-source="[^"]*"/g, '');
  assert.doesNotMatch(visible, /<em>|\\|_\{/);
  assert.match(visible, /显式/);
  assert.match(visible, /隐式/);
});

test('the worker entry point renders the same math in a long reply', t => {
  const previous = globalThis.self;
  t.after(() => { if (previous === undefined) delete globalThis.self; else globalThis.self = previous; });
  const replies = [];
  globalThis.self = { postMessage: message => replies.push(message) };
  require('../src/features/reading/markdown.worker.ts');
  const text = 'Prose without math. '.repeat(300) + '\n\n' + sample;
  globalThis.self.onmessage({ data: { id: 1, text, softBreaks: false } });
  assert.deepEqual(replies, [{ id: 1, html: parse(text) }]);
  assert.equal(count(replies[0].html, /class="katex"/g), 3);
});

test('dollar formulas render before Markdown emphasis, with display math across lines', () => {
  const html = parse('Read *this $a*b$ first*.\n$$\nx^2\n\n+ y^2\n$$');
  assert.equal(count(html, /class="katex"/g), 2);
  assert.equal(count(html, /class="katex-display"/g), 1);
  assert.match(html, /<em>this <span [\s\S]+ first<\/em>/);
  assert.match(parse(String.raw`*this \(a*b\) first*`), /<em>this <span [\s\S]+ first<\/em>/);
});

test('currency and shell text keep their dollars and single-dollar math follows its boundaries', () => {
  for (const source of ['$5 and $10', '$HOME/$USER', '$HOME:$PATH', 'cost is $3.50', '$ x$', '$x $', '$x$2', '$x\n+y$']) {
    assert.doesNotMatch(parse(source), /class="katex"/, source);
    assert.equal(parse(source), readingMarked.parse(source, undefined, false), source);
  }
  assert.match(parse('Tax is $3.50 and $x$ is the rate.'), /Tax is \$3\.50 and <span [\s\S]+ is the rate/);
});

test('inline and fenced code preserve delimiter text', () => {
  const source = ['Inline ' + '\x60' + String.raw`\(x\) $y$ $$z$$` + '\x60', '', '\x60\x60\x60markdown', sample, '$$x$$', '\x60\x60\x60'].join('\n');
  assert.equal(parse(source), readingMarked.parse(source, undefined, false));
  assert.match(parse(source), /<pre><code class="language-markdown">\\\[/);
});

test('a bracketed Windows directory stays a literal path', () => {
  const source = String.raw`Open C:\[draft]\guide.md`;
  assert.equal(parse(source), readingMarked.parse(source, undefined, false));
  assert.ok(parse(source).includes(source));
});

test('invalid formulas, including unknown or untrusted commands, fall back to code', () => {
  const invalid = [String.raw`\(\frac{x}\)`, String.raw`$\unknown{x}$`, String.raw`$\htmlStyle{position:fixed}{x}$`];
  for (const source of invalid) {
    const html = parse(source);
    assert.ok(html.includes('<code>' + source + '</code>'), source);
    assert.doesNotMatch(html, /class="katex"/);
  }
});

test('unclosed display math stays literal in the same display box until the closer arrives', () => {
  for (const [start, close] of [[String.raw`\[`, String.raw`\]`], ['$$', '$$']]) {
    for (const prefix of ['', 'Before ']) {
      const draft = prefix + start + '\nx_{1} + y_{2}';
      const html = parse(draft);
      assert.match(html, /class="reading-math-display"/);
      assert.ok(html.includes('">' + start + '\nx_{1} + y_{2}</span>'));
      assert.doesNotMatch(html, /class="katex"|<em>/);
      assert.equal(count(parse(draft + '\n' + close), /class="katex-display"/g), 1);
    }
  }
  const fence = '\x60\x60\x60\n$$x$$\n\x60\x60\x60';
  assert.match(parse('$$\nx\n' + fence), /<pre><code>\$\$x\$\$/);
});

test('the sanitizer admits formula layout only inside a formula and still escapes reply HTML', () => {
  const hooks = {};
  allowReadingMath({ addHook: (name, hook) => { hooks[name] = hook; } });
  const svg = { localName: 'svg', closest: () => ({}) };
  const plain = { localName: 'span', closest: () => null };
  const allowedTags = {};
  hooks.uponSanitizeElement(svg, { tagName: 'svg', allowedTags });
  hooks.uponSanitizeElement(plain, { tagName: 'span', allowedTags });
  assert.deepEqual(allowedTags, { svg: true, span: false });
  const style = (node, attrValue) => {
    const event = { attrName: 'style', attrValue, keepAttr: true };
    hooks.uponSanitizeAttribute(node, event);
    return event.keepAttr;
  };
  assert.equal(style(plain, 'height:1em;'), false);
  assert.equal(style({ ...plain, closest: svg.closest }, 'height:1em;top:-0.3em;'), true);
  assert.equal(style({ ...plain, closest: svg.closest }, 'position:fixed;'), false);
  assert.equal(style({ ...plain, closest: svg.closest }, 'color:url(https://example.invalid);'), false);
  assert.match(parse('<span data-reading-math-source="x" style="position:fixed">$x$</span>'), /&lt;span data-reading-math-source=/);
});

test('message copy and quote retain the LaTeX source even when the formula is selected', () => {
  assert.equal(menuText(sample, ''), sample);
  assert.equal(splitQuote(withQuote(quoteExcerpt(sample), 'continue')).quote, sample);

  const source = String.raw`\(x^2\)`, rendered = 'Before x² after';
  const formula = { getAttribute: () => source };
  const makeRange = (start, end) => ({
    intersectsNode: node => node === formula,
    cloneRange: () => makeRange(start, end),
    setEndBefore: () => { end = 7; },
    setStartAfter: () => { start = 9; },
    toString: () => rendered.slice(start, end),
  });
  const selected = selectedWithin({ contains: () => true, querySelectorAll: () => [formula] }, {
    isCollapsed: false, anchorNode: {}, focusNode: {}, rangeCount: 1, getRangeAt: () => makeRange(0, rendered.length), toString: () => rendered,
  });
  assert.equal(menuText(sample, selected), 'Before ' + source + ' after');
  assert.equal(quoteExcerpt(selected), 'Before ' + source + ' after');
});
