const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { PreviewResources } = require('../electron/preview-resources.cjs');
const { previewLocation, folderGrantAllowed } = require('../electron/features/files/preview-location.cjs');
const { createFileCards } = require('../electron/features/files/file-cards.cjs');
const { createPageCapture } = require('../electron/features/files/capture-page.cjs');

async function fixture(t) {
  const prefix = path.join(os.tmpdir(), 'agentrix-preview-security-'), root = await fs.mkdtemp(prefix);
  t.after(async () => { assert.ok(path.resolve(root).startsWith(prefix)); await fs.rm(root, { recursive: true, force: true }); });
  const home = path.join(root, 'home'), project = { id: 'p', kind: 'local', path: path.join(root, 'project') };
  await fs.mkdir(home); await fs.mkdir(project.path);
  return { root, home, project };
}

test('outside grants at home, filesystem roots, ancestors and open-project ancestors serve only the selected file', async t => {
  const { root, home, project } = await fixture(t);
  t.mock.method(os, 'homedir', () => home);
  await fs.mkdir(path.join(home, 'AppData', 'Roaming', 'gcloud'), { recursive: true });
  await fs.writeFile(path.join(home, 'AppData', 'Roaming', 'gcloud', 'application_default_credentials.json'), '{"synthetic":true}');
  const other = { id: 'other', path: path.join(home, 'another-project') }; await fs.mkdir(other.path);
  await fs.writeFile(path.join(other.path, 'secret.json'), '{}');
  for (const folder of [home, root]) {
    const file = path.join(folder, 'page.html'); await fs.writeFile(file, '<h1>selected</h1>');
    const resources = new PreviewResources(), location = await previewLocation(project, file);
    const view = resources.open(location.project, location.relative, 'html');
    assert.equal(location.project.previewSingleFile, true);
    assert.match((await resources.resolve(view.url)).mimeType, /html/);
    for (const candidate of ['AppData/Roaming/gcloud/application_default_credentials.json', 'another-project/secret.json', 'home/page.html']) await assert.rejects(resources.resolve(new URL(candidate, view.url).href));
  }
  assert.equal(await folderGrantAllowed(path.parse(root).root, [], home), false);
  const output = path.join(root, 'output'); await fs.mkdir(output);
  const nestedProject = { path: path.join(output, 'nested', 'project') }; await fs.mkdir(nestedProject.path, { recursive: true });
  const file = path.join(output, 'page.html'); await fs.writeFile(file, 'page'); await fs.writeFile(path.join(output, 'data.json'), '{}');
  let projects = [];
  const resources = new PreviewResources({ getProjects: () => projects });
  const location = await previewLocation(project, file, project.path, resources.getProjects());
  const view = resources.open(location.project, location.relative, 'html');
  assert.match((await resources.resolve(new URL('data.json', view.url).href)).mimeType, /json/);
  projects = [nestedProject];
  await assert.rejects(resources.resolve(new URL('data.json', view.url).href), /selected file/);
  const restricted = await previewLocation(project, file, project.path, resources.getProjects());
  assert.equal(restricted.project.previewSingleFile, true);
});

test('UNC and extended UNC previews are rejected before filesystem operations', async t => {
  const project = { id: 'p', path: path.resolve('synthetic-project') }, resources = new PreviewResources();
  const card = createFileCards({ previews: resources, capture: async () => null });
  let calls = 0;
  for (const api of ['realpath', 'stat', 'open']) t.mock.method(fs, api, async () => { calls++; throw new Error('filesystem must not be called'); });
  for (const file of ['\\\\host\\share\\page.html', '\\\\?\\UNC\\host\\share\\page.html', '//host/share/page.html', '\\\\host\\share\\image.png', '\\\\host\\share\\note.md']) {
    await assert.rejects(card(project, file), { code: 'NETWORK_PATH' });
  }
  assert.equal(calls, 0);
});

test('outside previews have offline CSP and popup navigation cannot escape the local preview', async t => {
  const { root, project } = await fixture(t), output = path.join(root, 'output'); await fs.mkdir(output);
  const file = path.join(output, 'page.html'); await fs.writeFile(file, '<script>fetch("https://example.invalid")</script>');
  const resources = new PreviewResources(), location = await previewLocation(project, file);
  const view = resources.open(location.project, location.relative, 'html'), csp = (await resources.resolve(view.url)).headers['Content-Security-Policy'];
  assert.ok(!csp.includes('https:')); assert.match(csp, /connect-src 'self';/); assert.match(csp, /form-action 'none'/);
  const contents = Object.assign(new EventEmitter(), { setWindowOpenHandler: handler => { contents.open = handler; }, session: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} } });
  require('../electron/app/window-events.cjs').registerWindowContents({ window: { webContents: contents }, previewResources: resources });
  for (const url of ['https://example.invalid/?leak=x', 'http://example.invalid', 'file:///secret']) {
    let blocked = false; contents.emit('will-frame-navigate', { isMainFrame: false, url, preventDefault: () => { blocked = true; } }); assert.equal(blocked, true);
  }
  assert.deepEqual(contents.open(), { action: 'deny' });
});

test('outside captures use a private session and deny all network and foreign preview requests', async () => {
  let options, filter, handler, removed = false;
  const url = 'project-preview://outside/page.html';
  const resources = { isOutsideUrl: () => true, hasUrl: value => value.startsWith('project-preview://outside/'), resolve: async () => ({ path: __filename, mimeType: 'text/html', size: 0, headers: {} }) };
  class Window {
    constructor(value) {
      options = value;
      this.webContents = Object.assign(new EventEmitter(), { setWindowOpenHandler() {}, setAudioMuted() {}, invalidate() {}, executeJavaScript: async () => true,
        capturePage: async () => ({ isEmpty: () => false, resize: () => ({ toJPEG: () => Buffer.from('jpeg') }) }),
        session: { protocol: { handle: (_name, fn) => { handler = fn; }, unhandle: () => { removed = true; } }, webRequest: { onBeforeRequest: (arg, fn) => { if (fn) filter = fn; } } } });
    }
    async loadURL() { queueMicrotask(() => this.webContents.emit('dom-ready')); }
    isDestroyed() { return false; } destroy() {}
  }
  assert.match(await createPageCapture(Window, { settle: 0 })(url, resources), /data:image/);
  assert.match(options.webPreferences.partition, /^preview-/); assert.ok(!options.webPreferences.partition.startsWith('persist:'));
  for (const value of ['https://example.invalid', 'http://example.invalid', 'wss://example.invalid', 'file:///secret', 'project-preview://other/secret.json']) {
    let blocked; filter({ url: value }, result => { blocked = result.cancel; }); assert.equal(blocked, true, value);
  }
  let blocked; filter({ url }, result => { blocked = result.cancel; }); assert.equal(blocked, false);
  assert.equal((await handler(new Request(url, { method: 'POST' }))).status, 405); assert.equal(removed, true);
});

test('preview root is resolved once and a root replacement cannot change the containment check', async t => {
  const { root, project } = await fixture(t), output = path.join(root, 'output'), other = path.join(root, 'other');
  await fs.mkdir(output); await fs.mkdir(other); await fs.writeFile(path.join(output, 'page.html'), 'selected'); await fs.writeFile(path.join(other, 'page.html'), 'not selected');
  const resources = new PreviewResources(), location = await previewLocation(project, path.join(output, 'page.html'));
  const view = resources.open(location.project, location.relative, 'html'), realpath = fs.realpath.bind(fs);
  let rootReads = 0;
  t.mock.method(fs, 'realpath', async file => {
    if (file === location.project.path) { rootReads++; return realpath(file); }
    return realpath(path.join(other, 'page.html'));
  });
  await assert.rejects(resources.resolve(view.url), /escaped/);
  assert.equal(rootReads, 1);
});
