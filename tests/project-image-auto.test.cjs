const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createProjectImageAuto } = require('../electron/features/workspace/project-image-auto.cjs');
const { WorkspaceStore } = require('../electron/state.cjs');

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQ0AAAAASUVORK5CYII=';
const webp = 'data:image/webp;base64,UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==';
const local = (id, extra = {}) => ({ id, path: `/projects/${id}`, kind: 'local', ...extra });
const candidates = (...images) => ({ candidates: images.map(image => ({ path: 'assets/logo.png', source: 'icon', image })) });
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function fixture(projects, listCandidates = async () => candidates(png)) {
  const map = new Map(projects.map(project => [project.id, project])), saved = [], calls = [];
  let broadcasts = 0;
  const auto = createProjectImageAuto({ getProject: id => map.get(id), listCandidates: async folder => { calls.push(folder); return listCandidates(folder); },
    setProjectImage: (id, image, mode) => { saved.push([id, image, mode]); Object.assign(map.get(id), { image, imageMode: mode }); }, broadcast: () => broadcasts++ });
  return { auto, map, saved, calls, broadcasts: () => broadcasts };
}

test('only local projects without a snapshot or an explicit opt-out are eligible', async () => {
  const projects = [local('new'), local('auto', { imageMode: 'auto' }), local('snapshot', { image: png, imageMode: 'auto' }),
    local('legacy', { image: webp }), local('custom', { image: png, imageMode: 'custom' }), local('number', { imageMode: 'number' }),
    local('remote', { kind: 'ssh' })];
  const { auto, saved, calls, broadcasts } = fixture(projects, async () => candidates(png, webp));
  await Promise.all(projects.map(project => auto.enqueue(project)));
  assert.deepEqual(calls, ['/projects/new', '/projects/auto']);
  assert.deepEqual(saved, [['new', png, 'auto'], ['auto', png, 'auto']]); assert.equal(broadcasts(), 2);
});

test('even an empty or failed scan is attempted only once per runtime; another project still proceeds', async () => {
  const empty = local('empty'), broken = local('broken'), good = local('good');
  const f = fixture([empty, broken, good], async folder => {
    if (folder.endsWith('broken')) throw new Error('Unreadable project');
    return folder.endsWith('empty') ? candidates() : candidates(webp);
  });
  await f.auto.enqueue(empty); await f.auto.enqueue(empty);
  await f.auto.enqueue(broken); await f.auto.enqueue(broken); await f.auto.enqueue(good);
  assert.deepEqual(f.calls, ['/projects/empty', '/projects/broken', '/projects/good']); assert.equal(f.saved.length, 1); assert.equal(f.broadcasts(), 1);
  const restarted = fixture([empty]); await restarted.auto.enqueue(empty); assert.equal(restarted.saved.length, 1);
});

test('discovery yields before starting and uses one queue for startup and newly added projects', async () => {
  const first = local('first'), second = local('second'), added = local('added'), gate = deferred(), started = deferred();
  let active = 0, maximum = 0;
  const f = fixture([first, second], async folder => {
    maximum = Math.max(maximum, ++active);
    if (folder.endsWith('first')) { started.resolve(); await gate.promise; }
    active--; return candidates(png);
  });
  f.auto.enqueue(first); f.auto.enqueue(second); assert.deepEqual(f.calls, []);
  await started.promise; f.map.set(added.id, added); const tail = f.auto.enqueue(added);
  assert.deepEqual(f.calls, ['/projects/first']); gate.resolve(); await tail;
  assert.deepEqual(f.calls, ['/projects/first', '/projects/second', '/projects/added']); assert.equal(maximum, 1); assert.equal(f.broadcasts(), 3);
});

test('automatic choice accepts only icon sources and a project with only photos keeps its number', async () => {
  const photos = local('photos'), logo = local('logo');
  const f = fixture([photos, logo], async folder => ({ candidates: [
    { path: 'docs/screenshot.png', source: 'readme', image: webp }, { path: 'img/dog.png', source: 'asset', image: webp },
    ...(folder.endsWith('logo') ? [{ path: 'build/icon.png', source: 'icon', image: png }] : []),
  ] }));
  await f.auto.enqueue(photos); await f.auto.enqueue(logo);
  assert.deepEqual(f.saved, [['logo', png, 'auto']]); assert.equal(photos.image, undefined); assert.equal(f.broadcasts(), 1);
});

for (const change of ['custom', 'number', 'removed', 'path']) {
  test('a late scan cannot replace a project changed to ' + change, async () => {
    const project = local('late'), gate = deferred(), started = deferred();
    const f = fixture([project], async () => { started.resolve(); return gate.promise; });
    const finished = f.auto.enqueue(project); await started.promise;
    if (change === 'custom') Object.assign(project, { image: webp, imageMode: 'custom' });
    if (change === 'number') project.imageMode = 'number';
    if (change === 'removed') f.map.delete(project.id);
    if (change === 'path') project.path = '/projects/another-folder';
    gate.resolve(candidates(png)); await finished;
    assert.deepEqual(f.saved, []); assert.equal(f.broadcasts(), 0);
    if (change === 'custom') assert.equal(project.image, webp);
  });
}

test('a user choice made before the queue starts avoids discovery altogether', async () => {
  const project = local('changed'), f = fixture([project]); const finished = f.auto.enqueue(project);
  project.imageMode = 'number'; await finished; assert.deepEqual(f.calls, []); assert.equal(f.broadcasts(), 0);
});

test('a persisted automatic snapshot stays fixed across source changes and restarts', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentrix-image-auto-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'workspace.json'), store = new WorkspaceStore(file), project = store.add(root).project;
  const source = path.join(root, 'logo.txt'); fs.writeFileSync(source, png);
  let calls = 0, broadcasts = 0;
  const loader = current => createProjectImageAuto({ getProject: id => current.projects.find(project => project.id === id),
    listCandidates: async () => { calls++; return candidates(fs.readFileSync(source, 'utf8')); },
    setProjectImage: (id, image, mode) => current.setProjectImage(id, image, mode), broadcast: () => broadcasts++ });
  const auto = loader(store); await auto.enqueue(project);
  assert.equal(project.image, png); assert.equal(project.imageMode, 'auto');
  fs.writeFileSync(source, webp); await auto.enqueue(project); fs.unlinkSync(source);
  const reopened = new WorkspaceStore(file); await loader(reopened).enqueue(reopened.projects[0]);
  assert.equal(calls, 1); assert.equal(broadcasts, 1); assert.equal(reopened.projects[0].image, png); assert.equal(reopened.projects[0].imageMode, 'auto');
});

test('save failures roll back optional fields, stay silent and do not retry during the same runtime', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentrix-image-auto-save-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new WorkspaceStore(path.join(root, 'workspace.json')), project = store.add(root).project, save = store.save;
  let calls = 0, broadcasts = 0;
  const auto = createProjectImageAuto({ getProject: id => store.projects.find(project => project.id === id),
    listCandidates: async () => { calls++; return candidates(png); }, setProjectImage: (id, image, mode) => store.setProjectImage(id, image, mode), broadcast: () => broadcasts++ });
  store.save = () => { throw new Error('Disk unavailable'); };
  await auto.enqueue(project); assert.equal(project.image, undefined); assert.equal(project.imageMode, undefined); assert.equal(broadcasts, 0);
  store.save = save; await auto.enqueue(project); assert.equal(calls, 1); assert.equal(broadcasts, 0);
});
