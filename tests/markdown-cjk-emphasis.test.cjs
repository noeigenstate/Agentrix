const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { Worker: Thread } = require('node:worker_threads');
const ts = require('typescript');
const { Marked, marked } = require('marked');
const markedCjkFriendly = require('marked-cjk-friendly').default;
const { readingMarked } = require('../src/features/reading/markdown-escape.ts');

// Exercise the preview component's parser while leaving its DOM sanitization to the existing preview tests.
function preview(t) {
  const oldWindow = globalThis.window, oldDocument = globalThis.document;
  globalThis.window = {};
  globalThis.document = { createElement: () => ({
    innerHTML: '', append(fragment) { this.innerHTML = fragment.html; }, querySelectorAll: () => [],
  }) };
  t.after(() => {
    if (oldWindow === undefined) delete globalThis.window; else globalThis.window = oldWindow;
    if (oldDocument === undefined) delete globalThis.document; else globalThis.document = oldDocument;
  });
  const filename = path.join(__dirname, '../src/features/files/MarkdownPreview.tsx');
  const mod = new Module(filename, module); mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename));
  const original = mod.require.bind(mod);
  mod.require = name => {
    if (name === 'react') return { useMemo: make => make(), useRef: () => ({ current: null }) };
    if (name === 'dompurify') return { default: () => ({ sanitize: html => ({ html }) }) };
    if (name === './markdown.css') return {};
    if (name === '../../shared/i18n') return { t: text => text };
    if (name === '../../shared/markdown-emphasis') return require('../src/shared/markdown-emphasis.ts');
    return original(name);
  };
  const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  mod._compile(source, filename);
  return text => mod.exports.MarkdownPreview({ content: text, baseUrl: 'project-preview://project/docs/readme.md', onOpenLink() {} })
    .props.dangerouslySetInnerHTML.__html;
}

test('reading view and file preview render CJK emphasis and leave literal text alone', t => {
  const parsers = [text => readingMarked.parse(text), preview(t)];
  const examples = [
    ['- **已知情况：**你上次截图的…', '<li><strong>已知情况：</strong>你上次截图的…</li>'],
    ['- **修复方向：**选框优先…', '<li><strong>修复方向：</strong>选框优先…</li>'],
    ['**结果：**好', '<p><strong>结果：</strong>好</p>'],
    ['**「引号」**后文', '<p><strong>「引号」</strong>后文</p>'],
    ['前文**（括号）**后文', '<p>前文<strong>（括号）</strong>后文</p>'],
    ['*斜体：*正文', '<p><em>斜体：</em>正文</p>'],
    ['__结果：__好', '<p><strong>结果：</strong>好</p>'],
    ['前文__（括号）__后文', '<p>前文<strong>（括号）</strong>后文</p>'],
    ['_斜体：_正文', '<p><em>斜体：</em>正文</p>'],
    ['**確認：**次', '<p><strong>確認：</strong>次</p>'],
    ['**상태：**정상', '<p><strong>상태：</strong>정상</p>'],
    ['𠀀**（括号）**𠀀', '<p>𠀀<strong>（括号）</strong>𠀀</p>'],
    ['前文**粗体 *斜体***后文', '<p>前文<strong>粗体 <em>斜体</em></strong>后文</p>'],
    ['**Note:**text', '<p>**Note:**text</p>'],
    ['snake_case', '<p>snake_case</p>'],
    ['2*3*4 公式2*3*4', '<p>2*3*4 公式2*3*4</p>'],
    ['**2*3*4**', '<p><strong>2*3*4</strong></p>'],
    ['**未完成：正文', '<p>**未完成：正文</p>'],
    ['*未完成：正文', '<p>*未完成：正文</p>'],
    ['`**结果：**好`', '<p><code>**结果：**好</code></p>'],
    ['\\*斜体：\\*正文', '<p>*斜体：*正文</p>'],
    ['[**结果：**好](docs/a.md)', '<p><a href="docs/a.md"><strong>结果：</strong>好</a></p>'],
  ];
  for (const parse of parsers) for (const [source, expected] of examples) {
    assert.ok(parse(source).includes(expected), source);
  }
});

test('other marked instances and GFM strikethrough keep their original behavior', t => {
  const original = new Marked({ gfm: true }), parsePreview = preview(t);
  for (const source of ['~~已知：~~正文', '~~delete~~', '**Note:**text', 'snake_case']) {
    assert.equal(parsePreview(source), original.parse(source), source);
  }
  assert.equal(marked.parse('**结果：**好'), original.parse('**结果：**好'), 'the global parser was not modified');
});

test('long unmatched star runs preserve the CJK tokenizer output around other markup', t => {
  const base = new Marked({ gfm: true, tokenizer: { emStrong: markedCjkFriendly().tokenizer.emStrong } });
  const parsePreview = preview(t);
  for (const count of [64, 65, 130]) for (const source of [
    `前文${'*'.repeat(count)}后文`, `*斜体${'*'.repeat(count)}后文`,
    `**粗体${'*'.repeat(count)}后文`, `_斜体_ ${'*'.repeat(count)}后文`,
    `\\*${'*'.repeat(count)}后文`,
  ]) {
    assert.equal(readingMarked.parse(source), base.parse(source), source);
    assert.equal(parsePreview(source), base.parse(source), source);
  }
});

test('the real Markdown worker parses a 20k-star run before its existing timeout', async t => {
  const previous = globalThis.Worker, workers = [];
  const workerFile = path.join(__dirname, '../src/features/reading/markdown.worker.ts');
  const source = ts.transpileModule(fs.readFileSync(workerFile, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  globalThis.Worker = class {
    constructor() {
      const worker = new Thread(`
        const { parentPort, workerData } = require('node:worker_threads');
        const self = { postMessage: data => parentPort.postMessage(data) };
        require('node:vm').runInNewContext(workerData.source, {
          exports: {}, require: () => require(workerData.reading), self,
        });
        parentPort.on('message', data => self.onmessage({ data }));
      `, { eval: true, workerData: { source, reading: path.join(__dirname, '../src/features/reading/markdown-escape.ts') } });
      workers.push(worker); this.worker = worker;
      worker.on('message', data => this.onmessage({ data }));
    }
    postMessage(data) { this.worker.postMessage(data); }
    terminate() { return this.worker.terminate(); }
  };
  t.after(async () => {
    await Promise.all(workers.map(worker => worker.terminate()));
    if (previous === undefined) delete globalThis.Worker; else globalThis.Worker = previous;
  });
  const { parseMarkdown } = require('../src/features/reading/markdown-parse.ts');
  const text = `汉${'*'.repeat(20000)}汉`;
  assert.equal(await parseMarkdown(text), `<p>${text}</p>\n`);
  const digits = '9'.repeat(20000);
  assert.equal(await parseMarkdown(digits), `<p>${digits}</p>\n`);
});
