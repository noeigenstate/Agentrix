const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createFileCards, cardKind, documentText } = require('../electron/features/files/file-cards.cjs');
const { brief, ConversationLog, claudeConversation, codexConversation } = require('../electron/conversation.cjs');
const { ActionLog } = require('../electron/agent-actions.cjs');
const { PreviewResources } = require('../electron/preview-resources.cjs');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cards-'));
  fs.mkdirSync(path.join(root, 'docs'));
  fs.writeFileSync(path.join(root, 'docs', 'guide.md'), '# Guide\n\n' + 'x'.repeat(20000));
  fs.writeFileSync(path.join(root, 'page.html'), '<h1>Page</h1>');
  fs.writeFileSync(path.join(root, 'clip.mp4'), Buffer.alloc(16));
  const opened = [], closed = [];
  const previews = { open: (project, file, kind, mime) => { opened.push([file, kind, mime]); return { previewId: `p${opened.length}`, url: `project-preview://p${opened.length}/${file}` }; }, close: id => closed.push(id) };
  return { project: { id: 'p', kind: 'local', path: root }, previews, opened, closed };
}

test('a Markdown card carries only the start of the file; a video card a preview address', async () => {
  const { project, previews, opened } = fixture();
  const card = createFileCards({ previews, capture: async () => null });
  const doc = await card(project, 'docs/guide.md');
  assert.equal(doc.kind, 'markdown'); assert.equal(doc.path, 'docs/guide.md');
  assert.ok(doc.excerpt.startsWith('# Guide') && doc.excerpt.length <= 8192);
  const video = await card(project, path.join(project.path, 'clip.mp4'));
  assert.deepEqual([video.kind, video.path, video.url], ['video', 'clip.mp4', 'project-preview://p1/clip.mp4']);
  assert.deepEqual(opened, [['clip.mp4', 'video', 'video/mp4']]);
});

test('an HTML page is pictured once per version of the file, one page at a time, and its preview closed after', async () => {
  const { project, previews, closed } = fixture();
  let captures = 0, running = 0, most = 0;
  const card = createFileCards({ previews, capture: async url => { captures++; running++; most = Math.max(most, running); await new Promise(resolve => setTimeout(resolve, 20)); running--; return `picture of ${url}`; } });
  const [first, second] = await Promise.all([card(project, 'page.html'), card(project, 'page.html')]);
  assert.equal(first.picture, second.picture);
  assert.equal(captures, 1, 'the same version is pictured once');
  assert.equal(most, 1);
  assert.equal(closed.length, 1, 'duplicate cards share a single live preview');
  fs.writeFileSync(path.join(project.path, 'page.html'), '<h1>Changed page</h1>');
  await card(project, 'page.html');
  assert.equal(captures, 2, 'a changed file is pictured again');
});

test('files outside the project or of other kinds get no card', async () => {
  const { project, previews } = fixture();
  const card = createFileCards({ previews, capture: async () => null });
  await assert.rejects(card(project, '../outside.html'), /文件在项目目录之外/);
  await assert.rejects(card(project, '../missing-outside.md'), /找不到这个文件/);
  await assert.rejects(card(project, 'notes.txt'), /没有预览卡片/);
  assert.equal(cardKind('README.MD'), 'markdown'); assert.equal(cardKind('a/b.htm'), 'html'); assert.equal(cardKind('x.webm'), 'video'); assert.equal(cardKind('x.PNG'), 'image'); assert.equal(cardKind('x.ts'), null);
});

test('files in a remote project are read over its connection: pages pictured, documents excerpted, images shrunk', async () => {
  const files = { 'site/index.html': '<h1>remote</h1>', 'docs/guide.md': '# 远程文档', 'img/cat.png': 'x'.repeat(300 * 1024) }, reads = [];
  const connection = { ready: Promise.resolve(), info: { root: '/srv/app' }, request: async (op, message) => {
    const content = files[message.path];
    if (op === 'stat') { if (content === undefined) throw new Error('missing'); return { file: true, size: content.length, modifiedAt: 1 }; }
    reads.push([message.path, message.offset, message.length]);
    return Buffer.from(content.slice(message.offset, message.offset + message.length)).toString('base64');
  } };
  const opened = [], previews = { remote: () => connection, open: (project, relative, kind) => { opened.push([relative, kind]); return { url: `project-preview://p/${relative}`, previewId: relative }; }, close: () => {} };
  const shrunk = [];
  const card = createFileCards({ previews, capture: async url => `picture of ${url}`, shrinkBytes: bytes => { shrunk.push(bytes.length); return 'data:image/png;base64,small'; } });
  const project = { id: 'r', kind: 'ssh', path: '/srv/app' };
  assert.deepEqual(await card(project, '/srv/app/site/index.html'), { kind: 'html', path: 'site/index.html', picture: 'picture of project-preview://p/site/index.html' });
  assert.deepEqual(await card(project, 'docs/guide.md'), { kind: 'markdown', path: 'docs/guide.md', excerpt: '# 远程文档' });
  assert.deepEqual(await card(project, 'img/cat.png'), { kind: 'image', path: 'img/cat.png', remote: true, picture: 'data:image/png;base64,small' });
  assert.deepEqual(shrunk, [300 * 1024], 'the whole image arrives, in the pieces the worker reads at once');
  assert.deepEqual(reads.filter(([file]) => file === 'img/cat.png').map(([, offset, length]) => [offset, length]), [[0, 256 * 1024], [256 * 1024, 44 * 1024]]);
  await assert.rejects(card(project, '/etc/site.html'), /文件在项目目录之外/);
  await assert.rejects(card(project, 'img/missing.png'), /找不到这张图片/);
});

test("a Markdown file an agent wrote outside the project (its memory, a note) is still shown, and opens whole", async () => {
  const { project, previews } = fixture();
  const card = createFileCards({ previews, capture: async () => null });
  const memory = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-'));
  const note = path.join(memory, 'CONTEXT.md');
  fs.writeFileSync(note, '# 项目背景\n\n' + '说明'.repeat(6000));
  const shown = await card(project, note);
  assert.deepEqual([shown.kind, shown.path, shown.outside], ['markdown', note, true]);
  assert.ok(shown.excerpt.startsWith('# 项目背景') && Buffer.byteLength(shown.excerpt) <= 8192 && !shown.excerpt.endsWith('�'), 'its start, without a cut character');
  const whole = await documentText(previews, project, note);
  assert.equal(whole.content, fs.readFileSync(note, 'utf8')); assert.equal(whole.truncated, false);
  await assert.rejects(documentText(previews, project, path.join(memory, 'secret.txt')), /只能预览 Markdown 文件/);
  await assert.rejects(documentText(previews, project, 'CONTEXT.md'), /只能预览 Markdown 文件/, 'only by its absolute path');
  // Over SSH it is read on that computer by the worker, by its absolute path there.
  const asked = [];
  const remote = { ready: Promise.resolve(), info: { root: '/srv/app' }, request: async (op, message) => {
    asked.push([op, message.path, message.length]);
    if (op !== 'document') throw new Error('unexpected ' + op);
    return { size: 12, modifiedAt: 1, data: Buffer.from('# 记忆\n\n内容').toString('base64') };
  } };
  const ssh = { id: 'r', kind: 'ssh', path: '/srv/app' };
  const remoteCards = createFileCards({ previews: { remote: () => remote }, capture: async () => null });
  assert.deepEqual(await remoteCards(ssh, '/root/.claude/projects/-srv-app/memory/CONTEXT.md'), { kind: 'markdown', path: '/root/.claude/projects/-srv-app/memory/CONTEXT.md', outside: true, excerpt: '# 记忆\n\n内容' });
  assert.deepEqual(await documentText({ remote: () => remote }, ssh, '/root/notes/plan.md'), { content: '# 记忆\n\n内容', truncated: false });
  assert.deepEqual(asked, [['document', '/root/.claude/projects/-srv-app/memory/CONTEXT.md', 8192], ['document', '/root/notes/plan.md', 2 * 1024 * 1024]]);
  // A relative name starts where the agent works there, not at the project's top.
  asked.length = 0;
  await assert.rejects(remoteCards(ssh, '../notes/plan.md', '/srv/app/sub'), /没有预览卡片/);
  assert.deepEqual(asked.map(([op, file]) => [op, file]), [['stat', 'notes/plan.md']], 'inside the project from where the agent works: read through the project');
});

test('absolute paths, mixed separators and Windows casing return preview-safe relative paths', async () => {
  const { project, previews } = fixture();
  const card = createFileCards({ previews, capture: async () => 'data:image/jpeg;base64,picture' });
  const absolute = path.join(project.path, 'docs', 'guide.md');
  const forms = [absolute, absolute.replace(/\\/g, '/'), 'docs/guide.md', 'docs\\guide.md', './docs/../docs/guide.md'];
  if (process.platform === 'win32') forms.push(absolute.toUpperCase(), absolute.replace(/^([a-z]):/i, (_, drive) => drive.toLowerCase() + ':'), path.toNamespacedPath(absolute));
  for (const file of forms) {
    const relative = (await card(project, file)).path;
    assert.equal(process.platform === 'win32' ? relative.toLowerCase() : relative, 'docs/guide.md', file);
  }
  fs.mkdirSync(path.join(project.path, '..reports'));
  fs.writeFileSync(path.join(project.path, '..reports', 'page.htm'), '<h1>Allowed</h1>');
  assert.equal((await card(project, '..reports/page.htm')).path, '..reports/page.htm');
});

test('relative paths use the agent cwd, including parent steps that stay in the project', async () => {
  const { project, previews } = fixture(), cwd = path.join(project.path, 'docs');
  const card = createFileCards({ previews, capture: async () => 'picture' });
  assert.equal((await card(project, 'guide.md', cwd)).path, 'docs/guide.md');
  assert.equal((await card(project, '../page.html', cwd)).path, 'page.html');
  await assert.rejects(card(project, '../../outside.html', cwd), /文件在项目目录之外/);
});

test('HTML URLs encode special names and serve local styles and scripts under the existing sandbox CSP', async () => {
  const { project } = fixture(), previews = new PreviewResources();
  const file = 'docs/template #中文%.html';
  fs.writeFileSync(path.join(project.path, file), '<link rel="stylesheet" href="style.css"><script src="page.js"></script><h1>Page</h1>');
  fs.writeFileSync(path.join(project.path, 'docs/style.css'), 'body{background:red}');
  fs.writeFileSync(path.join(project.path, 'docs/page.js'), 'document.body.dataset.ready="yes"');
  const card = createFileCards({ previews, capture: async url => {
    assert.equal(new URL(url).hash, '');
    assert.equal(decodeURIComponent(new URL(url).pathname), '/' + file);
    const resource = await previews.resolve(url);
    assert.match(fs.readFileSync(resource.path, 'utf8'), /<h1>Page/);
    assert.match(resource.headers['Content-Security-Policy'], /sandbox allow-scripts allow-same-origin/);
    assert.match((await previews.resolve(new URL('style.css', url))).mimeType, /text\/css/);
    assert.match((await previews.resolve(new URL('page.js', url))).mimeType, /text\/javascript/);
    return 'data:image/jpeg;base64,picture';
  } });
  const result = await card(project, path.join(project.path, file));
  assert.equal(result.path, file); assert.match(result.picture, /^data:image\/jpeg/);
  assert.equal(previews.sessions.size, 0);
  const link = await require('../electron/terminal-links.cjs').resolveTerminalLink(project, result.path);
  assert.deepEqual(link, { kind: 'file', path: file });
  const full = await require('../electron/project-files.cjs').readProjectFile(project, link.path);
  assert.equal(full.kind, 'html');
  const view = previews.open(project, full.path, full.kind);
  assert.match((await previews.resolve(view.url)).mimeType, /text\/html/);
  previews.close(view.previewId);
});

test('a failed or empty capture keeps the opening path and can retry the same file version', async () => {
  for (const failure of ['throw', 'empty', 'open']) {
    const { project, previews, closed } = fixture();
    const originalOpen = previews.open;
    let attempts = 0;
    if (failure === 'open') previews.open = (...args) => { if (!attempts++) throw new Error('server unavailable'); return originalOpen(...args); };
    const card = createFileCards({ previews, capture: async () => {
      if (failure !== 'open' && !attempts++) { if (failure === 'throw') throw new Error('timeout'); return null; }
      return 'picture';
    } });
    assert.deepEqual(await card(project, path.join(project.path, 'page.html')), { kind: 'html', path: 'page.html', picture: null });
    assert.equal((await card(project, 'page.html')).picture, 'picture');
    assert.equal(closed.length, failure === 'open' ? 1 : 2);
  }
});

test('more than 32 queued pages keep their preview URLs alive and capture sequentially', async () => {
  const { project } = fixture(), previews = new PreviewResources();
  let running = 0, most = 0;
  const card = createFileCards({ previews, capture: async url => {
    most = Math.max(most, ++running);
    await new Promise(resolve => setTimeout(resolve, 2));
    await previews.resolve(url); running--; return 'picture';
  } });
  const files = Array.from({ length: 40 }, (_, index) => `page${index}.html`);
  for (const file of files) fs.writeFileSync(path.join(project.path, file), '<h1>Page</h1>');
  const results = await Promise.all(files.map(file => card(project, file)));
  assert.ok(results.every(result => result.picture === 'picture'));
  assert.equal(most, 1); assert.equal(previews.sessions.size, 0);
});

test('outside absolute paths, sibling prefixes and external junctions show a clear project-boundary error', async () => {
  const { project, previews } = fixture();
  const card = createFileCards({ previews, capture: async () => 'picture' });
  const outside = fs.mkdtempSync(project.path + '-outside-');
  fs.writeFileSync(path.join(outside, 'page.html'), '<h1>Outside</h1>');
  fs.symlinkSync(outside, path.join(project.path, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  for (const file of [path.join(outside, 'page.html'), 'linked/page.html', '../outside.html']) await assert.rejects(card(project, file), /文件在项目目录之外/);
});

test('Claude transcripts and Codex rollouts keep the cwd of each written file', async () => {
  const { project, previews } = fixture(), cwd = path.join(project.path, 'docs');
  const card = createFileCards({ previews, capture: async () => 'picture' });
  const claude = new ConversationLog();
  claudeConversation(claude, { type: 'assistant', cwd, message: { content: [{ type: 'tool_use', id: 'write', name: 'Write', input: { file_path: path.join(cwd, 'guide.md') } }] } }, project.path);
  assert.equal((await card(project, claude.list[0].tool.written[0])).path, 'docs/guide.md');
  const codex = new ConversationLog();
  codexConversation(codex, { type: 'session_meta', payload: { cwd: project.path } }, project.path);
  codexConversation(codex, { type: 'turn_context', payload: { cwd } }, project.path);
  codexConversation(codex, { type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: 'patch', input: '*** Update File: guide.md\n' } }, project.path);
  assert.equal((await card(project, codex.list[0].tool.written[0])).path, 'docs/guide.md');
});

test('Codex shell edits honor workdir rather than the session root', async () => {
  const { project, previews } = fixture(), log = new ConversationLog();
  const cmd = 'apply_patch\n*** Update File: guide.md\n';
  const payloads = [
    { type: 'function_call', name: 'exec_command', call_id: 'a', arguments: JSON.stringify({ cmd, workdir: 'docs' }) },
    { type: 'custom_tool_call', call_id: 'b', input: `await tools.exec_command({cmd: ${JSON.stringify(cmd)}, workdir: "docs"});` },
  ];
  for (const payload of payloads) codexConversation(log, { type: 'response_item', payload }, project.path);
  const card = createFileCards({ previews, capture: async () => null });
  for (const entry of log.list) assert.equal((await card(project, entry.tool.written[0])).path, 'docs/guide.md');
});

test('card and name clicks show only resolved paths in the popup, including early clicks and capture failures', async t => {
  const Module = require('node:module'), ts = require('typescript');
  const filename = path.join(__dirname, '../src/features/reading/FileCards.tsx'), mod = new Module(filename, module);
  mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename));
  let states = [], index = 0;
  const opened = [], errors = [], raw = path.join(os.tmpdir(), 'template.html');
  const originalRequire = mod.require.bind(mod);
  mod.require = name => name === 'react' ? { useEffect: () => {}, useRef: () => ({ current: null }), useState: initial => [states[index++] ?? initial, () => {}] }
    : name === '@phosphor-icons/react' ? { FileHtml: () => null, FileText: () => null, FilmStrip: () => null, Image: () => null }
    : name.endsWith('/file-popup') ? { showPopup: target => opened.push(target) }
    : name === './reading-paths' ? { pathTooltip: () => 'Ctrl+click to show in File Explorer' }
    : name.endsWith('/i18n') ? { t: value => value } : name.endsWith('.css') ? {} : originalRequire(name);
  mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, filename);
  const previous = global.window; t.after(() => { global.window = previous; });
  const props = { projectId: 'p', files: [raw], renderMarkdown: text => text, onError: error => errors.push(error) };
  const item = mod.exports.FileCards(props).props.children[0][0];
  for (const loaded of [null, { kind: 'html', path: 'docs/template.html', picture: null }]) {
    global.window = { agentrix: { fileCard: async () => ({ ok: true, value: { kind: 'html', path: 'docs/template.html', picture: null } }) } };
    states = [loaded, false, false]; index = 0;
    const buttons = item.type(item.props).props.children;
    await buttons[0].props.onClick(); await buttons[1].props.onClick();
  }
  assert.deepEqual(opened, Array(4).fill({ kind: 'file', projectId: 'p', path: 'docs/template.html' }));
  global.window.agentrix.fileCard = async () => ({ ok: false, error: '文件在项目目录之外，无法在此预览。' });
  states = []; index = 0;
  await item.type(item.props).props.children[1].props.onClick();
  assert.deepEqual(errors, ['文件在项目目录之外，无法在此预览。']); assert.equal(opened.length, 4);
});

test('an edit step names the files it wrote for the reading view, not those it deleted', () => {
  const step = brief({ kind: 'edit', tool: 'apply_patch', target: 'a、b', detail: '', done: true, failed: false, files: [{ path: 'docs/a.md', change: 'add' }, { path: 'old.html', change: 'delete' }, { path: 'b.html', change: 'update' }] });
  assert.deepEqual(step.written, ['docs/a.md', 'b.html']);
  assert.equal('written' in brief({ kind: 'command', tool: 'shell', target: 'ls', detail: '', done: true, failed: false }), false);
});
