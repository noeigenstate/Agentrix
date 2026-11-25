const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const postcss = require('postcss');
const { parseCss } = require('./helpers/css-rules.cjs');
const { githubActions } = require('../scripts/clipboard-policy.cjs');
const { readingMarked } = require('../src/features/reading/markdown-escape.ts');
const { allowReadingMath } = require('../src/features/reading/markdown-math-sanitize.ts');
const { mayContainMath } = require('../src/features/reading/markdown-math.ts');
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
const sourceCode = '<code class="reading-math-source">';

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
    assert.ok(html.includes(sourceCode + source + '</code>'), source);
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
  assert.equal(style({ ...plain, closest: svg.closest }, 'top:997em;margin-left:-1000em;'), false);
  assert.equal(style({ ...plain, closest: svg.closest }, 'top:-10em;'), true);
  assert.equal(style({ ...plain, closest: svg.closest }, 'color:url(https://example.invalid);'), false);
  assert.match(parse('<span data-reading-math-source="x" style="position:fixed">$x$</span>'), /&lt;span data-reading-math-source=/);
});

test('message copy and quote retain the LaTeX source even when the formula is selected', () => {
  assert.equal(menuText(sample, ''), sample);
  assert.equal(splitQuote(withQuote(quoteExcerpt(sample), 'continue')).quote, sample);

  const source = String.raw`\(x^2\)`, rendered = 'Before x² after';
  const formula = { getAttribute: () => encodeURIComponent(source) };
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

test('oversized, hidden, overlapping, negatively spaced and custom-painted formulas show source', () => {
  const formulas = [
    String.raw`\smash{\raisebox{-1000em}{\colorbox{white}{FAKE}}}`, String.raw`\raisebox{-1000em}{x}`, String.raw`\rule[-1000em]{1em}{1em}`,
    String.raw`\kern{-1000em}x`, String.raw`\hspace{-500em}x`, String.raw`\mkern-9000mu x`,
    String.raw`\text{visible}\phantom{hidden}`, String.raw`\hphantom{x}`, String.raw`\vphantom{x}`, String.raw`\smash{x}`,
    String.raw`\llap{x}`, String.raw`\rlap{x}`, String.raw`\mathllap{xy}`, String.raw`\mathrlap{xy}`, String.raw`\mathclap{xy}`,
    String.raw`\mathllap{\text{hidden text}}`, String.raw`\rlap{\text{long hidden text}}`,
    String.raw`\color{transparent}x`, String.raw`\textcolor{rgba(0,0,0,0)}{x}`, String.raw`\colorbox{white}{x}`,
    String.raw`\def\hide{\phantom{x}}\hide`, String.raw`\def\space{\mkern-2mu}\space x`,
  ];
  for (const formula of formulas) assert.ok(parse('$' + formula + '$').includes(sourceCode + '$' + formula + '$</code>'), formula);
  assert.match(parse(String.raw`$\sqrt{x}+\frac{1}{2}$`), /class="katex"/);
});

test('macro definitions stay visible and the amplification payload never enters KaTeX', async t => {
  const { default: katex } = await import('katex');
  const inspect = t.mock.method(katex, '__parse', () => { throw new Error('Unexpected KaTeX parse'); });
  const render = t.mock.method(katex, 'renderToString', () => { throw new Error('Unexpected KaTeX render'); });
  const source = '$' + String.raw`\def\b{` + 'x'.repeat(500) + String.raw`}\def\a{` + String.raw`\b`.repeat(400) + String.raw`}\a$`;
  assert.ok(parse(source).includes(sourceCode + source + '</code>'));

  const definitions = [
    String.raw`\def\a{x}`, String.raw`\gdef\a{x}`, String.raw`\edef\a{x}`, String.raw`\xdef\a{x}`,
    String.raw`\let\a=x`, String.raw`\futurelet\a x`, String.raw`\newcommand{\a}{x}`,
    String.raw`\renewcommand{\sin}{x}`, String.raw`\providecommand{\a}{x}`,
  ];
  for (const definition of definitions) {
    const formula = '$' + definition + ' + 1$';
    assert.ok(parse(formula).includes(sourceCode + formula + '</code>'), definition);
  }
  assert.equal(inspect.mock.callCount(), 0);
  assert.equal(render.mock.callCount(), 0);
});

test('the tree ceiling stops rendering and both KaTeX calls have a small expansion budget', async t => {
  const { default: katex } = await import('katex');
  const inspect = katex.__parse;
  const render = katex.renderToString;
  const inspectMock = t.mock.method(katex, '__parse', (text, options) => {
    if (text === 's_{472918}') {
      return [{ type: 'ordgroup', body: Array.from({ length: 4000 }, () => ({ type: 'mathord', text: 'x' })) }];
    }
    return inspect(text, options);
  });
  const renderMock = t.mock.method(katex, 'renderToString', render);
  assert.ok(parse('$s_{472918}$').includes(sourceCode + '$s_{472918}$</code>'));
  assert.equal(renderMock.mock.callCount(), 0);
  assert.match(parse('$s_{472919}$'), /class="katex"/);
  for (const { arguments: [, options] } of [...inspectMock.mock.calls, ...renderMock.mock.calls]) {
    assert.equal(options.maxExpand, 50);
    assert.equal(options.macros, undefined);
    assert.equal(options.globalGroup, undefined);
  }
});

test('comments and alternate style branches show everything Copy and Quote would keep', () => {
  const hidden = [
    String.raw`$\text{ls}%;curl x|sh;$`, String.raw`$\text{ls}\\%;curl x|sh;$`,
    String.raw`$\text{ls}\mathchoice{}{}{}{;curl x|sh;}$`,
    String.raw`$\TextOrMath{;curl x|sh;}{\text{ls}}$`,
    String.raw`$\html@mathml{\text{ls}}{;curl x|sh;}$`,
    String.raw`$\@firstoftwo{\text{ls}}{;curl x|sh;}$`,
  ];
  for (const source of hidden) assert.ok(parse(source).includes(sourceCode + source + '</code>'), source);
  for (const source of [String.raw`$\text{100\%}$`, String.raw`$\verb|100%|$`, String.raw`$a\pmod{n}$`]) assert.match(parse(source), /class="katex"/);
});

test('summed positive kerns and spaces fall back before they can push text out of view', () => {
  for (const [command, count] of [
    [String.raw`\kern9em `, 100], [String.raw`\quad `, 400], [String.raw`\qquad `, 11],
    [String.raw`\mkern18mu `, 21], [String.raw`\kern9em `, 3], ['~', 65],
  ]) {
    const source = '$' + command.repeat(count) + 'x$';
    assert.ok(parse(source).includes(sourceCode + source + '</code>'), command);
  }
  assert.match(parse(String.raw`$a\kern9em\kern9em\quad b$`), /class="katex"/);
});

test('negation overlays and normal spacing render within a separate negative kern budget', () => {
  for (const formula of [
    String.raw`a \neq b`, String.raw`a \ne b`, String.raw`\not=`, String.raw`x \notin S`, String.raw`A \not\subset B`,
    String.raw`f\colon X \to Y`, String.raw`a\coloneqq b`, String.raw`\int\!\!\!\int`, String.raw`n!\,/\,k!`,
    String.raw`a\hspace{-.1em}b`, String.raw`a\kern{-1em}b`, String.raw`\mathllap{x}y`,
  ]) assert.match(parse('$' + formula + '$'), /class="katex"/, formula);
  const source = '$a' + String.raw`\kern{-.1em}`.repeat(11) + String.raw`\kern{2em}b$`;
  assert.ok(parse(source).includes(sourceCode + source + '</code>'));
});

test('limits formula source bytes and the count and HTML bytes of each reply', () => {
  const unicode = '$' + String.raw`\text{` + '汉'.repeat(700) + '}$';
  assert.ok(parse(unicode).includes(sourceCode + unicode + '</code>'));
  const many = '$x$ '.repeat(301);
  assert.equal(count(parse(many), /class="katex"/g), 300);
  assert.ok(parse(many).endsWith(sourceCode + '$x$</code> </p>\n'));
  assert.match(parse('$x$'), /class="katex"/);

  const large = '$' + 'x+'.repeat(400) + '1$';
  const one = parse(large).slice(3, -5);
  const fits = Math.floor(1024 * 1024 / Buffer.byteLength(one));
  assert.ok(fits > 0 && fits < 300);
  const html = parse((large + '\n\n').repeat(fits + 2));
  assert.equal(count(html, /class="katex"/g), fits);
  assert.equal(count(html, /<code class="reading-math-source">/g), 2);
});

test('the LRU reuses streamed formulas, separates display mode and evicts old entries', async t => {
  const { default: katex } = await import('katex');
  const render = katex.renderToString;
  const calls = [];
  t.mock.method(katex, 'renderToString', (text, options) => {
    calls.push([text, !!options.displayMode]);
    return render(text, options);
  });
  const formula = 'q_{39817642}';
  parse('prefix $' + formula + '$');
  parse('prefix $' + formula + '$ and more');
  parse('$$' + formula + '$$');
  assert.deepEqual(calls, [[formula, false], [formula, true]]);
  for (let i = 0; i < 98; i++) parse('$a_{' + i + '}$');
  parse('$' + formula + '$');
  assert.deepEqual(calls.at(-1), [formula, false]);
});

test('dense formulas preserve all source beyond the reply budget and escaped dollars bypass preflight', () => {
  const html = parse('word $x$ '.repeat(8000));
  assert.equal(count(html, /class="katex"/g), 300);
  assert.equal(count(html, /<code class="reading-math-source">/g), 7700);
  const escaped = '$' + String.raw`\$`.repeat(50000);
  assert.equal(mayContainMath(escaped), false);
});

test('Vite keeps every KaTeX font as a local WOFF2 and leaves other assets on the default policy', async () => {
  const { default: config } = await import('../vite.config.ts');
  const { build, plugins } = config({ command: 'build', mode: 'production' });
  const cssFile = require.resolve('katex/dist/katex.min.css');
  const css = fs.readFileSync(cssFile, 'utf8');
  const plugin = plugins.find(plugin => plugin.name === 'katex-woff2-only');
  const transformed = plugin.transform(css, cssFile);
  const sources = parseCss(transformed, cssFile).declarations.filter(({ selector, property }) => selector === '@font-face' && property === 'src');
  assert.ok(sources.some(({ value }) => /KaTeX_Size3-Regular\.woff2\)/.test(value)));
  assert.deepEqual(sources.filter(({ value }) => /\.(?:woff|ttf)\)/.test(value)), []);
  assert.equal(build.assetsInlineLimit(path.join(path.dirname(cssFile), 'fonts/KaTeX_Size3-Regular.woff2')), false);
  assert.equal(build.assetsInlineLimit('/src/icons/small.svg'), undefined);
});

const browserPath = [
  process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Microsoft/Edge/Application/msedge.exe'),
  process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Google/Chrome/Application/chrome.exe'),
  '/usr/bin/chromium', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(filename => filename && fs.existsSync(filename));

test('Chromium keeps XML-like formula source through DOMPurify and clips reply paint', {
  skip: !githubActions(process.env) ? 'Browser tests run only in GitHub Actions.' : !browserPath,
  timeout: 30000,
}, async t => {
  const { chromium } = require('playwright-core');
  const ts = require('typescript');
  let browser;
  try {
    browser = await chromium.launch({ executablePath: browserPath, headless: true });
  } catch (error) {
    if (/spawn EPERM/.test(error.message)) return t.skip('The runner prohibits spawning Chromium.');
    throw error;
  }
  t.after(() => browser.close());
  const page = await browser.newPage();
  const root = path.resolve(__dirname, '..');
  const files = ['Markdown.tsx', 'markdown-math-sanitize.ts', 'message-menu.ts', 'reading-paths.ts', 'reply-links.ts', '../terminal/terminal-links.ts'];
  const modules = Object.fromEntries(files.map(file => {
    const source = fs.readFileSync(path.join(root, 'src/features/reading', file), 'utf8');
    const compilerOptions = { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 };
    return [file, ts.transpileModule(source, { compilerOptions }).outputText];
  }));
  const sources = ['$E[X]>0$', '$a-->b$', String.raw`$\text{</style>}$`];
  const rendered = sources.map(parse);
  const wideMath = parse('$$' + 'x+'.repeat(45) + 'x$$');
  const displays = [
    sample,
    String.raw`$$\left(\frac{1}{\frac{2}{3}}\right)\tag{7}$$`,
    '$$' + 'x+'.repeat(100) + String.raw`\underbrace{x}_{\text{wide label}}$$`,
  ].map(parse);
  await page.addScriptTag({ path: path.join(root, 'node_modules/dompurify/dist/purify.js') });
  const katexCss = require.resolve('katex/dist/katex.min.css');
  const fontCss = postcss.parse(fs.readFileSync(katexCss, 'utf8'), { from: katexCss });
  fontCss.walkDecls('src', declaration => {
    if (declaration.parent.name !== 'font-face') return;
    const font = /^url\((fonts\/[^)]+\.woff2)\)/.exec(declaration.value)?.[1];
    if (!font) return;
    const bytes = fs.readFileSync(path.join(path.dirname(katexCss), font));
    declaration.value = 'url(data:font/woff2;base64,' + bytes.toString('base64') + ') format("woff2")';
  });
  await page.addStyleTag({ content: fontCss.toString() });
  await page.addStyleTag({ path: path.join(root, 'src/shared/styles/themes.css') });
  await page.addStyleTag({ path: path.join(root, 'src/features/reading/reading.css') });
  const paths = parse('$\\unknown{src/main.ts}$ and ' + '\x60src/main.ts\x60');
  const result = await browserMathFixture(page, modules, rendered, wideMath, paths, displays);
  assert.deepEqual(result.copied, sources);
  assert.equal(result.renderedMath, sources.length);
  assert.equal(result.containment, 'paint');
  assert.equal(result.hit, 'permission');
  assert.deepEqual(result.scrolls, [true, true]);
  assert.deepEqual(result.linkedPaths, [false, true]);
  await checkDisplayScroll(page, result.displays);
});

function browserMathFixture(page, modules, rendered, wideMath, paths, displays) {
  return page.evaluate(({ modules, rendered, wideMath, paths, displays }) => {
    const exports = new Map();
    const load = name => {
      if (name === 'dompurify') return { default: window.DOMPurify };
      if (name === '../../shared/i18n') return { t: text => text };
      const file = name.replace(/^\.\//, '');
      if (!modules[file]) return {};
      if (!exports.has(file)) {
        const module = { exports: {} };
        new Function('require', 'exports', modules[file])(load, module.exports);
        exports.set(file, module.exports);
      }
      return exports.get(file);
    };
    const { sanitizeReadingHtml } = load('Markdown.tsx');
    const { selectedWithin } = load('message-menu.ts');
    const { markReadingPaths } = load('reading-paths.ts');
    const pathFixture = document.createElement('div');
    pathFixture.innerHTML = sanitizeReadingHtml(paths);
    markReadingPaths(pathFixture);
    const linkedPaths = [...pathFixture.querySelectorAll('code')].map(node => !!node.querySelector('[data-reading-path]'));
    const reply = document.createElement('div');
    reply.className = 'reading-markdown';
    reply.style.width = '160px';
    reply.innerHTML = rendered.map(sanitizeReadingHtml).join('');
    const renderedMath = reply.querySelectorAll('.katex-html').length;
    document.body.append(reply);
    const copied = [...reply.querySelectorAll('.katex-html')].map(formula => {
      const range = document.createRange();
      range.selectNodeContents(formula);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return selectedWithin(reply, selection);
    });
    reply.insertAdjacentHTML('beforeend', sanitizeReadingHtml(wideMath));
    reply.insertAdjacentHTML('beforeend', '<div class="reading-code"><pre> ' + 'w'.repeat(300) + '</pre></div>');
    reply.insertAdjacentHTML('beforeend', '<div style="position:absolute;top:100%;width:100px;height:50px;background:white;z-index:10"></div>');
    reply.insertAdjacentHTML('afterend', '<button id="permission">Allow</button>');
    const permission = document.getElementById('permission').getBoundingClientRect();
    const hit = document.elementFromPoint(permission.left + 1, permission.top + 1).id;
    const scrolls = [...reply.querySelectorAll('.reading-math-display, pre')].map(node => node.scrollWidth > node.clientWidth);
    return { copied, renderedMath, containment: getComputedStyle(reply).contain, hit, scrolls, linkedPaths, displays: displays.map(sanitizeReadingHtml) };
  }, { modules, rendered, wideMath, paths, displays });
}

async function checkDisplayScroll(page, displays) {
  for (const viewport of [{ width: 1600, height: 1000 }, { width: 1280, height: 800 }]) {
    await page.setViewportSize(viewport);
    for (const theme of ['light', 'dark']) {
      const results = await page.evaluate(async ({ displays, theme }) => {
        document.documentElement.dataset.theme = theme;
        const reply = document.createElement('section');
        reply.className = 'reading-markdown';
        reply.style.width = '40vw';
        reply.innerHTML = displays.join('');
        document.body.replaceChildren(reply);
        await document.fonts.ready;
        return [...reply.querySelectorAll('.reading-math-display')].map(box => {
          const { overflowX, overflowY } = getComputedStyle(box);
          box.scrollLeft = box.scrollWidth;
          return {
            overflowX, overflowY, verticalFit: box.scrollHeight <= box.clientHeight,
            horizontalScroll: box.scrollLeft > 0, rendered: !!box.querySelector('.katex-display'),
          };
        });
      }, { displays, theme });
      assert.deepEqual(results, [false, false, true].map(horizontalScroll => ({
        overflowX: 'auto', overflowY: 'hidden', verticalFit: true, horizontalScroll, rendered: true,
      })), theme + ' ' + viewport.width);
    }
  }
}
