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
const { registerFilesIpc } = require('../electron/features/files/ipc.cjs');

async function fixture(t) {
  const prefix = path.join(os.tmpdir(), 'agentrix-preview-security-'), root = await fs.mkdtemp(prefix);
  t.after(async () => { assert.ok(path.resolve(root).startsWith(prefix)); await fs.rm(root, { recursive: true, force: true }); });
  const home = path.join(root, 'home'), project = { id: 'p', kind: 'local', path: path.join(root, 'project') };
  await fs.mkdir(home); await fs.mkdir(project.path);
  t.mock.method(os, 'homedir', () => home);
  for (const [key, folder] of Object.entries({ APPDATA: 'AppData/Roaming', LOCALAPPDATA: 'AppData/Local', XDG_CONFIG_HOME: '.config', XDG_DATA_HOME: '.local/share' })) {
    const previous = process.env[key]; process.env[key] = path.join(home, folder);
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
  return { root, home, project };
}

test('outside grants at home, filesystem roots, ancestors and open-project ancestors serve only the selected file', async t => {
  const { root, home, project } = await fixture(t);
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

test('outside UNC and device previews are rejected before filesystem operations', async t => {
  const project = { id: 'p', path: path.resolve('synthetic-project') }, resources = new PreviewResources();
  const card = createFileCards({ previews: resources, capture: async () => null });
  let calls = 0;
  for (const api of ['realpath', 'stat', 'open']) t.mock.method(fs, api, async () => { calls++; throw new Error('filesystem must not be called'); });
  for (const file of ['\\\\host\\share\\page.html', '\\\\?\\UNC\\host\\share\\page.html', '\\\\.\\host\\page.html', 'file://host/share/page.html', '//host/share/page.html', '\\\\host\\share\\image.png', '\\\\host\\share\\note.md']) {
    await assert.rejects(card(project, file), { code: 'NETWORK_PATH' });
  }
  assert.equal(calls, 0);
});

test('UNC-rooted and mapped projects preview their own HTML and video without granting outside UNC access', { skip: process.platform !== 'win32' }, async t => {
  const realRoot = '\\\\preview.invalid\\share\\app', files = { 'page.html': Buffer.from('<h1>Share</h1>'), 'clip.mp4': Buffer.from('video') };
  let project;
  const bytesOf = file => {
    assert.ok(file.startsWith(realRoot), file);
    const bytes = files[path.relative(realRoot, file)]; assert.ok(bytes, file); return bytes;
  };
  t.mock.method(fs, 'realpath', async file => path.join(realRoot, path.relative(file.startsWith(realRoot) ? realRoot : project.path, file)));
  const stat = file => ({ isFile: () => true, size: bytesOf(file).length, mtimeMs: 1, ctimeMs: 1 });
  t.mock.method(fs, 'stat', async file => stat(file));
  t.mock.method(fs, 'open', async file => ({ stat: async () => stat(file), close: async () => {},
    read: async (buffer, offset, length, position) => ({ bytesRead: bytesOf(file).copy(buffer, offset, position, position + length), buffer }) }));
  const resources = new PreviewResources(), handles = new Map();
  registerFilesIpc({ handle: (name, fn) => handles.set(name, fn), listen() {}, findProject: () => project, previewResources: resources });
  const card = createFileCards({ previews: resources, capture: async url => { assert.equal((await resources.resolve(url)).path, path.join(realRoot, 'page.html')); return 'picture'; } });
  for (const root of [realRoot, 'Z:\\synthetic-project']) {
    project = { id: 'unc', kind: 'local', path: root };
    assert.equal((await card(project, path.join(root, 'page.html'))).picture, 'picture');
    assert.equal((await card(project, 'clip.mp4')).kind, 'video');
    for (const file of Object.keys(files)) {
      const popup = await handles.get('project:file')(project.id, file);
      assert.equal((await resources.resolve(popup.url)).path, path.join(realRoot, file));
      assert.ok(!resources.isOutsideUrl(popup.url));
    }
    await assert.rejects(card(project, '\\\\elsewhere.invalid\\share\\page.html'), { code: 'NETWORK_PATH' });
  }
});

test('application-data and credential-store folders grant only the selected outside file', async t => {
  const { root, home, project } = await fixture(t);
  process.env.APPDATA = path.join(root, 'relocated-roaming');
  process.env.LOCALAPPDATA = path.join(root, 'relocated-local');
  process.env.XDG_CONFIG_HOME = path.join(root, 'xdg-config');
  process.env.XDG_DATA_HOME = path.join(root, 'xdg-data');
  const folders = ['AppData/Roaming', 'AppData/Local/nested', 'AppData/LocalLow', 'Library/Preferences', '.config', '.local/share'].map(folder => path.join(home, folder));
  folders.push(...['relocated-roaming', 'relocated-local', 'xdg-config', 'xdg-data', 'output/gcloud', 'output/credentials/nested', 'output/.aws', 'output/keyrings'].map(folder => path.join(root, folder)));
  for (const folder of folders) {
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(folder, 'page.html'), '<h1>Selected</h1>');
    await fs.writeFile(path.join(folder, 'secret.json'), '{"synthetic":true}');
    const resources = new PreviewResources(), location = await previewLocation(project, path.join(folder, 'page.html'));
    const view = resources.open(location.project, location.relative, 'html');
    assert.equal(location.project.previewSingleFile, true, folder);
    assert.match((await resources.resolve(view.url)).mimeType, /html/);
    await assert.rejects(resources.resolve(new URL('secret.json', view.url).href), /selected file/);
  }
  const output = path.join(home, 'Documents', 'site'); await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, 'page.html'), 'selected'); await fs.writeFile(path.join(output, 'style.css'), 'body{}');
  const resources = new PreviewResources(), location = await previewLocation(project, path.join(output, 'page.html'));
  const view = resources.open(location.project, location.relative, 'html');
  assert.equal(location.project.previewSingleFile, false);
  assert.match((await resources.resolve(new URL('style.css', view.url).href)).mimeType, /css/);
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

test('outside captures reuse an offline session, restrict WebRTC and deny network and foreign preview requests', async () => {
  let filter, handler, removed = 0;
  const options = [], policies = [], filters = [];
  const url = 'project-preview://outside/page.html';
  const resources = { isOutsideUrl: () => true, hasUrl: value => value.startsWith('project-preview://outside/'), resolve: async () => ({ path: __filename, mimeType: 'text/html', size: 0, headers: {} }) };
  class Window {
    constructor(value) {
      options.push(value);
      this.webContents = Object.assign(new EventEmitter(), { setWindowOpenHandler() {}, setAudioMuted() {}, invalidate() {}, executeJavaScript: async () => true,
        setWebRTCIPHandlingPolicy: value => policies.push(value),
        capturePage: async () => ({ isEmpty: () => false, resize: () => ({ toJPEG: () => Buffer.from('jpeg') }) }),
        session: { protocol: { handle: (_name, fn) => { handler = fn; }, unhandle: () => { removed++; } }, webRequest: { onBeforeRequest: (_arg, fn) => { filter = fn; filters.push(fn); } } } });
    }
    async loadURL() { queueMicrotask(() => this.webContents.emit('dom-ready')); }
    isDestroyed() { return false; } destroy() {}
  }
  const capture = createPageCapture(Window, { settle: 0 });
  assert.match(await capture(url, resources), /data:image/);
  const activeFilter = filters[0];
  for (const value of ['https://example.invalid', 'http://example.invalid', 'wss://example.invalid', 'file:///secret', 'project-preview://other/secret.json']) {
    let blocked; activeFilter({ url: value }, result => { blocked = result.cancel; }); assert.equal(blocked, true, value);
  }
  let blocked; activeFilter({ url }, result => { blocked = result.cancel; }); assert.equal(blocked, false);
  filter({ url: 'https://example.invalid' }, result => { blocked = result.cancel; }); assert.equal(blocked, true, 'the idle session stays offline');
  assert.equal((await handler(new Request(url, { method: 'POST' }))).status, 405);
  assert.match(await capture(url, resources), /data:image/);
  assert.equal(options[0].webPreferences.partition, options[1].webPreferences.partition);
  assert.match(options[0].webPreferences.partition, /^preview-/); assert.ok(!options[0].webPreferences.partition.startsWith('persist:'));
  assert.deepEqual(policies, ['disable_non_proxied_udp', 'disable_non_proxied_udp']); assert.equal(removed, 2);
  await capture('project-preview://inside/page.html', { isOutsideUrl: () => false });
  assert.equal(options[2].webPreferences.partition, undefined); assert.equal(policies.length, 2, 'the default session policy is unchanged');
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
