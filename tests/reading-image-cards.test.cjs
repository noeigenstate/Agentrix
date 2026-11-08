const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), Module = require('node:module'), vm = require('node:vm');
const ts = require('typescript');
const { replyFiles } = require('../src/features/reading/reply-files.ts');
const { createFileCards } = require('../electron/features/files/file-cards.cjs');

function cards() {
  let index = 0; const slots = [];
  const hooks = {
    useState(initial) { const key = index++; slots[key] ??= { value: initial }; return [slots[key].value, value => { slots[key].value = typeof value === 'function' ? value(slots[key].value) : value; }]; },
    useRef(initial) { const key = index++; return slots[key] ??= { current: initial }; },
    useCallback(fn) { index++; return fn; }, useEffect() {},
  };
  const file = path.join(__dirname, '../src/features/reading/FileCards.tsx'), mod = new Module(file, module);
  mod.filename = file; mod.paths = Module._nodeModulePaths(path.dirname(file)); const original = mod.require.bind(mod);
  mod.require = name => name === 'react' ? hooks : name === '@phosphor-icons/react' ? { FileHtml: () => null, FileText: () => null, FilmStrip: () => null, Image: () => null } : name.endsWith('.css') ? {} : name.endsWith('/i18n') ? { t: value => value }
    : name.endsWith('/file-popup') ? { showPopup() {} } : name === './reading-paths' ? { pathTooltip: () => '' } : original(name);
  mod._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, file);
  return props => { index = 0; return mod.exports.FileCards({ projectId: 'p', renderMarkdown: text => text, onError: assert.fail, ...props }).props.children[0]; };
}

test('a filename and Markdown path resolve to one actual image, without treating image alt text as another file', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-reply-image-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const image = Buffer.alloc(24); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(image); image.writeUInt32BE(8, 16); image.writeUInt32BE(8, 20);
  fs.writeFileSync(path.join(root, 'eastern-dragon.png'), image);
  const absolute = path.join(root, 'eastern-dragon.png');
  const text = '生成了 `eastern-dragon.png`（1536×1024，2.92 MB）\n![eastern-dragon.png](./eastern-dragon.png)\n完整路径：`' + absolute + '`';
  const files = replyFiles(text); assert.deepEqual(files, ['eastern-dragon.png', './eastern-dragon.png', absolute]);
  assert.deepEqual(replyFiles('![eastern-dragon.png](art/eastern-dragon.png)'), ['art/eastern-dragon.png']);
  const resolve = createFileCards({ previews: {}, capture: async () => null, shrink: () => 'data:image/png;base64,SMALL' });
  const render = cards(), initial = render({ files });
  // Resolve the later alias first: reply order, not callback order, picks the survivor.
  for (const child of [...initial].reverse()) child.props.onResolved(child.props.file, await resolve({ id: 'p', path: root }, child.props.file));
  assert.deepEqual(render({ files }).map(child => child.props.file), ['eastern-dragon.png']);
  assert.equal(cards()({ files }).length, 3, 'a different reply starts with its own resolution set');
});

test('resolved identity keeps equal basenames in different folders and POSIX case-sensitive paths', () => {
  const render = cards(), files = ['a/eastern-dragon.png', 'b/eastern-dragon.png', 'A.png', 'a.png', './a/eastern-dragon.png'];
  const children = render({ files });
  const values = ['/project/a/eastern-dragon.png', '/project/b/eastern-dragon.png', '/project/A.png', '/project/a.png'];
  children.forEach((child, i) => child.props.onResolved(child.props.file, { kind: 'image', path: values[i], remote: true }));
  assert.equal(render({ files }).length, 4, 'four shown cards still have distinct identities');
  assert.deepEqual(replyFiles('`A.png` and `a.png`'), ['A.png', 'a.png']);
  const all = cards(), aliases = ['a.png', './a.png', '/project/a.png'];
  all({ files: aliases }).forEach(child => child.props.onResolved(child.props.file, { kind: 'image', path: 'a.png', remote: true }));
  assert.equal(all({ files: aliases }).length, 1, 'SSH absolute and relative references share the resolved remote path');
});

test('Windows resolved paths fold case and separators; a generated picture suppresses only its own file', () => {
  const render = cards(), files = ['eastern-dragon.png', './eastern-dragon.png', 'other/eastern-dragon.png'];
  const props = { files, excludeImages: ['C:/project/eastern-dragon.png'] };
  const values = ['C:\\project\\eastern-dragon.png', 'c:/PROJECT/eastern-dragon.png', 'C:/project/other/eastern-dragon.png'];
  render(props).forEach((child, i) => child.props.onResolved(child.props.file, { kind: 'image', path: values[i] }));
  assert.deepEqual(render(props).map(child => child.props.file), ['other/eastern-dragon.png']);
});

test('changing reply inputs or project invalidates resolutions and ignores late callbacks', () => {
  const render = cards(), files = ['a.png', './a.png'];
  const old = render({ files, projectId: 'a' });
  const fresh = render({ files, projectId: 'b' });
  fresh.forEach(child => child.props.onResolved(child.props.file, { kind: 'image', path: '/b/a.png' }));
  old.forEach(child => child.props.onResolved(child.props.file, { kind: 'image', path: '/old/a.png' }));
  assert.equal(render({ files, projectId: 'b' }).length, 1);
  assert.equal(render({ files: ['a.png', './a.png', 'new.png'], projectId: 'b' }).length, 3);
});

test('the shared assistant reply passes its generated image path to the named cards for either provider', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/features/reading/ConversationFeed.tsx'), 'utf8');
  const functionSource = source.slice(source.indexOf('function AssistantReply('), source.indexOf('// The native view hides'));
  const FileCards = () => null, context = { require, exports: {}, useMemo: fn => fn(), replyFiles, FileCards, Markdown: () => null, GeneratedImage: () => null, Message: () => null, t: value => value };
  vm.runInNewContext(ts.transpileModule(functionSource + '\nexport { AssistantReply };', { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, context);
  for (const agent of ['claude', 'codex']) for (const result of [false, true]) {
    const tree = context.exports.AssistantReply({ agent, result, projectId: 'p', onError: assert.fail, entry: { id: 'reply', text: '`eastern-dragon.png`', generated: { path: 'C:/project/eastern-dragon.png', prompt: '' }, images: ['data:image/png;base64,SMALL'] } });
    const child = tree.props.children.find(child => child?.type === FileCards);
    assert.deepEqual([...child.props.excludeImages], ['C:/project/eastern-dragon.png']);
  }
});
