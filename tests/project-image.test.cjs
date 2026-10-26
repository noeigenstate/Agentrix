const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { WorkspaceStore } = require('../electron/state.cjs');
const { createIpcAdapter } = require('../electron/shared/ipc.cjs');
const { registerWorkspaceIpc } = require('../electron/features/workspace/ipc.cjs');
const { sanitizeProjectSvg, projectSvgForTheme, SVG_MAX_BYTES } = require('../electron/project-svg.cjs');

const webp = 'data:image/webp;base64,UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==';
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQ0AAAAASUVORK5CYII=';
const jpeg = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQgJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDraKKK/HT7o//Z';
const invalidImages = [null, undefined, 42, {}, 'https://example.com/project.png', 'file:///project.png',
  'data:image/svg+xml;base64,PHN2Zz4=', 'data:image/gif;base64,R0lGODlh', 'data:image/png,abc',
  'data:image/png;base64,', 'data:image/png;base64,!!==', 'data:image/png;base64,YWJj',
  'data:image/png;base64,PHN2Zz4=', webp.replace('image/webp', 'image/png'), webp.slice(0, -1),
  `data:image/png;base64,${'A'.repeat(200_000)}`];

const svgUrl = text => `data:image/svg+xml;base64,${Buffer.from(text).toString('base64')}`;
const svg = sanitizeProjectSvg(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 24"><path fill="currentColor" d="M0 0h48v24z"/></svg>'));
invalidImages.push(...[
  '<svg onload="alert(1)"/>', '<svg><script>alert(1)</script></svg>', '<svg><foreignObject/></svg>',
  '<svg><image href="https://example.com/image.png"/></svg>', '<svg><image href="data:image/png;base64,YWJj"/></svg>',
  '<!DOCTYPE svg [<!ENTITY x "value">]><svg>&x;</svg>', '<svg><style>@import "https://example.com/a.css";</style></svg>',
  '<html><svg/></html>', '<svg fill="currentColor"/>', '<svg>' + ' '.repeat(SVG_MAX_BYTES) + '</svg>',
].map(svgUrl));
invalidImages.push('data:image/svg+xml;base64,' + Buffer.concat([Buffer.from('<svg>'), Buffer.from([0xff]), Buffer.from('</svg>')]).toString('base64'));

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentrix-project-image-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'workspace.json'), store = new WorkspaceStore(file);
  const { project } = store.add(directory, 'Local project');
  return { directory, file, store, project };
}

test('projects without a picture preserve the original workspace format', t => {
  const { store, file, project } = fixture(t);
  assert.equal(Object.hasOwn(project, 'image'), false);
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(file)).projects[0], 'image'), false);
  const reopened = new WorkspaceStore(file);
  assert.equal(reopened.warning, null);
  assert.equal(Object.hasOwn(reopened.projects[0], 'image'), false);
  assert.deepEqual(reopened.settings, store.settings);
});

test('a project picture persists and clearing it keeps a number-mode opt-out', t => {
  const { store, file, project } = fixture(t);
  for (const image of [webp, png, jpeg, svg]) {
    store.setProjectImage(project.id, image);
    assert.equal(new WorkspaceStore(file).projects[0].image, image);
    assert.equal(new WorkspaceStore(file).projects[0].imageMode, 'custom');
  }
  store.setProjectImage(project.id, '');
  assert.equal(Object.hasOwn(project, 'image'), false);
  assert.equal(Object.hasOwn(new WorkspaceStore(file).projects[0], 'image'), false);
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(file)).projects[0], 'image'), false);
});

for (const [operation, previous, next] of [['setting', '', png], ['replacing', png, webp], ['clearing', png, '']]) {
  test('a failed save while ' + operation + ' a picture restores its previous field and allows retry', t => {
    const { store, file, project } = fixture(t);
    if (previous) store.setProjectImage(project.id, previous);
    const saved = fs.readFileSync(file, 'utf8'), save = store.save;
    const error = new Error('Disk unavailable');
    store.save = () => { throw error; };
    assert.throws(() => store.setProjectImage(project.id, next), thrown => thrown === error);
    assert.equal(project.image, previous || undefined);
    assert.equal(Object.hasOwn(project, 'image'), !!previous);
    assert.equal(fs.readFileSync(file, 'utf8'), saved);
    assert.equal(new WorkspaceStore(file).projects[0].image, previous || undefined);
    store.save = save;
    store.setProjectImage(project.id, next);
    assert.equal(new WorkspaceStore(file).projects[0].image, next || undefined);
    assert.equal(Object.hasOwn(project, 'image'), !!next);
  });
}

test('invalid picture mutations leave the existing picture and saved workspace intact', t => {
  const { store, file, project } = fixture(t);
  store.setProjectImage(project.id, webp);
  const previous = fs.readFileSync(file, 'utf8');
  for (const value of invalidImages) {
    assert.throws(() => store.setProjectImage(project.id, value), /项目图片/);
    assert.equal(project.image, webp);
    assert.equal(fs.readFileSync(file, 'utf8'), previous);
  }
  assert.throws(() => store.setProjectImage('missing', png), /项目不存在/);
  assert.equal(fs.readFileSync(file, 'utf8'), previous);
});

test('invalid persisted pictures are dropped without losing projects or settings', t => {
  const { file, store } = fixture(t);
  const saved = JSON.parse(fs.readFileSync(file));
  for (const image of invalidImages.filter(value => value !== undefined)) {
    saved.projects[0].image = image;
    fs.writeFileSync(file, JSON.stringify(saved));
    const reopened = new WorkspaceStore(file);
    assert.equal(reopened.warning, null);
    assert.equal(reopened.projects.length, 1);
    assert.equal(Object.hasOwn(reopened.projects[0], 'image'), false);
    assert.deepEqual(reopened.settings, store.settings);
    reopened.save();
    assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(file)).projects[0], 'image'), false);
  }
});

test('pictures belong to each local or SSH project, never its terminal or another project', t => {
  const { directory, file, store, project } = fixture(t);
  const secondFolder = path.join(directory, 'second'); fs.mkdirSync(secondFolder);
  const second = store.add(secondFolder).project;
  const remote = store.addSSH({ host: 'example', path: '/srv/project' }).project;
  const terminal = store.addTerminal(project.id);
  store.setProjectImage(project.id, png); store.setProjectImage(remote.id, webp);
  assert.throws(() => store.setProjectImage(terminal, jpeg), /项目不存在/);
  assert.equal(Object.hasOwn(store.findTerminal(terminal).record, 'image'), false);
  assert.equal(Object.hasOwn(second, 'image'), false);
  const reopened = new WorkspaceStore(file);
  assert.deepEqual(reopened.projects.map(p => p.image), [png, undefined, webp]);
  store.setProjectImage(project.id, '');
  assert.equal(remote.image, webp);
});

test('changing a picture preserves terminal order, restoration, unread state and recent history', t => {
  const { store, project, file, directory } = fixture(t);
  const terminal = store.addTerminal(project.id);
  store.setRestore(project.id, { terminal: true, codex: true, cwd: directory, threadId: '00000000-0000-4000-8000-000000000001' });
  store.setRestore(terminal, { codex: true, agent: 'claude', interrupted: true });
  store.setTerminalOrder(project.id, [terminal, project.id]);
  store.expectCompletion(project.id); store.complete(project.id, 'turn-1', 1000);
  const before = new WorkspaceStore(file);
  store.setProjectImage(project.id, png);
  const after = new WorkspaceStore(file), changed = after.projects[0];
  delete changed.image; delete changed.imageMode;
  assert.deepEqual(changed, before.projects[0]);
  assert.deepEqual(after.history, before.history);
  assert.deepEqual(after.settings, before.settings);
});

test('the secured preload API saves then broadcasts and returns rejected mutations as results', async t => {
  const { store, project, file } = fixture(t), handles = new Map(); let broadcasts = 0, bridge;
  const frame = { url: 'agentrix://app/index.html' }, window = { webContents: { mainFrame: frame } };
  const adapter = createIpcAdapter({ ipcMain: { handle: (name, fn) => handles.set(name, fn) }, getWindow: () => window, t: text => text });
  registerWorkspaceIpc({ ...adapter, publicState: () => ({}), setProjectImage: (id, image, mode) => store.setProjectImage(id, image, mode),
    broadcast: () => { assert.equal(new WorkspaceStore(file).projects[0].image, project.image); broadcasts++; } });
  const event = { sender: window.webContents, senderFrame: frame };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../electron/preload.cjs'), 'utf8'), {
    require: name => { assert.equal(name, 'electron'); return { contextBridge: { exposeInMainWorld: (name, api) => { assert.equal(name, 'agentrix'); bridge = api; } },
      ipcRenderer: { invoke: (name, ...args) => handles.get(name)(event, ...args) } }; },
  });
  assert.deepEqual(await bridge.setProjectImage(project.id, png), { ok: true, value: undefined });
  assert.equal(project.image, png); assert.equal(broadcasts, 1);
  assert.equal((await bridge.setProjectImage(project.id, 'https://example.com/a.png')).ok, false);
  assert.equal(project.image, png); assert.equal(broadcasts, 1);
  assert.deepEqual(await bridge.setProjectImage(project.id, ''), { ok: true, value: undefined });
  assert.equal(Object.hasOwn(project, 'image'), false); assert.equal(broadcasts, 2);
  await assert.rejects(handles.get('workspace:set-project-image')({ ...event, sender: {} }, project.id, webp), /Rejected IPC sender/);
  assert.equal(broadcasts, 2);
  assert.deepEqual(await bridge.setProjectImage(project.id, png, 'auto'), { ok: true, value: undefined });
  assert.equal(new WorkspaceStore(file).projects[0].imageMode, 'auto'); assert.equal(broadcasts, 3);
  assert.equal((await bridge.setProjectImage(project.id, png, 'number')).ok, false);
  assert.equal(project.imageMode, 'auto'); assert.equal(project.image, png); assert.equal(broadcasts, 3);
  assert.deepEqual(await bridge.setProjectImage(project.id, '', 'auto'), { ok: true, value: undefined });
  assert.equal(new WorkspaceStore(file).projects[0].imageMode, 'auto'); assert.equal(project.image, undefined); assert.equal(broadcasts, 4);
  const originalSvg = svgUrl('<svg viewBox="0 0 48 24"><path fill="currentColor" d="M0 0h48v24z"/></svg>');
  assert.deepEqual(await bridge.setProjectImage(project.id, originalSvg, 'custom'), { ok: true, value: undefined });
  assert.equal(project.image, sanitizeProjectSvg(originalSvg)); assert.match(project.image, /^data:image\/svg\+xml;base64,/);
  assert.equal(new WorkspaceStore(file).projects[0].image, project.image); assert.equal(broadcasts, 5);
  const before = project.image;
  assert.equal((await bridge.setProjectImage(project.id, svgUrl('<svg onload="alert(1)"/>'), 'custom')).ok, false);
  assert.equal(project.image, before); assert.equal(broadcasts, 5);
});

test('public state themes SVG pictures without changing their canonical storage or terminal state', t => {
  const { store, project, file } = fixture(t);
  const main = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
  const context = vm.createContext({ store, projectSvgForTheme, sessions: new Map(), startupErrors: new Map(),
    terminalIds: p => [p.id], shownTerminalIds: p => [p.id], getBranch: () => 'main', t: text => text,
    localShell: () => ({ kind: 'powershell' }), process: { platform: 'win32', env: { AGENTRIX_DATA_DIR: 'isolated' } },
    app: { getVersion: () => '1' }, desktopGlassBackend: null, desktopGlassWindow: false, desktopGlassActive: false });
  vm.runInContext(main.slice(main.indexOf('function publicState('), main.indexOf('function terminalIds(')), context);
  const before = JSON.parse(JSON.stringify(context.publicState()));
  assert.equal(Object.hasOwn(before.projects[0], 'image'), false);
  store.setProjectImage(project.id, webp);
  const after = JSON.parse(JSON.stringify(context.publicState()));
  assert.equal(after.projects[0].image, webp);
  assert.equal(after.projects[0].imageMode, 'custom');
  delete after.projects[0].image; delete after.projects[0].imageMode;
  assert.deepEqual(after, before);
  store.setProjectImage(project.id, svg);
  for (const theme of ['light', 'mono', 'light']) {
    store.updateSettings({ theme });
    const projected = JSON.parse(JSON.stringify(context.publicState()));
    assert.equal(projected.projects[0].image, projectSvgForTheme(svg, theme));
    assert.equal(store.projects[0].image, svg);
    assert.equal(new WorkspaceStore(file).projects[0].image, svg);
    delete projected.projects[0].image; delete projected.projects[0].imageMode;
    projected.settings.theme = before.settings.theme;
    assert.deepEqual(projected, before);
  }
});

test('candidate previews use the requested theme and automatic selection keeps canonical SVGs', async () => {
  const main = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
  const context = vm.createContext({ projectSvgForTheme, PROJECT_IMAGE_LIMITS: { candidates: 6 }, thumbnailProjectImage: () => {},
    listProjectImageCandidates: async (folder, thumbnail, limits) => {
      assert.equal(folder, 'project'); assert.equal(typeof thumbnail, 'function'); assert.equal(limits.candidates, 1);
      return { candidates: [{ path: 'icon.svg', source: 'icon', image: svg }, { path: 'logo.png', source: 'icon', image: png }] };
    } });
  vm.runInContext(main.slice(main.indexOf('async function projectImageCandidates('), main.indexOf('setThumbnailer(')), context);
  const light = await context.projectImageCandidates('project', 1, 'light');
  assert.equal(light.candidates[0].image, projectSvgForTheme(svg, 'light'));
  assert.equal(light.candidates[1].image, png);
  assert.equal(sanitizeProjectSvg(light.candidates[0].image), svg);
  assert.equal((await context.projectImageCandidates('project', 1)).candidates[0].image, svg);
});


test('automatic, custom and number modes round-trip and legacy pictures keep their implicit custom mode', t => {
  const { store, project, file } = fixture(t);
  const legacy = JSON.parse(fs.readFileSync(file)); legacy.projects[0].image = png;
  fs.writeFileSync(file, JSON.stringify(legacy));
  const reopened = new WorkspaceStore(file);
  assert.equal(reopened.projects[0].image, png); assert.equal(Object.hasOwn(reopened.projects[0], 'imageMode'), false);
  for (const [mode, image] of [['auto', png], ['auto', ''], ['custom', webp], ['number', '']]) {
    store.setProjectImage(project.id, image, mode);
    const saved = new WorkspaceStore(file).projects[0];
    assert.equal(saved.imageMode, mode); assert.equal(saved.image, image || undefined);
  }
});

test('mode changes persist even when the image is unchanged, and identical settings do not save again', t => {
  const { store, project, file } = fixture(t); store.setProjectImage(project.id, png);
  store.setProjectImage(project.id, png, 'auto');
  assert.equal(new WorkspaceStore(file).projects[0].imageMode, 'auto');
  let saves = 0; store.save = () => saves++;
  store.setProjectImage(project.id, png, 'auto'); assert.equal(saves, 0);
  store.setProjectImage(project.id, png, 'custom'); assert.equal(saves, 1);
});

test('invalid modes or mode-image combinations leave the picture and workspace intact', t => {
  const { store, project, file } = fixture(t); store.setProjectImage(project.id, webp);
  const saved = fs.readFileSync(file, 'utf8');
  for (const [image, mode] of [[webp, 'automatic'], [webp, null], [webp, {}], [webp, false], [webp, 'number'], ['', 'custom']]) {
    assert.throws(() => store.setProjectImage(project.id, image, mode), /无效的项目图片模式/);
    assert.equal(project.image, webp); assert.equal(project.imageMode, 'custom'); assert.equal(fs.readFileSync(file, 'utf8'), saved);
  }
});

test('failed mode-only and combined changes restore both fields, including absent legacy mode', t => {
  const { store, project, file } = fixture(t); const save = store.save;
  for (const before of [{ image: png }, { image: png, imageMode: 'auto' }, { imageMode: 'number' }, {}]) {
    delete project.image; delete project.imageMode; Object.assign(project, before); save.call(store);
    const saved = fs.readFileSync(file, 'utf8');
    store.save = () => { throw new Error('Disk unavailable'); };
    for (const [image, mode] of [[png, 'custom'], [webp, 'auto'], ['', 'auto']]) {
      if (project.image === image && project.imageMode === mode) continue;
      assert.throws(() => store.setProjectImage(project.id, image, mode), /Disk unavailable/);
      assert.equal(project.image, before.image); assert.equal(project.imageMode, before.imageMode);
      assert.equal(Object.hasOwn(project, 'image'), Object.hasOwn(before, 'image'));
      assert.equal(Object.hasOwn(project, 'imageMode'), Object.hasOwn(before, 'imageMode'));
      assert.equal(fs.readFileSync(file, 'utf8'), saved);
    }
    store.save = save;
  }
});

test('persisted invalid modes are dropped and number mode cannot retain an image', t => {
  const { file } = fixture(t); const saved = JSON.parse(fs.readFileSync(file));
  for (const [mode, image, expectedMode, expectedImage] of [['invalid', png, undefined, png], ['custom', 'bad', undefined, undefined], ['number', png, 'number', undefined], ['auto', 'bad', 'auto', undefined]]) {
    saved.projects[0].imageMode = mode; saved.projects[0].image = image; fs.writeFileSync(file, JSON.stringify(saved));
    const project = new WorkspaceStore(file).projects[0];
    assert.equal(project.image, expectedImage); assert.equal(project.imageMode, expectedMode);
  }
});
