const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { createRpc } = require('../electron/features/codex-app-server/rpc.cjs');

function fixture() {
  const child = new EventEmitter(), notices = [], drops = [], disconnected = [];
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.stdin = new Writable({ write(_chunk, _encoding, done) { done(); } });
  const rpc = createRpc(child, { timeout: 10000, onNotification: (...args) => notices.push(args),
    onDropped: bytes => drops.push(bytes), onDisconnect: reason => disconnected.push(reason) });
  return { child, rpc, notices, drops, disconnected };
}

test('5 MiB generated image drops pixels before callbacks and snapshots without disconnect', () => {
  const f = fixture();
  try {
    f.child.stdout.write(JSON.stringify({ method: 'item/completed', params: { item: { id: 'picture', type: 'imageGeneration',
      result: 'X'.repeat(5 * 1024 * 1024), savedPath: '/project/picture.png', revisedPrompt: 'A picture' } } }) + '\n');
    assert.deepEqual(f.disconnected, []);
    assert.equal(f.notices.length, 1);
    assert.equal(f.notices[0][1].item.savedPath, '/project/picture.png');
    assert.equal(Object.hasOwn(f.notices[0][1].item, 'result'), false);
  } finally { f.rpc.close(); }
});

test('70 MiB notification and late-id response drain one frame, reject one request and keep working', async () => {
  const f = fixture();
  try {
    const oversized = assert.rejects(f.rpc.request('thread/resume', {}), error => error.code === 'frame_limit');
    const other = f.rpc.request('account/read', {});
    f.child.stdout.write('{"result":{"text":"');
    for (let i = 0; i < 70; i++) f.child.stdout.write(Buffer.alloc(1024 * 1024, 120));
    f.child.stdout.write('"},"id":"1"}\n');
    f.child.stdout.write('{"method":"notice","params":{"text":"');
    for (let i = 0; i < 70; i++) f.child.stdout.write(Buffer.alloc(1024 * 1024, 120));
    f.child.stdout.write('"}}\n{"id":"2","result":{"ok":true}}\n{"method":"alive","params":{}}\n');
    await oversized; assert.deepEqual(await other, { ok: true });
    assert.deepEqual(f.disconnected, []); assert.equal(f.drops.length, 2);
    assert.ok(f.drops.every(bytes => bytes > 70 * 1024 * 1024)); assert.equal(f.notices.at(-1)[0], 'alive');
  } finally { f.rpc.close(); }
});

test('thread/resume accepts a response above 4 MiB without changing thread or transport', async () => {
  const f = fixture();
  try {
    const response = f.rpc.request('thread/resume', {});
    f.child.stdout.write(JSON.stringify({ id: '1', result: { thread: { id: 'same-thread', title: 'x'.repeat(5 * 1024 * 1024) } } }) + '\n');
    assert.equal((await response).thread.id, 'same-thread'); assert.deepEqual(f.disconnected, []);
  } finally { f.rpc.close(); }
});

test('generated image cards serve only the saved file and never retain encoded pixels', async t => {
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r13-picture-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const folder = path.join(root, 'generated_images', 'one'); fs.mkdirSync(folder, { recursive: true });
  const savedPath = path.join(folder, 'picture.png'); fs.writeFileSync(savedPath, Buffer.from('89504e470d0a1a0a', 'hex'));
  const { PreviewResources } = require('../electron/preview-resources.cjs'), previewResources = new PreviewResources();
  const source = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
  const render = vm.runInNewContext(source.slice(source.indexOf('function generatedPreview('), source.indexOf('const { thumbnail, small,')) + '\ngeneratedPreview;',
    { fs, path, previewResources, isGeneratedImage: require('../electron/generated-image-path.cjs').isGeneratedImage });
  const f = fixture(), spec = { agent: 'codex', projectId: 'p', terminalId: 't', runtimeSessionId: 'r', cwd: root };
  const { createEventStream } = require('../electron/features/native-session/events.cjs');
  const stream = createEventStream(spec, () => {});
  const events = require('../electron/features/codex-app-server/events.cjs').createEvents(spec,
    event => stream.publish(event.type, event.payload, { itemId: event.itemId }), Date.now, item => render(item, spec));
  try {
    f.child.stdout.write(JSON.stringify({ method: 'item/completed', params: { item: { id: 'image', type: 'imageGeneration',
      status: 'completed', result: 'X'.repeat(5 * 1024 * 1024), savedPath, revisedPrompt: 'Offline picture' } } }) + '\n');
    events.notification(...f.notices[0]);
    const snapshot = stream.snapshot(), card = snapshot.events.find(event => event.itemId === 'image');
    assert.equal(card.payload.content.generated.path, savedPath);
    const url = card.payload.content.images[0]; assert.match(url, /^project-preview:/);
    assert.doesNotMatch(JSON.stringify(snapshot), /data:image|XXXXX|"result"/);
    await previewResources.resolve(url);
    await assert.rejects(previewResources.resolve(url.replace('picture.png', 'other.png')));
    for (let index = 0; index < 40; index++) previewResources.open({ id: 'other', path: root }, 'other.png', 'image');
    assert.equal(previewResources.hasUrl(url), true, 'file previews cannot evict conversation images');
    previewResources.closeProject('p'); assert.equal(previewResources.hasUrl(url), false);
  } finally { f.rpc.close(); }
});

test('control requests and responses above 4 MiB work, and an oversized write does not close the channel', async t => {
  const { createDispatchControl, connectDispatchControl } = require('../electron/features/agents/dispatch-control.cjs');
  const runId = 'large-control', control = createDispatchControl({ resolveRun: () => ({ runId, projectId: 'p', cwd: require('node:os').tmpdir(), allow: [] }) });
  const { address } = await control.listen(); t.after(() => control.close());
  control.onRequest('echo', (_run, payload) => payload);
  const client = await connectDispatchControl({ address, runId, projectId: 'p' }); t.after(() => client.close());
  assert.equal((await client.request('echo', { text: 'x'.repeat(5 * 1024 * 1024) })).text.length, 5 * 1024 * 1024);
  await assert.rejects(client.request('echo', { text: 'x'.repeat(65 * 1024 * 1024) }), /control_frame_limit/);
  assert.deepEqual(await client.request('echo', { after: true }), { after: true }); assert.equal(client.connected, true);
});
