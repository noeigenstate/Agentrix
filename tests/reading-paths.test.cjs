const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { hookHarness } = require('./helpers/hook-harness.cjs');
const { translate } = require('../electron/i18n.cjs');
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
  assert.doesNotMatch(readingMarked.parse('<img src=x onerror=alert(1)>'), /<img\b/);
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

test('Markdown link reveal decodes spaces and Windows separators, retaining plain-click hrefs and file URLs', t => {
  const previousDocument = globalThis.document, previousFilter = globalThis.NodeFilter;
  globalThis.document = { createTreeWalker: () => ({ nextNode: () => false }) }; globalThis.NodeFilter = { SHOW_TEXT: 4 };
  t.after(() => {
    if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument;
    if (previousFilter === undefined) delete globalThis.NodeFilter; else globalThis.NodeFilter = previousFilter;
  });
  const hrefs = ['reveal%20results/guide.html:142', 'C:%5Cwork%20space%5Cguide.png:142', 'file:///tmp/a%2520b.png', 'https://example.com/a.png', 'javascript:alert(1)'];
  const links = hrefs.map(href => ({ getAttribute: () => href, dataset: {} }));
  load('reading-paths.ts').markReadingPaths({ querySelectorAll: () => links });
  assert.deepEqual(links.map(link => link.dataset.readingPath), ['reveal results/guide.html:142', 'C:\\work space\\guide.png:142', 'file:///tmp/a%2520b.png', undefined, undefined]);
  assert.deepEqual(links.map(link => link.getAttribute('href')), hrefs, 'the existing plain-click URL is untouched');
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
