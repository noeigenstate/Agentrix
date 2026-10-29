const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const React = require('react');
const vm = require('node:vm');
const { renderToStaticMarkup } = require('react-dom/server');
const { Marked } = require('marked');
const { hookHarness } = require('./helpers/hook-harness.cjs');
const { translate } = require('../electron/i18n.cjs');
const { resolveRevealPathText } = require('../electron/terminal-links.cjs');
const { readingMarked } = require('../src/features/reading/markdown-escape.ts');

function load(name, platform = { isMac: false, isWindows: true }) {
  const filename = path.join(__dirname, '../src/features/reading', name), mod = new Module(filename, module);
  mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename));
  const original = mod.require.bind(mod);
  mod.require = specifier => {
    if (specifier === '../../shared/platform') return platform;
    if (specifier === '../../shared/i18n') return { t: text => translate('en', text) };
    if (specifier === './reading-paths') return load('reading-paths.ts', platform);
    if (specifier.startsWith('../terminal/terminal-links')) return require('../src/features/terminal/terminal-links.ts');
    return original(specifier);
  };
  mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText, filename);
  return mod.exports;
}

test('both reading Markdown parsers retain UNC and Windows path backslashes while preserving ordinary Markdown', () => {
  for (const text of ['\\\\server\\share\\guide-whats-new.png', 'C:\\_work\\[draft]\\guide-whats-new.png', 'src\\_parts\\App.tsx:142']) {
    assert.ok(readingMarked.parse(`结果：${text}。`).includes(text), text);
    assert.ok(readingMarked.parse(`结果：\`${text}\`。`).includes(`<code>${text}</code>`), text);
  }
  assert.match(readingMarked.parse('[文件](src/App.tsx:142) **粗体** \\*普通星号\\*'), /<a href="src\/App.tsx:142">文件<\/a> <strong>粗体<\/strong> \*普通星号\*/);
  const ordinaryLinks = '[relative](docs/guide\\_draft.md "a \\"title\\"") [web](https://example.com/a\\(b\\).html)';
  assert.equal(readingMarked.parse(ordinaryLinks), new Marked({ async: false, gfm: true, breaks: true }).parse(ordinaryLinks));
  assert.doesNotMatch(readingMarked.parse('<img src=x onerror=alert(1)>'), /<img\b/);
});

test('long Markdown sends the break mode to the worker and caches each mode separately', async t => {
  const previousWorker = globalThis.Worker, requests = [], worker = {};
  const file = path.join(__dirname, '../src/features/reading/markdown.worker.ts');
  const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(source, { exports: {}, require: () => ({ readingMarked }), self: worker }, { filename: file });
  globalThis.Worker = class {
    postMessage(data) {
      requests.push(data);
      worker.postMessage = result => queueMicrotask(() => this.onmessage({ data: result }));
      worker.onmessage({ data });
    }
  };
  t.after(() => { if (previousWorker === undefined) delete globalThis.Worker; else globalThis.Worker = previousWorker; });
  const { parseMarkdown, parsedMarkdown } = require('../src/features/reading/markdown-parse.ts');
  const text = `First line\ncontinues here.\n\n<unsafe>\n\nC:\\_work\\guide.md\n\n${'word '.repeat(900)}`;
  const hard = await parseMarkdown(text), soft = await parseMarkdown(text, true);
  assert.match(hard, /First line<br>continues here\./);
  assert.match(soft, /First line\ncontinues here\./);
  for (const html of [hard, soft]) { assert.ok(html.includes('&lt;unsafe&gt;')); assert.ok(html.includes('C:\\_work\\guide.md')); }
  assert.equal(parsedMarkdown(text), hard); assert.equal(parsedMarkdown(text, true), soft);
  assert.equal(await parseMarkdown(text, true), soft); assert.equal(await parseMarkdown(text), hard);
  assert.deepEqual(requests.map(request => request.softBreaks), [false, true]);
});

test('an in-flight long parse never shows results for the wrong break mode', async t => {
  const pending = [], text = 'long '.repeat(1000);
  const h = hookHarness('src/features/reading/useLongMarkdown.ts', { './markdown-parse.ts': {
    parsedMarkdown: () => undefined,
    parseMarkdown: (value, softBreaks) => new Promise(resolve => pending.push({ value, softBreaks, resolve })),
  } });
  t.after(() => h.dispose());
  assert.equal(h.render('useLongMarkdown', text, false, true).result, null);
  assert.equal(h.render('useLongMarkdown', text, false, false).result, null);
  pending[0].resolve('soft result'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.render('useLongMarkdown', text, false, false).result, null);
  assert.deepEqual(pending.map(job => [job.value, job.softBreaks]), [[text, true], [text, false]]);
  pending[1].resolve('hard result'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.render('useLongMarkdown', text, false, false).result, 'hard result');
});

test('reading path spans retain all text for selection/copy and escape agent output', () => {
  const { PathText } = load('PathText.tsx');
  const text = '请查看src/App.tsx:142，再看 `C:\\项目\\guide-whats-new.png`。<script>alert(1)</script>';
  const html = renderToStaticMarkup(React.createElement(PathText, { text }));
  assert.match(html, /data-reading-path="src\/App.tsx:142"/);
  assert.match(html, /data-reading-path="C:\\项目\\guide-whats-new.png"/);
  assert.match(html, /title="Ctrl\+click to show in File Explorer"/);
  assert.doesNotMatch(html, /<a\b|<button\b|<script>/);
  assert.equal(html.replace(/<[^>]+>/g, '').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&'), text);
});

test('path affordances name the native modifier and file manager in each platform', () => {
  assert.equal(load('reading-paths.ts').pathTooltip(), 'Ctrl+click to show in File Explorer');
  assert.equal(load('reading-paths.ts', { isMac: true, isWindows: false }).pathTooltip(), '⌘+click to show in Finder');
  assert.equal(load('reading-paths.ts', { isMac: false, isWindows: false }).pathTooltip(), 'Ctrl+click to show in the file manager');
});

test('Markdown link reveal preserves Windows punctuation separators through parsing, decoding and resolution', t => {
  const previousDocument = globalThis.document, previousFilter = globalThis.NodeFilter;
  globalThis.document = { createTreeWalker: () => ({ nextNode: () => false }) }; globalThis.NodeFilter = { SHOW_TEXT: 4 };
  t.after(() => {
    if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument;
    if (previousFilter === undefined) delete globalThis.NodeFilter; else globalThis.NodeFilter = previousFilter;
  });
  const paths = ['reveal results/guide.html:142', 'C:\\work space\\guide.png:142',
    'C:\\work\\.test-output\\project\\reveal results\\guide-whats-new.html',
    'C:\\_work\\[draft]\\guide.html', '\\\\server\\share\\.results\\guide.html', 'file:///tmp/a%2520b.png'];
  const hrefs = [...paths, 'https://example.com/a.png', 'javascript:alert(1)']
    .map(target => readingMarked.parse(`[file](<${target}>)`).match(/href="([^"]+)"/)[1]);
  const links = hrefs.map(href => ({ getAttribute: () => href, dataset: {} }));
  load('reading-paths.ts').markReadingPaths({ querySelectorAll: () => links });
  assert.deepEqual(links.map(link => link.dataset.readingPath), [...paths, undefined, undefined]);
  assert.deepEqual(links.map(link => link.getAttribute('href')), hrefs, 'the existing plain-click URL is untouched');
  for (const index of [2, 3, 4]) {
    assert.equal(resolveRevealPathText('C:\\work', links[index].dataset.readingPath, 'C:\\Users\\owner', 'win32'), paths[index]);
  }
});

test('modifier capture reveals paths, preserves plain click and selection, and reports IPC errors through the usual callback', async t => {
  const previous = globalThis.window, calls = [], errors = [];
  let result = { ok: true };
  globalThis.window = { agentrix: {
    revealPath: async (...args) => { calls.push(args); if (result instanceof Error) throw result; return result; },
  } };
  t.after(() => { if (previous === undefined) delete globalThis.window; else globalThis.window = previous; });
  const { revealPathClick } = load('reading-paths.ts');
  const event = overrides => ({ button: 0, ctrlKey: false, metaKey: false,
    target: { closest: () => ({ dataset: { readingPath: 'src/App.tsx:142' } }) },
    prevented: false, stopped: false,
    preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...overrides,
  });
  for (const overrides of [{}, { ctrlKey: true, button: 2 }, { metaKey: true }, { ctrlKey: true, target: { closest: () => null } }]) {
    const click = event(overrides); revealPathClick(click, 'project', message => errors.push(message));
    assert.equal(click.prevented, false); assert.equal(click.stopped, false);
  }
  assert.deepEqual(calls, [], 'plain clicks and text selection never reach the IPC');
  const click = event({ ctrlKey: true });
  revealPathClick(click, 'project', message => errors.push(message));
  assert.equal(click.prevented, true); assert.equal(click.stopped, true, 'the card or anchor plain-click action cannot also run');
  assert.deepEqual(calls, [['project', 'src/App.tsx:142']]);
  const mac = load('reading-paths.ts', { isMac: true, isWindows: false });
  mac.revealPathClick(event({ ctrlKey: true }), 'mac', message => errors.push(message));
  assert.equal(calls.length, 1);
  mac.revealPathClick(event({ metaKey: true }), 'mac', message => errors.push(message));
  assert.equal(calls.at(-1)[0], 'mac');
  result = { ok: false, error: '未找到此路径。' };
  revealPathClick(event({ ctrlKey: true }), 'project', message => errors.push(message));
  await new Promise(setImmediate);
  assert.deepEqual(errors, ['Path not found.']);
  result = new Error('IPC gone');
  revealPathClick(event({ ctrlKey: true }), 'project', message => errors.push(message));
  await new Promise(setImmediate);
  assert.equal(errors.at(-1), 'Could not show this path in the file manager.');
});

test('modifier styling follows keyboard, pointer and blur events without rerendering or leaving listeners behind', t => {
  const handlers = new Map(), previous = [globalThis.addEventListener, globalThis.removeEventListener];
  globalThis.addEventListener = (name, fn) => handlers.set(name, fn);
  globalThis.removeEventListener = name => handlers.delete(name);
  const clicks = [];
  const harness = hookHarness('src/features/reading/useReadingPaths.ts', { './platform': { isMac: false }, './reading-paths': { revealPathClick: event => clicks.push(event) } });
  t.after(() => {
    harness.dispose();
    [globalThis.addEventListener, globalThis.removeEventListener] = previous;
  });
  const { result, renders } = harness.render('useReadingPaths', 'project', () => {});
  const attributes = new Set(), node = {
    toggleAttribute: (key, held) => held ? attributes.add(key) : attributes.delete(key),
    removeAttribute: key => attributes.delete(key),
  };
  result.ref.current = node;
  handlers.get('keydown')({ ctrlKey: true }); assert.ok(attributes.has('data-reveal-modifier'));
  handlers.get('keyup')({ ctrlKey: false }); assert.ok(!attributes.has('data-reveal-modifier'));
  result.onMouseMoveCapture({ currentTarget: node, ctrlKey: true }); assert.ok(attributes.has('data-reveal-modifier'));
  handlers.get('blur')(); assert.ok(!attributes.has('data-reveal-modifier'));
  result.onMouseDownCapture({ clientX: 10, clientY: 10 }); result.onClickCapture({ clientX: 60, clientY: 10 });
  assert.equal(clicks.length, 0, 'a text-selection drag does not invoke reveal');
  result.onMouseDownCapture({ clientX: 10, clientY: 10 }); result.onClickCapture({ clientX: 10, clientY: 10 });
  assert.equal(clicks.length, 1);
  assert.equal(renders.length, 1);
  harness.dispose(); assert.equal(handlers.size, 0);
});
