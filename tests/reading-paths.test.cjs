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

function load(name, platform = { isMac: false, isWindows: true }, stubs = {}) {
  const filename = path.join(__dirname, '../src/features/reading', name), mod = new Module(filename, module);
  mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename));
  const original = mod.require.bind(mod);
  mod.require = specifier => {
    if (specifier === '../../shared/platform') return platform;
    if (specifier === '../../shared/i18n') return { t: text => translate('en', text) };
    if (Object.hasOwn(stubs, specifier)) return stubs[specifier];
    if (specifier === './reading-paths') return load('reading-paths.ts', platform, stubs);
    if (specifier === './reply-links.ts') return load('reply-links.ts', platform, stubs);
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

test('a plain phrase in prose quotes or brackets is not a path; only code ticks make a bare name one', () => {
  const { PathText } = load('PathText.tsx'), render = (text, literal) => renderToStaticMarkup(React.createElement(PathText, { text, literal }));
  const phrase = '文件结束时冲刷剩余内容';
  for (const text of [`要点是「${phrase}」`, `要点是“${phrase}”`, `要点是'${phrase}'`, `要点是"${phrase}"`, `要点是（${phrase}）`, `要点是 (${phrase})`, `要点是 [${phrase}]`, phrase]) {
    assert.doesNotMatch(render(text), /data-reading-path/, text);
  }
  assert.match(render('docs', true), /data-reading-path="docs"/, 'inline code keeps its bare folder name');
  assert.match(render('见`docs`与「src/app」和「a.md」'), /data-reading-path="docs".*data-reading-path="src\/app".*data-reading-path="a.md"/, 'ticks, separators and extensions still make paths');
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

test('a picture path previews with the modifier, in the picture popup and read where the project is; its tooltip says so', t => {
  const previous = globalThis.window, popups = [], reveals = [];
  globalThis.window = { agentrix: { revealPath: async (...args) => { reveals.push(args); return { ok: true }; } } };
  t.after(() => { if (previous === undefined) delete globalThis.window; else globalThis.window = previous; });
  const stubs = { '../files/file-popup.ts': { showPopup: target => popups.push(target) }, '../files/tree-reveal.ts': { revealInTree: () => false, treeShown: () => false } };
  const paths = load('reading-paths.ts', { isMac: false, isWindows: true }, stubs);
  const click = readingPath => ({ button: 0, ctrlKey: true, metaKey: false, target: { closest: () => ({ dataset: { readingPath } }) }, preventDefault() {}, stopPropagation() {} });
  for (const file of ['docs/猪追老鼠.png', '/home/me/.codex/generated_images/thread/猪追老鼠.png', 'C:\\Users\\me\\shot.JPG:3']) paths.revealPathClick(click(file), 'project', assert.fail);
  paths.revealPathClick(click('src/App.tsx'), 'project', assert.fail);
  assert.deepEqual(popups, [{ kind: 'image', projectId: 'project', path: 'docs/猪追老鼠.png' }, { kind: 'image', projectId: 'project', path: '/home/me/.codex/generated_images/thread/猪追老鼠.png' },
    { kind: 'image', projectId: 'project', path: 'C:\\Users\\me\\shot.JPG:3' }]);
  assert.deepEqual(reveals, [['project', 'src/App.tsx']], 'any other file is still shown in the file manager');
  assert.equal(paths.pathTooltip('docs/a.png'), 'Ctrl+click to preview the picture');
  assert.equal(load('reading-paths.ts', { isMac: true, isWindows: false }, stubs).pathTooltip('docs/a.png'), '⌘+click to preview the picture');
  assert.equal(paths.pathTooltip('docs/a.md'), 'Ctrl+click to show in File Explorer');
});

test('a plain click on a reply path shows it in the open project file tree; a generated picture by its project copy; a small card previews pictures and expands nothing', async t => {
  const previous = globalThis.window, popups = [], reveals = [], opened = [], errors = [], links = [];
  let shown = true, located = { ok: true, value: { kind: 'file', path: 'docs/a.md' } };
  globalThis.window = { agentrix: { openLink: async (...args) => { links.push(args); return located; } } };
  t.after(() => { if (previous === undefined) delete globalThis.window; else globalThis.window = previous; });
  const stubs = { '../files/file-popup.ts': { showPopup: target => popups.push(target) },
    '../files/tree-reveal.ts': { treeShown: () => shown, revealInTree: (projectId, path) => { if (shown) reveals.push([projectId, path]); return shown; } } };
  const { openReplyLink, generatedCopies } = load('reply-links.ts', undefined, stubs);
  const generated = 'C:\\Users\\me\\.codex\\generated_images\\t\\猪追老鼠.png', unsaved = '/home/me/.codex/generated_images/t/other.png';
  const copies = generatedCopies([{ id: 'g', role: 'assistant', at: 1, generated: { path: generated, prompt: '', copied: 'generated-images/猪追老鼠.png' } }, { id: 'h', role: 'assistant', at: 2, generated: { path: unsaved, prompt: '' } }]);
  const open = target => openReplyLink('project', target, copies, value => opened.push(value), message => errors.push(message));
  await open('docs/a.md');
  await open('file:///C:/Users/me/.codex/generated_images/t/%E7%8C%AA%E8%BF%BD%E8%80%81%E9%BC%A0.png');
  await open(unsaved);
  await open('https://example.com/a.png');
  assert.deepEqual(links, [['project', 'docs/a.md']]);
  assert.deepEqual(reveals, [['project', 'docs/a.md'], ['project', 'generated-images/猪追老鼠.png']], 'the copy is shown, not the picture outside the project');
  assert.deepEqual(popups, [{ kind: 'image', projectId: 'project', path: unsaved }], 'a picture with no copy yet opens in the popup');
  assert.deepEqual(opened, ['https://example.com/a.png'], 'a web address opens as before');
  located = { ok: false, error: '该链接指向远程项目目录之外。' };
  await open('/etc/hosts');
  assert.deepEqual(errors, ['该链接指向远程项目目录之外。'], 'other links outside the project stay refused');
  shown = false; popups.length = 0; opened.length = 0; links.length = 0;
  await open(generated); await open('docs/b.png'); await open('docs/b.md');
  assert.deepEqual(popups, [{ kind: 'image', projectId: 'project', path: generated }, { kind: 'image', projectId: 'project', path: 'docs/b.png' }]);
  assert.deepEqual(opened, ['docs/b.md'], 'on a small card anything else opens as before'); assert.deepEqual(links, [], 'and nothing is located in a tree that is not shown');
});

test('a reply link copies the path of the file a plain click shows: a generated picture by its copy, a project file where it is, nothing outside', async t => {
  const previous = globalThis.window, asked = [];
  const found = { 'docs/a.md': 'C:\\work\\docs\\a.md', 'generated-images/猪.png': 'C:\\work\\generated-images\\猪.png', 'src/b.png': '/srv/project/src/b.png' };
  globalThis.window = { agentrix: { linkPath: async (projectId, target) => { asked.push([projectId, target]); return target in found ? { ok: true, value: found[target] } : { ok: false, error: '该链接指向远程项目目录之外。' }; } } };
  t.after(() => { if (previous === undefined) delete globalThis.window; else globalThis.window = previous; });
  const stubs = { '../files/file-popup.ts': { showPopup() {} }, '../files/tree-reveal.ts': { revealInTree: () => false, treeShown: () => false } };
  const { replyLinkPath, generatedCopies } = load('reply-links.ts', undefined, stubs);
  const generated = 'C:\\Users\\me\\.codex\\generated_images\\t\\猪.png', remote = '/home/me/.codex/generated_images/t/鼠.png';
  const copies = generatedCopies([{ id: 'g', role: 'assistant', at: 1, generated: { path: generated, prompt: '', copied: 'generated-images/猪.png' } }]);
  assert.equal(await replyLinkPath('p', 'docs/a.md', copies), 'C:\\work\\docs\\a.md', 'a local project file');
  assert.equal(await replyLinkPath('p', 'src/b.png', copies), '/srv/project/src/b.png', 'an SSH project file, its path on that computer');
  assert.equal(await replyLinkPath('p', generated, copies), 'C:\\work\\generated-images\\猪.png', 'a generated picture with a copy: the copy');
  assert.equal(await replyLinkPath('p', remote, copies), remote, 'a generated picture without a copy: the picture itself');
  assert.equal(await replyLinkPath('p', '/etc/hosts', copies), null, 'a link the click refuses has no path to copy');
  assert.equal(await replyLinkPath('p', 'https://example.com/a.png', copies), null);
  assert.deepEqual(asked, [['p', 'docs/a.md'], ['p', 'src/b.png'], ['p', 'generated-images/猪.png'], ['p', '/etc/hosts']]);
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
