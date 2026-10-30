const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { PreviewResources, resourceResponse } = require('../electron/preview-resources.cjs');
const { createFileCards } = require('../electron/features/files/file-cards.cjs');
const { registerFilesIpc } = require('../electron/features/files/ipc.cjs');

async function fixture(t) {
  const prefix = path.join(os.tmpdir(), 'agentrix-outside-preview-'), directory = await fs.mkdtemp(prefix);
  const project = { id: 'p', kind: 'local', path: path.join(directory, 'project') }, folder = path.join(directory, 'output'), links = [];
  const home = path.join(directory, 'synthetic-home');
  t.mock.method(os, 'homedir', () => home);
  for (const [key, suffix] of Object.entries({ APPDATA: 'AppData/Roaming', LOCALAPPDATA: 'AppData/Local', XDG_CONFIG_HOME: '.config', XDG_DATA_HOME: '.local/share' })) {
    const previous = process.env[key]; process.env[key] = path.join(home, suffix);
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
  await fs.mkdir(project.path); await fs.mkdir(folder); await fs.mkdir(path.join(folder, 'assets'));
  await fs.writeFile(path.join(folder, 'page 中文 #%.html'), '<link rel="stylesheet" href="assets/style.css"><script src="assets/page.js"></script><h1>Outside</h1>');
  await fs.writeFile(path.join(folder, 'assets/style.css'), 'body { color: red; }');
  await fs.writeFile(path.join(folder, 'assets/page.js'), 'document.body.dataset.ready = "yes"');
  await fs.writeFile(path.join(folder, 'clip.mp4'), '0123456789');
  await fs.writeFile(path.join(directory, 'private.js'), 'outside the selected folder');
  t.after(async () => {
    assert.ok(path.resolve(directory).startsWith(prefix));
    for (const link of links) if ((await fs.lstat(link).catch(() => null))?.isSymbolicLink()) await fs.unlink(link);
    await fs.rm(directory, { recursive: true, force: true });
  });
  const previews = new PreviewResources(), handles = new Map();
  registerFilesIpc({ handle: (name, fn) => handles.set(name, fn), listen: () => {}, findProject: id => { assert.equal(id, project.id); return project; }, previewResources: previews });
  return { directory, project, folder, links, previews, handles, file: path.join(folder, 'page 中文 #%.html') };
}

test('a page outside the project captures its own assets and opens through the existing popup IPC', async t => {
  const { project, folder, file, previews, handles } = await fixture(t);
  const card = createFileCards({ previews, capture: async url => {
    assert.equal(decodeURIComponent(new URL(url).pathname), '/page 中文 #%.html');
    const page = await previews.resolve(url);
    assert.match(await fs.readFile(page.path, 'utf8'), /Outside/);
    assert.equal((await previews.resolve(new URL('assets/style.css', url))).path, await fs.realpath(path.join(folder, 'assets/style.css')));
    assert.match((await previews.resolve(new URL('assets/page.js', url))).mimeType, /javascript/);
    return 'data:image/jpeg;base64,CAPTURE';
  } });
  const shown = await card(project, file);
  assert.deepEqual(shown, { kind: 'html', path: await fs.realpath(file), picture: 'data:image/jpeg;base64,CAPTURE' });
  assert.equal(previews.sessions.size, 0, 'capture closes its token');
  const popup = await handles.get('project:file')(project.id, shown.path, 0);
  assert.equal(popup.kind, 'html'); assert.match(popup.content, /Outside/);
  assert.match((await previews.resolve(popup.url)).headers['Content-Security-Policy'], /sandbox allow-scripts allow-same-origin/);
  assert.equal(previews.sessions.get(popup.previewId).project.id, project.id);
  handles.get('project:preview-close')(popup.previewId);
  await assert.rejects(previews.resolve(popup.url), /expired/);
  assert.equal(project.path, path.join(path.dirname(folder), 'project'), 'the actual project root is unchanged');
});

test('external page tokens reject listing, parent escapes, hidden files and junctions leaving the selected folder', async t => {
  const { directory, project, folder, file, previews, handles, links } = await fixture(t);
  await fs.mkdir(path.join(folder, '.secret')); await fs.writeFile(path.join(folder, '.secret', 'data.json'), '{}');
  await fs.writeFile(path.join(folder, 'run.ps1'), 'exit');
  const linked = path.join(folder, 'other');
  await fs.symlink(directory, linked, process.platform === 'win32' ? 'junction' : 'dir'); links.push(linked);
  const popup = await handles.get('project:file')(project.id, file);
  for (const relative of ['.', '../private.js', '%2e%2e%2fprivate.js', '%2f../private.js', '.secret/data.json', 'run.ps1', 'other/private.js']) {
    await assert.rejects(previews.resolve(new URL(relative, popup.url).href), undefined, relative);
  }
  await assert.rejects(handles.get('project:directory')(project.id, folder));
  await assert.rejects(handles.get('project:save-file')(project.id, file, 0, popup.revision, 'changed'));
  assert.match(await fs.readFile(file, 'utf8'), /Outside/, 'preview does not grant writes');
});

test('outside videos support range seeking, selected-file isolation and project-wide revocation', async t => {
  const { project, folder, previews, handles } = await fixture(t), video = path.join(folder, 'clip.mp4');
  const card = createFileCards({ previews, capture: async () => null });
  const shown = await card(project, video);
  assert.equal(shown.kind, 'video'); assert.equal(shown.path, await fs.realpath(video));
  const popup = await handles.get('project:file')(project.id, shown.path);
  const resource = await previews.resolve(popup.url);
  const response = resourceResponse(resource, new Request(popup.url, { headers: { Range: 'bytes=3-6' } }));
  assert.equal(response.status, 206); assert.equal(response.headers.get('Content-Range'), 'bytes 3-6/10');
  assert.equal(await response.text(), '3456');
  await assert.rejects(previews.resolve(new URL('assets/style.css', shown.url).href));
  assert.notEqual(new URL(shown.url).hostname, new URL(popup.url).hostname);
  previews.closeProject(project.id);
  await assert.rejects(previews.resolve(shown.url), /expired/); await assert.rejects(previews.resolve(popup.url), /expired/);
});

test('a project junction escaping its root is refused, and replacing an authorized folder revokes access', async t => {
  const { directory, project, folder, file, previews, handles, links } = await fixture(t);
  const linked = path.join(project.path, 'output');
  await fs.symlink(folder, linked, process.platform === 'win32' ? 'junction' : 'dir'); links.push(linked);
  await assert.rejects(handles.get('project:file')(project.id, path.join(linked, path.basename(file))), { code: 'OUTSIDE_LINK' });
  const popup = await handles.get('project:file')(project.id, file);
  assert.equal((await previews.resolve(popup.url)).path, await fs.realpath(file));
  const replacement = path.join(directory, 'replacement'); await fs.mkdir(replacement);
  await fs.writeFile(path.join(replacement, path.basename(file)), '<h1>Unapproved</h1>');
  await fs.rename(folder, folder + '-old');
  await fs.symlink(replacement, folder, process.platform === 'win32' ? 'junction' : 'dir'); links.push(folder);
  await assert.rejects(previews.resolve(popup.url), /folder changed/);
});

test('SSH cards and popup reads explain that external pages and videos are not supported yet', async () => {
  const project = { id: 'remote', kind: 'ssh', path: '/srv/app' }, handles = new Map();
  const remote = { ready: Promise.resolve(), info: { root: project.path }, request: async () => { throw new Error('该链接指向远程项目目录之外。'); } };
  const previews = new PreviewResources({ remote: () => remote }), card = createFileCards({ previews, capture: async () => null });
  registerFilesIpc({ handle: (name, fn) => handles.set(name, fn), listen: () => {}, findProject: () => project, remoteFor: () => remote, previewResources: previews });
  for (const file of ['/tmp/page.html', '/tmp/clip.mp4', '../output/page.html', '..\\output\\page.html']) {
    await assert.rejects(card(project, file), /SSH 项目暂不支持预览项目目录外的页面和视频/);
    await assert.rejects(handles.get('project:file')(project.id, file), /SSH 项目暂不支持预览项目目录外的页面和视频/);
  }
  await assert.rejects(card(project, 'linked/page.html'), /该链接指向远程项目目录之外/);
  assert.equal(previews.sessions.size, 0);
});
