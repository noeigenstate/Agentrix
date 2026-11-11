const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ConversationLog, codexConversation, generatedImage, isGeneratedImage, setThumbnailer } = require('../electron/conversation.cjs');
const { ActionLog } = require('../electron/agent-actions.cjs');

const saved = 'C:\\Users\\me\\.codex\\generated_images\\01a123e3-8a13-7942-bb51-447487989afc\\exec-f90e4bcb-0fdf-4441-aae9-03dfb167f4eb.png';
// The record Codex 0.162 writes when its image_gen tool finishes (result shortened).
const record = { timestamp: '2026-10-10T03:38:31.000Z', type: 'event_msg', payload: { type: 'item_completed', thread_id: 't', turn_id: 'r', item: {
  type: 'Extension', kind: 'image_gen.generation', id: 'exec-f90e4bcb-0fdf-4441-aae9-03dfb167f4eb', status: 'completed',
  revisedPrompt: 'A uniform deep navy background with one pink circular icon.', result: 'iVBORw0KGgo', transparentBackground: false, failure: null, savedPath: saved,
} } };

test('a picture Codex generated shows in its answer as a small copy of the saved file, with its prompt', t => {
  const asked = [];
  const prefix = path.join(os.tmpdir(), 'agentrix-generated-'), directory = fs.mkdtempSync(prefix);
  const file = path.join(directory, 'generated_images', 'thread', 'picture.png');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const header = Buffer.alloc(24); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(header); header.writeUInt32BE(8, 16); header.writeUInt32BE(8, 20); fs.writeFileSync(file, header);
  t.after(() => { assert.ok(path.resolve(directory).startsWith(prefix)); fs.rmSync(directory, { recursive: true, force: true }); });
  setThumbnailer(file => { asked.push(file); return 'data:image/jpeg;base64,THUMB'; });
  t.after(() => setThumbnailer(() => null));
  const log = new ConversationLog();
  codexConversation(log, { ...record, payload: { ...record.payload, item: { ...record.payload.item, savedPath: file } } }, 'C:\\work');
  assert.deepEqual(log.list, [{ id: 'g:exec-f90e4bcb-0fdf-4441-aae9-03dfb167f4eb', at: Date.parse(record.timestamp), role: 'assistant', text: '', images: ['data:image/jpeg;base64,THUMB'],
    generated: { path: file, prompt: 'A uniform deep navy background with one pink circular icon.' } }]);
  assert.deepEqual(asked, [file]);
});

test('without the saved picture no encoded result is retained; failures and unfinished pictures show nothing', () => {
  assert.equal(generatedImage(record.payload.item, 1), null);
  assert.equal(generatedImage({ ...record.payload.item, status: 'failed' }, 1), null);
  assert.equal(generatedImage({ ...record.payload.item, result: 'x'.repeat(3_000_000) }, 1), null, 'a full-size image is never put inline');
});

test('only pictures under a generated_images folder can be shown or opened', () => {
  assert.equal(isGeneratedImage(saved), true);
  assert.equal(isGeneratedImage('/home/me/.codex/generated_images/thread/exec-1.webp'), true);
  assert.equal(isGeneratedImage('C:\\Windows\\System32\\calc.exe'), false);
  assert.equal(isGeneratedImage('C:\\Users\\me\\.codex\\generated_images\\thread\\run.bat'), false);
  assert.equal(isGeneratedImage('generated_images/thread/exec-1.png'), false, 'relative paths are refused');
});

const { projectCopy, remoteImage, createGeneratedImages } = require('../electron/features/generated-images/generated-images.cjs');
const { createEvents, itemPayload } = require('../electron/features/codex-app-server/events.cjs');
const fill = (text, values = {}) => text.replace(/\{(\w+)\}/g, (_, key) => values[key]);
const settleOnce = () => new Promise(resolve => setImmediate(resolve));
function generatedFolder(t) {
  const prefix = path.join(os.tmpdir(), 'agentrix-generated-copy-'), directory = fs.mkdtempSync(prefix);
  t.after(() => { assert.ok(path.resolve(directory).startsWith(prefix)); fs.rmSync(directory, { recursive: true, force: true }); });
  const project = path.join(directory, 'project'), picture = path.join(directory, '.codex', 'generated_images', 'thread', '猪追老鼠.png');
  fs.mkdirSync(project); fs.mkdirSync(path.dirname(picture), { recursive: true }); fs.writeFileSync(picture, 'first picture');
  return { directory, project, picture };
}

test('a generated picture is copied once into the project generated-images, a different one of its name under the next number, nothing replaced', async t => {
  const { directory, project, picture } = generatedFolder(t), folder = path.join(project, 'generated-images');
  assert.equal(await projectCopy(project, picture, false), null);
  assert.equal(fs.existsSync(folder), false, 'looking for a copy writes nothing');
  assert.equal(await projectCopy(project, picture, true), 'generated-images/猪追老鼠.png');
  assert.equal(await projectCopy(project, picture, true), 'generated-images/猪追老鼠.png', 'the same picture is copied once');
  const second = path.join(directory, '.codex', 'generated_images', 'later', '猪追老鼠.png');
  fs.mkdirSync(path.dirname(second)); fs.writeFileSync(second, 'second picture');
  assert.equal(await projectCopy(project, second, false), null);
  assert.equal(await projectCopy(project, second, true), 'generated-images/猪追老鼠-2.png');
  assert.equal(await projectCopy(project, second, false), 'generated-images/猪追老鼠-2.png', 'a resumed conversation finds its numbered copy');
  assert.equal(fs.readFileSync(path.join(folder, '猪追老鼠.png'), 'utf8'), 'first picture');
  assert.deepEqual(fs.readdirSync(folder).sort(), ['猪追老鼠-2.png', '猪追老鼠.png']);
  await assert.rejects(projectCopy(project, path.join(directory, 'other.png'), true), /只能复制 Codex 生成的图片/);
  // A generated-images that links out of the project (a symbolic link or a Windows junction) is never written through.
  const outside = path.join(directory, 'outside');
  fs.mkdirSync(outside); fs.rmSync(folder, { recursive: true }); fs.symlinkSync(outside, folder, 'junction');
  for (const write of [false, true]) await assert.rejects(projectCopy(project, picture, write), /不是普通文件夹/);
  assert.deepEqual(fs.readdirSync(outside), []);
});

function fakeConnection(files, root = '/srv/project') {
  const asked = [];
  return { asked, ready: Promise.resolve(), info: { root }, async request(op, data) {
    asked.push([op, data]);
    if (op === 'generated-copy') return { path: data.write ? 'generated-images/猪追老鼠.png' : null };
    const bytes = files[op === 'generated-image' ? data.path : path.posix.join(root, data.path)];
    if (!bytes) throw new Error('找不到这张图片。');
    if (op === 'generated-image') return { size: bytes.length, data: bytes.subarray(data.offset, data.offset + data.length).toString('base64') };
    if (op === 'stat') return { file: true, size: bytes.length };
    return bytes.subarray(data.offset, data.offset + data.length).toString('base64');
  } };
}

test('an SSH picture is read back in 256 KiB pages: a generated one through the generated-image read, a project one inside the project only, at most 16 MB', async () => {
  const generated = '/home/me/.codex/generated_images/thread/猪追老鼠.png', large = Buffer.alloc(600 * 1024, 7);
  const connection = fakeConnection({ [generated]: large, '/srv/project/docs/a.png': Buffer.from('project picture') });
  assert.deepEqual(await remoteImage(connection, generated), large);
  assert.deepEqual(connection.asked.map(([op, data]) => [op, data.offset, data.length]), [['generated-image', 0, 0], ['generated-image', 0, 262144], ['generated-image', 262144, 262144], ['generated-image', 524288, 90112]]);
  assert.equal((await remoteImage(connection, 'docs/a.png')).toString(), 'project picture');
  assert.equal((await remoteImage(connection, '/srv/project/docs/a.png')).toString(), 'project picture');
  await assert.rejects(remoteImage(connection, '/etc/passwd.png'), /SSH 项目暂不支持预览项目目录外/);
  await assert.rejects(remoteImage(connection, '../other/a.png'), /SSH 项目暂不支持预览项目目录外/);
  await assert.rejects(remoteImage(connection, 'docs/a.txt'), /只能显示图片文件/);
  const huge = fakeConnection({ [generated]: Buffer.alloc(16 * 1024 * 1024 + 1) });
  await assert.rejects(remoteImage(huge, generated), /图片太大/);
  assert.equal(huge.asked.length, 1, 'only its size is asked for a picture over the limit');
});

test('a native picture shows at once, then its read-back and project copy replace it under the same item; history only finds its copy, a closed session gets nothing late', async () => {
  const generated = '/home/me/.codex/generated_images/thread/猪追老鼠.png', connection = fakeConnection({ [generated]: Buffer.from('pixels') });
  const images = createGeneratedImages({ findProject: () => ({ kind: 'ssh', path: '/srv/project' }), remoteFor: () => connection, preview: () => assert.fail('an SSH picture has no local preview'),
    shrinkBytes: bytes => `data:image/png;base64,${bytes.toString('base64')}`, translate: fill });
  const spec = { kind: 'ssh', terminalId: 't' }, published = [];
  const events = createEvents({ projectId: 'p' }, event => published.push(event), Date.now, (item, mode) => images.render(item, spec, mode), value => value, (item, mode) => images.settle(item, spec, mode));
  events.notification('item/completed', { turnId: 'turn', item: { id: 'picture', type: 'imageGeneration', status: 'completed', savedPath: generated, revisedPrompt: 'a pig' } });
  assert.deepEqual(published.at(-1).payload.content, { text: '正在取回图片…', generated: { path: generated, prompt: 'a pig', copyNote: '正在复制到项目…' }, images: [] });
  await settleOnce();
  const settled = published.at(-1);
  assert.equal(settled.itemId, 'picture'); assert.equal(settled.turnId, 'turn');
  assert.deepEqual(settled.payload.content, { text: '', generated: { path: generated, prompt: 'a pig', copied: 'generated-images/猪追老鼠.png' }, images: [`data:image/png;base64,${Buffer.from('pixels').toString('base64')}`] });
  assert.deepEqual(connection.asked.filter(([op]) => op === 'generated-copy').map(([, data]) => data.write), [true]);
  assert.deepEqual(events.snapshot().items.find(item => item.itemId === 'picture').content.generated.copied, 'generated-images/猪追老鼠.png', 'a reattached view sees the settled picture');

  connection.asked.length = 0;
  const replayed = [];
  const history = createEvents({ projectId: 'p' }, event => replayed.push(event), Date.now, (item, mode) => images.render(item, spec, mode), value => value, (item, mode) => images.settle(item, spec, mode));
  history.publish('item.upsert', itemPayload({ id: 'old', type: 'imageGeneration', status: 'completed', savedPath: generated, revisedPrompt: 'a pig' }, true, item => images.render(item, spec, 'history')), { itemId: 'old', replay: true });
  history.settle('old', 'history');
  await settleOnce();
  assert.equal(replayed.at(-1).replay, true);
  assert.deepEqual(connection.asked.filter(([op]) => op === 'generated-copy').map(([, data]) => data.write), [false], 'history only looks for its copy');
  assert.deepEqual(replayed.at(-1).payload.content.generated, { path: generated, prompt: 'a pig' }, 'and names none it did not find');

  let release;
  const late = createEvents({}, event => published.push(event), Date.now, () => ({}), value => value, () => new Promise(resolve => { release = resolve; }).then(() => null));
  late.notification('item/completed', { item: { id: 'late', type: 'imageGeneration', status: 'completed', savedPath: generated } });
  const count = published.length; await settleOnce(); release(); await settleOnce();
  assert.equal(published.length, count, 'a session closed meanwhile (settle gives null) publishes nothing more');
});

test('a copy that fails says why under the picture; a local picture keeps its preview and gains its copy', async t => {
  const { project, picture } = generatedFolder(t), spec = { kind: 'local', terminalId: 't' };
  const local = createGeneratedImages({ findProject: () => ({ kind: 'local', path: project }), remoteFor: () => assert.fail('a local picture is not read over SSH'),
    preview: () => ({ images: ['project-preview://picture'] }), shrinkBytes: () => assert.fail(), translate: fill });
  assert.deepEqual(local.render({ savedPath: picture }, spec, 'live'), { images: ['project-preview://picture'], copy: { copyNote: '正在复制到项目…' } });
  assert.deepEqual(local.render({ savedPath: picture }, spec, 'history'), { images: ['project-preview://picture'], copy: {} });
  assert.deepEqual(await local.settle({ savedPath: picture }, spec, 'live'), { copy: { copied: 'generated-images/猪追老鼠.png' } });
  fs.writeFileSync(path.join(project, 'blocked'), '');
  const blocked = createGeneratedImages({ findProject: () => ({ kind: 'local', path: path.join(project, 'blocked') }), remoteFor() {}, preview() {}, shrinkBytes() {}, translate: fill });
  assert.match((await blocked.settle({ savedPath: picture }, spec, 'live')).copy.copyNote, /^未能复制到项目：/);
  assert.deepEqual(await blocked.settle({ savedPath: picture }, spec, 'history'), { copy: {} }, 'history says nothing about a copy it could not find');
  const offline = createGeneratedImages({ findProject: () => ({ kind: 'ssh' }), remoteFor: () => { throw new Error('请先启动终端，连接 SSH 服务器。'); }, preview() {}, shrinkBytes() {}, translate: fill });
  assert.deepEqual(await offline.settle({ savedPath: '/home/me/.codex/generated_images/t/a.png' }, { kind: 'ssh', terminalId: 't' }, 'live'),
    { note: '图片未能从远程读回：请先启动终端，连接 SSH 服务器。', copy: { copyNote: '未能复制到项目：请先启动终端，连接 SSH 服务器。' } });
});

test('the picture popup reads an SSH project picture back over its connection, and a local reply picture by a name from the project folder', async t => {
  const { project, picture } = generatedFolder(t), { registerImageIpc } = require('../electron/app/images.cjs');
  const handlers = {}, remote = [], image = source => ({ isEmpty: () => false, getSize: () => ({ width: 10, height: 5 }), toDataURL: () => source });
  registerImageIpc({ handle: (name, handler) => { handlers[name] = handler; }, app: {}, findProject: id => id === 'ssh' ? { kind: 'ssh' } : { kind: 'local', path: project },
    getSession() {}, clipboard: {}, isGeneratedImage, nativeImage: { createFromBuffer: bytes => image(`buffer:${bytes}`), createFromPath: file => image(`path:${file}`) },
    remoteImage: async (id, file) => { remote.push([id, file]); return Buffer.from('bytes'); } });
  assert.deepEqual(await handlers['agent:image']('docs/a.png', 'ssh'), { url: 'buffer:bytes', width: 10, height: 5 });
  assert.deepEqual(remote, [['ssh', 'docs/a.png']]);
  fs.mkdirSync(path.join(project, 'docs')); fs.writeFileSync(path.join(project, 'docs', 'a.png'), 'x');
  assert.equal((await handlers['agent:image']('docs/a.png', 'local')).url, `path:${path.join(project, 'docs', 'a.png')}`);
  await assert.rejects(handlers['agent:image']('docs/a.txt', 'local'), /只能显示图片文件/);
  assert.equal((await handlers['agent:image'](picture)).url, `path:${picture}`, 'a generated picture needs no project');
  assert.equal(remote.length, 1, 'a local project is never read over SSH');
});

const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { createCodexRuntime } = require('../electron/features/codex-app-server/index.cjs');
const { rawPicture } = require('../electron/features/generated-images/generated-images.cjs');

// An app-server peer whose resumed thread holds one turn of the given items; nothing else is answered but the handshake.
function picturePeer(cwd, items) {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = null;
  child.kill = () => { child.exitCode = 0; child.emit('exit', 0); child.emit('close', 0); };
  const send = message => child.stdout.write(JSON.stringify(message) + '\n');
  const thread = id => ({ thread: { id, turns: [], cwd, status: { type: 'idle' } }, cwd, model: 'gpt-6.1-sol', reasoningEffort: 'high', serviceTier: 'default', sandbox: { type: 'readOnly' } });
  child.stdin = new Writable({ write(bytes, _encoding, done) {
    for (const line of bytes.toString().trim().split('\n')) {
      const request = JSON.parse(line); if (request.id == null) continue;
      // The capability probe names no thread, and is refused as the real server refuses it.
      if (['thread/resume', 'turn/start', 'turn/steer', 'turn/interrupt'].includes(request.method) && !request.params?.threadId) { queueMicrotask(() => send({ id: request.id, error: { code: -32602, message: 'missing threadId' } })); continue; }
      queueMicrotask(() => send({ id: request.id, result: request.method === 'initialize' ? { userAgent: 'codex/0.166.0' }
        : request.method === 'thread/start' ? thread('fresh-thread') : request.method === 'thread/resume' ? thread(request.params.threadId)
          : request.method === 'thread/turns/list' ? { data: [{ id: 'turn', status: 'completed', items }], nextCursor: null } : {} }));
    }
    done();
  } });
  return child;
}

// The remote worker as the connection sees it: four threads taking requests in order, each picture request a while.
function busyWorker(root) {
  const asked = [], waiting = [];
  let busy = 0, pictures = 0, mostPictures = 0, mostPending = 0, inputWaited = null;
  const run = async (op, data) => {
    const picture = op.startsWith('generated-');
    if (picture) { pictures++; mostPictures = Math.max(mostPictures, pictures); }
    if (op === 'codex-input') inputWaited = busy >= 4;
    if (busy >= 4) await new Promise(resolve => waiting.push(resolve));
    busy++;
    try {
      await new Promise(resolve => setTimeout(resolve, picture ? 15 : 1));
      asked.push([op, data]);
      if (op === 'generated-copy') return { path: null };
      if (op === 'generated-image') return { size: 4, data: data.length ? Buffer.from('pixels'.slice(data.offset, data.offset + data.length)).toString('base64') : '' };
      return { ok: true };
    } finally { busy--; if (picture) pictures--; waiting.shift()?.(); }
  };
  return { asked, ready: Promise.resolve(), info: { root }, stats: () => ({ mostPictures, mostPending, inputWaited }),
    request(op, data) { mostPending = Math.max(mostPending, busy + waiting.length + 1); return run(op, data); } };
}

test('a resumed SSH conversation with 40 pictures keeps at most two picture requests in flight, reads back only its six newest and leaves codex-input prompt', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-pictures-')), published = [];
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const saved = index => `/home/me/.codex/generated_images/thread/p${index}.png`;
  const items = Array.from({ length: 40 }, (_, index) => ({ id: `p${index}`, type: 'imageGeneration', status: 'completed', savedPath: saved(index), revisedPrompt: `picture ${index}` }));
  const worker = busyWorker('/srv/project');
  const images = createGeneratedImages({ findProject: () => ({ kind: 'ssh', path: '/srv/project' }), remoteFor: () => worker, preview: () => assert.fail('no local preview'),
    shrinkBytes: bytes => `data:image/png;base64,${bytes.toString('base64')}`, translate: fill });
  const ssh = spec => ({ ...spec, kind: 'ssh' });
  const session = createCodexRuntime({ resolveExecutable: async () => 'fake-only', spawnProcess: () => picturePeer(root, items),
    renderImage: (item, spec, mode) => images.render(item, ssh(spec), mode), settleImage: (item, spec, mode) => images.settle(item, ssh(spec), mode) })
    .create({ terminalId: 't', projectId: 'p', owner: 'gui', cwd: root, env: { CODEX_HOME: root, PATH: '' } }, event => published.push(event));
  t.after(() => session.close());
  await session.resume({ providerSessionId: 'old-thread' });
  await worker.request('codex-input', { data: 'aGk=' });
  assert.equal(worker.stats().inputWaited, false, 'the session input finds a free worker thread while the pictures load');
  for (let n = 0; n < 400 && worker.asked.filter(([op]) => op === 'generated-copy').length < 40; n++) await new Promise(resolve => setTimeout(resolve, 10));
  await settleOnce();
  assert.equal(worker.stats().mostPictures, 2, 'two picture jobs at a time on the connection');
  assert.ok(worker.stats().mostPending <= 4, 'far below the connection\'s 64 pending requests');
  assert.deepEqual(worker.asked.filter(([op]) => op === 'generated-copy').map(([, data]) => data.write), Array(40).fill(false), 'history only looks for copies');
  assert.deepEqual([...new Set(worker.asked.filter(([op]) => op === 'generated-image').map(([, data]) => data.path))].sort(), [34, 35, 36, 37, 38, 39].map(saved).sort(), 'only the six newest are read back');
  const content = id => session.snapshot().items.find(item => item.itemId === id).content;
  assert.deepEqual(content('p39').images, [`data:image/png;base64,${Buffer.from('pixe').toString('base64')}`]);
  assert.deepEqual([content('p0').text, content('p0').generated.deferred, content('p0').images], ['点击加载图片', true, []], 'an older picture waits for the reader');
});

test('a local copy refused by the file system says its kind, never the path, and removes only what it created', async t => {
  const { project, picture } = generatedFolder(t), spec = { kind: 'local', terminalId: 't' };
  const local = createGeneratedImages({ findProject: () => ({ kind: 'local', path: project }), remoteFor() {}, preview: () => ({ images: [] }), shrinkBytes() {}, translate: fill });
  for (const [code, words] of [['EACCES', '没有写入项目文件夹的权限。'], ['EROFS', '项目所在的磁盘是只读的。'], ['ENOSPC', '磁盘空间不足。'], ['EIO', '复制到项目失败（EIO）。']]) {
    const open = t.mock.method(fs.promises, 'open', async target => { throw Object.assign(new Error(`${code}: refused, open '${target}'`), { code, syscall: 'open', path: target }); });
    assert.deepEqual(await local.settle({ savedPath: picture }, spec, 'live'), { copy: { copyNote: `未能复制到项目：${words}` } });
    open.mock.restore();
  }
  assert.deepEqual(fs.readdirSync(path.join(project, 'generated-images')), [], 'nothing was left behind');
  fs.writeFileSync(path.join(project, 'generated-images', '猪追老鼠.png'), 'the owner\'s own file');
  assert.equal(await projectCopy(project, picture, true), 'generated-images/猪追老鼠-2.png');
  assert.equal(fs.readFileSync(path.join(project, 'generated-images', '猪追老鼠.png'), 'utf8'), 'the owner\'s own file');
  const huge = path.join(path.dirname(picture), 'huge.png');
  fs.writeFileSync(huge, Buffer.alloc(16 * 1024 * 1024 + 1));
  await assert.rejects(projectCopy(project, huge, true), /图片太大，不复制到项目/);
});

test('the reading view knows a generated picture by the main process rule', () => {
  const { isGeneratedPicture } = require('../src/features/reading/reply-links.ts');
  for (const file of [saved, '/home/me/.codex/generated_images/thread/exec-1.webp', 'C:/Users/me/.codex/generated_images/t/a.JPG', '\\Users\\me\\generated_images\\t\\a.png',
    '\\\\server\\share\\generated_images\\t\\a.png', '//server/share/generated_images/t/a.png', 'file:///C:/x/generated_images/t/a.png', 'generated_images/t/a.png',
    'C:generated_images\\t\\a.png', 'C:\\Users\\me\\.codex\\generated_images\\thread\\run.bat', '/x/generated_images/a.png']) {
    assert.equal(isGeneratedPicture(file), isGeneratedImage(file), file);
  }
});

test('a WebP picture this computer cannot decode is shown from its own bytes, within the limit', () => {
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]);
  assert.equal(rawPicture(webp), `data:image/webp;base64,${webp.toString('base64')}`);
  assert.equal(rawPicture(webp, 4), null, 'larger than the limit');
  assert.equal(rawPicture(Buffer.from('\x89PNG\r\n\x1a\n')), null, 'only WebP');
});
