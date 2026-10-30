const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { ConversationLog, codexConversation, claudeConversation, setThumbnailer } = require('../electron/conversation.cjs');
const { ClaudeImageLine, IMAGE_LIMIT, IMAGE_OMITTED, readTranscriptChunk } = require('../electron/oversized-record.cjs');

const missing = 'agentrix-image:unavailable', small = 'data:image/jpeg;base64,SMALL';
const at = '2026-10-30T08:00:00.000Z';
const item = (content, id = 'message') => ({ timestamp: at, type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', id, content } } });
const response = content => ({ timestamp: at, type: 'response_item', payload: { type: 'message', role: 'user', content } });
const inline = data => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data } });
function fixture(t) {
  const prefix = path.join(os.tmpdir(), 'agentrix-message-images-'), directory = fs.mkdtempSync(prefix);
  t.after(() => { setThumbnailer(() => null); assert.ok(path.resolve(directory).startsWith(prefix)); fs.rmSync(directory, { recursive: true, force: true }); });
  const file = path.join(directory, 'pasted 中文 #1.png');
  fs.writeFileSync(file, 'synthetic pixels');
  return { directory, file };
}

test('Codex local_image messages show bounded thumbnails, including messages with no text', t => {
  const { file } = fixture(t), reads = [];
  setThumbnailer(value => { reads.push(value); return small; });
  for (const content of [[{ type: 'text', text: 'Look at this' }, { type: 'local_image', path: file }], [{ type: 'local_image', path: file }]]) {
    const log = new ConversationLog();
    codexConversation(log, item(content));
    assert.equal(log.list.length, 1);
    assert.deepEqual(log.list[0].images, [small]);
    assert.equal(log.list[0].text, content.length === 1 ? '' : 'Look at this');
    assert.ok(!JSON.stringify(log.list[0].images).includes(file), 'file paths are never passed as image sources');
  }
  assert.deepEqual(reads, [file, file]);
});

test('older Codex events and input_image response items retain inline and local attachments', t => {
  const { file } = fixture(t);
  setThumbnailer(() => small, () => small);
  const records = [
    { timestamp: at, type: 'event_msg', payload: { type: 'user_message', message: 'Look', images: ['data:image/png;base64,INLINE'], local_images: [file] } },
    { timestamp: at, type: 'event_msg', payload: { type: 'user_message', local_images: [{ path: file }] } },
    response([{ type: 'input_image', image_url: pathToFileURL(file).href }]),
    response([{ type: 'input_text', text: 'Look' }, { type: 'input_image', image_url: { url: 'data:image/png;base64,INLINE' } }]),
  ];
  for (const [index, record] of records.entries()) {
    const log = new ConversationLog();
    codexConversation(log, record);
    assert.equal(log.list.length, 1, String(index));
    assert.deepEqual(log.list[0].images, index === 0 ? [small, small] : [small]);
  }
});

test('missing, unreadable and oversized local images leave ordered tiles without retaining pixels', t => {
  const { directory, file } = fixture(t), large = path.join(directory, 'large.png');
  fs.writeFileSync(large, ''); fs.truncateSync(large, 64 * 1024 * 1024 + 1);
  const reads = [];
  setThumbnailer(value => { reads.push(value); if (value === file) throw new Error('decode failed'); return small; });
  const log = new ConversationLog();
  codexConversation(log, item([file, path.join(directory, 'gone.png'), large, 'https://example.test/a.png'].map(value => ({ type: 'local_image', path: value }))));
  assert.deepEqual(log.list[0].images, [missing, missing, IMAGE_OMITTED, missing]);
  assert.deepEqual(reads, [file], 'large or missing files never reach the image decoder');
});

test('four-image and thumbnail-size limits include placeholders', t => {
  const { file } = fixture(t);
  let reads = 0;
  setThumbnailer(() => { reads++; return 'data:image/png;base64,' + 'A'.repeat(IMAGE_LIMIT + 128); });
  const log = new ConversationLog();
  codexConversation(log, item(Array.from({ length: 8 }, () => ({ type: 'local_image', path: file }))));
  assert.deepEqual(log.list[0].images, Array(4).fill(IMAGE_OMITTED));
  assert.equal(reads, 4);
});

test('Claude large and missing image data leave placeholders, and image-only prompts survive', () => {
  const log = new ConversationLog();
  claudeConversation(log, { type: 'user', uuid: 'images', timestamp: at, message: { content: [inline('A'.repeat(IMAGE_LIMIT + 1)), inline(null), inline('SMALL')] } });
  assert.equal(log.list[0].text, '');
  assert.deepEqual(log.list[0].images, [IMAGE_OMITTED, missing, 'data:image/png;base64,SMALL']);
});

test('Claude oversized parsing retains only a marker for discarded pixels across arbitrary chunk boundaries', () => {
  const pixels = 'A'.repeat(IMAGE_LIMIT + 1);
  const record = { type: 'user', uuid: 'large', timestamp: at, message: { content: [inline(pixels)] } };
  const bytes = Buffer.from(JSON.stringify(record)), line = new ClaudeImageLine(Buffer.alloc(0));
  for (let offset = 0; offset < bytes.length; offset += 65537) {
    line.add(bytes.subarray(offset, offset + 65537));
    assert.ok((line.data || []).reduce((size, part) => size + part.length, 0) <= IMAGE_LIMIT);
  }
  const parsed = line.record();
  assert.equal(parsed.message.content[0].source.data, IMAGE_OMITTED);
  assert.ok(JSON.stringify(parsed).length < 512);
  const log = new ConversationLog(); claudeConversation(log, parsed);
  assert.deepEqual(log.list[0].images, [IMAGE_OMITTED]);
});

test('large Codex input_image and images records survive the real oversized-line reader with bounded pixels', t => {
  fixture(t); setThumbnailer(() => null, () => small);
  for (const size of [1_200_000, IMAGE_LIMIT + 1]) {
    const url = 'data:image/png;base64,' + 'A'.repeat(size);
    const records = [
      response([{ type: 'input_text', text: 'Look' }, { type: 'input_image', image_url: url }]),
      { timestamp: at, type: 'event_msg', payload: { type: 'user_message', message: 'Look', images: [url, url] } },
      item([{ type: 'text', text: 'Look' }, inline('A'.repeat(size))]),
    ];
    for (const record of records) for (const chunkSize of [65537, 16 * 1024 * 1024]) {
      const reader = { buffer: Buffer.alloc(0) }, log = new ConversationLog(), bytes = Buffer.from(JSON.stringify(record) + '\n');
      for (let offset = 0; offset < bytes.length; offset += chunkSize) readTranscriptChunk(reader, bytes.subarray(offset, offset + chunkSize), value => codexConversation(log, value));
      assert.equal(log.list.length, 1);
      assert.equal(log.list[0].text, 'Look');
      assert.deepEqual(log.list[0].images, Array(record.payload.images ? 2 : 1).fill(size > IMAGE_LIMIT ? IMAGE_OMITTED : small));
      assert.equal(reader.oversized, null); assert.equal(reader.buffer.length, 0);
    }
  }
});

test('mirrored Codex user records enrich one message while repeated sends remain separate', t => {
  const { file } = fixture(t);
  setThumbnailer(() => small);
  const log = new ConversationLog(), event = { timestamp: at, type: 'event_msg', payload: { type: 'user_message', message: 'Look' } };
  codexConversation(log, event);
  const id = log.list[0].id;
  codexConversation(log, response([{ type: 'input_text', text: 'Look' }, { type: 'local_image', path: file }]));
  assert.equal(log.list.length, 1); assert.equal(log.list[0].id, id); assert.deepEqual(log.list[0].images, [small]);
  codexConversation(log, { type: 'turn_context', payload: { cwd: path.dirname(file) } });
  codexConversation(log, { ...event, timestamp: '2026-10-30T08:00:01.000Z' });
  assert.equal(log.list.length, 2, 'the same words in a later turn remain another prompt');
  codexConversation(log, { ...event, timestamp: '2026-10-30T08:00:02.000Z' });
  assert.equal(log.list.length, 3, 'the same source cannot acknowledge another user send');
});

test('text-only response mirrors add no user message, and image mirrors never discard additional pictures', () => {
  const log = new ConversationLog();
  codexConversation(log, { timestamp: at, type: 'event_msg', payload: { type: 'user_message', message: 'Look' } });
  codexConversation(log, response([{ type: 'input_text', text: 'Look' }]));
  assert.equal(log.list.length, 1);
  const pictures = new ConversationLog(), text = { type: 'input_text', text: 'Look' };
  codexConversation(pictures, item([text, inline('FIRST'), inline('SECOND')]));
  codexConversation(pictures, response([text, inline('FIRST')]));
  assert.equal(pictures.list.length, 1);
  assert.deepEqual(pictures.list[0].images, ['data:image/png;base64,FIRST', 'data:image/png;base64,SECOND']);
});

test('different pictures accompanying the same words are not mistaken for duplicate records', () => {
  const log = new ConversationLog(), text = { type: 'input_text', text: 'Look' };
  codexConversation(log, item([text, inline('FIRST')]));
  codexConversation(log, response([text, inline('SECOND')]));
  assert.equal(log.list.length, 2);
});

test('the paste cache removes recorded paths without duplicating thumbnails or exceeding four pictures', () => {
  const Module = require('node:module'), ts = require('typescript');
  const filename = path.join(__dirname, '../src/features/reading/pasted-pictures.ts'), mod = new Module(filename, module);
  mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename));
  mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, filename);
  mod.exports.rememberPicture('/remote/pasted.png', small);
  assert.deepEqual(mod.exports.withPictures('Look /remote/pasted.png', [small]), { text: 'Look', images: [small] });
  assert.deepEqual(mod.exports.withPictures('/remote/pasted.png', Array(4).fill('data:image/png;base64,OTHER')), { text: '', images: Array(4).fill('data:image/png;base64,OTHER') });
});

test('image support never turns system, sidechain or tool records into user prompts', t => {
  const { file } = fixture(t), log = new ConversationLog();
  let reads = 0; setThumbnailer(() => { reads++; return small; });
  for (const metadata of [{ isMeta: true }, { isSidechain: true }, { origin: { kind: 'system' } }]) {
    const record = item([{ type: 'local_image', path: file }]);
    Object.assign(record.payload.item, metadata); codexConversation(log, record);
  }
  codexConversation(log, response([{ type: 'input_text', text: '# AGENTS.md instructions for a project' }, { type: 'local_image', path: file }]));
  assert.deepEqual(log.list, []); assert.equal(reads, 0);
});

test('image placeholders have readable labels and cannot open broken image popups', () => {
  const Module = require('node:module'), ts = require('typescript'), React = require('react');
  const { renderToStaticMarkup } = require('react-dom/server');
  const filename = path.join(__dirname, '../src/features/reading/PendingPromptEntries.tsx'), mod = new Module(filename, module), opened = [];
  mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename));
  const originalRequire = mod.require.bind(mod);
  mod.require = name => name === '@phosphor-icons/react' ? { Image: () => null, X: () => null }
    : name === './Timeline' || name === './pasted-pictures' || name.endsWith('/UserAvatar') || name.endsWith('.css') ? {}
    : name.endsWith('/file-popup') ? { showPopup: target => opened.push(target) }
    : name.endsWith('/i18n') ? { t: (text, values) => text.replace(/\{(\w+)\}/g, (_, key) => values[key]) } : originalRequire(name);
  mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, filename);
  const images = [IMAGE_OMITTED, missing, small], element = mod.exports.UserImages({ images });
  const html = renderToStaticMarkup(React.createElement(mod.exports.UserImages, { images }));
  assert.match(html, /图片较大，未在此显示/); assert.match(html, /图片文件已不存在或无法读取/);
  assert.equal((html.match(/disabled=""/g) || []).length, 2);
  assert.equal((html.match(/<img /g) || []).length, 1);
  assert.ok(!html.includes('src="agentrix-image:'));
  for (const child of element.props.children) child.props.children[0].props.onClick();
  assert.equal(opened.length, 1); assert.equal(opened[0].src, small);
});
