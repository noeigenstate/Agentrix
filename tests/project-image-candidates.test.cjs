const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { listProjectImageCandidates, projectImageDimensions, LIMITS } = require('../electron/features/workspace/project-images.cjs');
const { registerWorkspaceIpc } = require('../electron/features/workspace/ipc.cjs');
const { createIpcAdapter } = require('../electron/shared/ipc.cjs');

const picture = bytes => `data:image/png;base64,${bytes.toString('base64')}`;
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentrix-image-candidates-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'project'); fs.mkdirSync(root);
  function put(file, content = file) {
    const target = path.resolve(root, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, content); return target;
  }
  const scan = (thumbnail = picture, limits = {}) => listProjectImageCandidates(root, thumbnail, { ...LIMITS, ...limits });
  return { root, directory, put, scan };
}
const paths = result => result.candidates.map(candidate => candidate.path);

test('a code-only, missing or non-directory project has no candidates', async t => {
  const { root, put, scan } = fixture(t); const code = put('main.py', 'print("hello")');
  assert.deepEqual(await scan(), { candidates: [] });
  assert.deepEqual(await listProjectImageCandidates(root + '-missing', picture), { candidates: [] });
  assert.deepEqual(await listProjectImageCandidates(code, picture), { candidates: [] });
});

test('explicit package icons, named icons, README images and existing assets have deterministic priority', async t => {
  const { put, scan } = fixture(t);
  put('package.json', JSON.stringify({ build: { win: { icon: 'resources/product.png' } }, scripts: { preinstall: 'never execute' } }));
  put('resources/product.png'); put('logo.png'); put('favicon.ico'); put('README.md', '![Demo](docs/demo.png)'); put('docs/demo.png'); put('assets/preview.png');
  const result = await scan();
  assert.deepEqual(paths(result), ['resources/product.png', 'favicon.ico', 'docs/demo.png', 'assets/preview.png']);
  assert.deepEqual(result.candidates.map(candidate => candidate.source), ['icon', 'icon', 'readme', 'asset']);
  for (const candidate of result.candidates) {
    assert.equal(path.isAbsolute(candidate.path), false); assert.equal(candidate.path.includes('\\'), false);
    assert.match(candidate.image, /^data:image\/png;base64,/);
  }
});

test('README inline destinations support titles, spaces, encoded queries, parentheses and escaping', async t => {
  const { put, scan } = fixture(t);
  const names = ['docs/a.png', 'docs/space name.png', 'docs/encoded name.png', 'docs/preview(1).png', 'docs/escaped(2).png'];
  names.forEach(name => put(name));
  put('README.en.md', [
    '![A](docs/a.png "A title")', '![Space](<docs/space name.png> "A title")',
    '![Encoded](docs/encoded%20name.png?raw=1#preview)', '![Paren](docs/preview(1).png)', '![Escaped](docs/escaped\\(2\\).png)',
  ].join('\n'));
  assert.deepEqual(paths(await scan()), [...names].sort());
});

test('README references, collapsed references, shortcut references and HTML img are discovered', async t => {
  const { put, scan } = fixture(t);
  const names = ['media/full.png', 'media/collapsed.png', 'media/shortcut.png', 'media/html image.png']; names.forEach(name => put(name));
  put('README.md', [
    '![Description][Full Image]', '![Collapsed][]', '![Shortcut]',
    '[Full Image]: media/full.png "title"', '[Collapsed]: media/collapsed.png', '[Shortcut]: media/shortcut.png',
    '<img alt="HTML" src="media/html%20image.png?x=1&amp;y=2" width="400">',
  ].join('\n'));
  assert.deepEqual(paths(await scan()), [...names].sort());
});

test('remote, SVG, data, absolute and escaping README paths never reach the thumbnail callback', async t => {
  const { root, put, scan } = fixture(t); put('../outside.png', 'outside'); put('docs/ok.png');
  put('README.md', [
    '![Remote](https://example.com/a.png)', '![Protocol relative](//example.com/a.png)', '![Data](data:image/png;base64,YWJj)',
    '![SVG](assets/logo.svg)', '![Escape](../outside.png)', '![Encoded escape](%2e%2e/outside.png)',
    `![Absolute](<${path.resolve(root, '../outside.png')}>)`, '![Invalid](docs/%GG.png)', '![Good](docs/ok.png)',
    '<img src="https://example.com/tracking.png">', '<!-- ![Hidden](docs/hidden.png) -->', '```md\n![Code](docs/code.png)\n```',
  ].join('\n'));
  put('assets/logo.svg', '<svg><script>never</script></svg>');
  let calls = 0; const fetch = global.fetch; global.fetch = () => { throw new Error('Network forbidden'); }; t.after(() => { global.fetch = fetch; });
  const result = await scan(bytes => { calls++; return picture(bytes); });
  assert.deepEqual(paths(result), ['docs/ok.png']); assert.equal(calls, 1);
});

test('directory links and file links outside the project are never followed', async t => {
  const { root, directory, put, scan } = fixture(t); const outside = path.join(directory, 'outside'); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.png'), 'secret'); put('assets/inside.png');
  fs.symlinkSync(outside, path.join(root, 'public'), process.platform === 'win32' ? 'junction' : 'dir');
  fs.symlinkSync(path.join(root, 'assets'), path.join(root, 'images'), process.platform === 'win32' ? 'junction' : 'dir');
  put('README.md', '![Outside](public/secret.png)\n![Inside link](images/inside.png)');
  assert.deepEqual(paths(await scan()), ['assets/inside.png']);
  try { fs.symlinkSync(path.join(outside, 'secret.png'), path.join(root, 'linked.png')); }
  catch (error) { if (error.code === 'EPERM') return; throw error; }
  put('README.md', '![Linked file](linked.png)');
  assert.deepEqual(paths(await scan()), ['assets/inside.png']);
});

test('dependency, hidden, output and cache folders are skipped, including explicit dependency references', async t => {
  const { put, scan } = fixture(t);
  for (const folder of ['node_modules', '.git', '.private', 'dist', 'target', 'cache', 'vendor']) put(`${folder}/image.png`);
  put('README.md', '![Dependency](node_modules/image.png)\n![Hidden](.private/image.png)\n![Output](dist/image.png)');
  put('assets/badge-build.png'); put('assets/valid.png');
  assert.deepEqual(paths(await scan()), ['assets/valid.png']);
});

test('shallow monorepo package icons, build-resource metadata and web manifests are supported', async t => {
  const { put, scan } = fixture(t);
  put('apps/desktop/package.json', JSON.stringify({ build: { directories: { buildResources: 'build' } } })); put('apps/desktop/build/icon.png');
  put('packages/web/public/manifest.webmanifest', JSON.stringify({ icons: [{ src: 'web-icon.png' }] })); put('packages/web/package.json', '{}'); put('packages/web/public/web-icon.png');
  put('apps/desktop/README.md', '![Desktop](screenshots/desktop.png)'); put('apps/desktop/screenshots/desktop.png');
  const result = await scan();
  assert.deepEqual(paths(result), ['packages/web/public/web-icon.png', 'apps/desktop/build/icon.png', 'apps/desktop/screenshots/desktop.png']);
  assert.deepEqual(result.candidates.map(candidate => candidate.source), ['icon', 'icon', 'readme']);
});

test('malformed metadata, corrupt inputs and rejected thumbnail results do not prevent later candidates', async t => {
  const { put, scan } = fixture(t); put('package.json', 'null'); put('public/manifest.json', '{bad');
  for (const name of ['a', 'b', 'c', 'd', 'e', 'f']) put(`assets/${name}.png`, name);
  const result = await scan(bytes => {
    const name = bytes.toString();
    if (name === 'a') throw new Error('corrupt image');
    if (name === 'b') return null;
    if (name === 'c') return 'data:image/svg+xml;base64,PHN2Zz4=';
    if (name === 'd') return `data:image/png;base64,${'A'.repeat(200_000)}`;
    return picture(bytes);
  });
  assert.deepEqual(paths(result), ['assets/e.png', 'assets/f.png']);
});

test('content duplicates and identical rendered variants are deduplicated', async t => {
  const { put, scan } = fixture(t); put('logo.png', 'same'); put('assets/logo-copy.png', 'same'); put('assets/second.png', 'variant'); put('assets/third.png', 'third');
  let calls = 0;
  const result = await scan(bytes => { calls++; return picture(bytes.toString() === 'variant' ? Buffer.from('same') : bytes); });
  assert.deepEqual(paths(result), ['logo.png', 'assets/third.png']); assert.equal(calls, 3);
});

test('candidate output is capped at six with at most two named icon variants', async t => {
  const { put, scan } = fixture(t);
  for (let i = 0; i < 9; i++) put(`assets/logo-${i}.png`);
  for (let i = 0; i < 9; i++) put(`assets/screenshot-${i}.png`);
  const result = await scan();
  assert.equal(result.candidates.length, 6); assert.equal(result.candidates.filter(candidate => candidate.source === 'icon').length, 2);
  assert.equal(result.candidates.filter(candidate => candidate.source === 'asset').length, 4);
});

test('filesystem modification times do not change ranking and scanning never changes project files', async t => {
  const { root, put, scan } = fixture(t); const first = put('assets/alpha.png'), last = put('assets/zebra.png'); put('README.md', '![Zebra](assets/zebra.png)');
  const snapshot = () => fs.readdirSync(root, { recursive: true }).filter(file => fs.statSync(path.join(root, file)).isFile()).map(file => [file, fs.readFileSync(path.join(root, file), 'hex')]);
  const before = snapshot(), result = await scan(); fs.utimesSync(first, new Date(0), new Date(0)); fs.utimesSync(last, new Date(), new Date());
  assert.deepEqual(await scan(), result); assert.deepEqual(snapshot(), before);
});

test('image, README, total-byte and thumbnail-attempt budgets are bounded', async t => {
  const { put, scan } = fixture(t); put('README.md', '![Large readme](docs/unused.png)\n'.repeat(100)); put('docs/unused.png', 'readme image');
  put('assets/a.png', 'a'.repeat(40)); put('assets/b.png', 'b'.repeat(40)); put('assets/c.png', 'c'.repeat(80));
  assert.deepEqual(paths(await scan(picture, { readmeBytes: 8, imageBytes: 50, totalBytes: 70 })), ['assets/a.png', 'docs/unused.png']);
  let calls = 0; await scan(() => { calls++; return null; }, { thumbnails: 2 }); assert.equal(calls, 2);
});

test('directory, depth, entry and candidate-file budgets stop traversal', async t => {
  const { put, scan } = fixture(t); put('assets/a.png'); put('assets/deep/b.png'); put('public/c.png');
  assert.deepEqual(await scan(picture, { directories: 1 }), { candidates: [] });
  assert.deepEqual(paths(await scan(picture, { depth: 1 })), ['assets/a.png', 'public/c.png']);
  assert.deepEqual(await scan(picture, { entries: 1 }), { candidates: [] });
  assert.equal((await scan(picture, { files: 1 })).candidates.length, 1);
});

test('the secured preload discovery API is read-only and SSH never calls the local scanner', async t => {
  const handles = new Map(), calls = []; let bridge, broadcasts = 0;
  const frame = { url: 'agentrix://app/index.html' }, window = { webContents: { mainFrame: frame } };
  const adapter = createIpcAdapter({ ipcMain: { handle: (name, fn) => handles.set(name, fn) }, getWindow: () => window, t: text => text });
  const candidate = { path: 'assets/logo.png', source: 'icon', image: picture(Buffer.from('image')) };
  registerWorkspaceIpc({ ...adapter, findProject: id => {
    if (id === 'local') return { kind: 'local', path: '/a/local/project', image: 'saved-image' };
    if (id === 'ssh') return { kind: 'ssh', path: '/remote/project' };
    throw new Error('项目不存在。');
  }, listProjectImageCandidates: async folder => { calls.push(folder); return { candidates: [candidate] }; }, broadcast: () => broadcasts++ });
  const event = { sender: window.webContents, senderFrame: frame };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../electron/preload.cjs'), 'utf8'), {
    require: name => { assert.equal(name, 'electron'); return { contextBridge: { exposeInMainWorld: (name, api) => { assert.equal(name, 'agentrix'); bridge = api; } },
      ipcRenderer: { invoke: (name, ...args) => handles.get(name)(event, ...args) } }; },
  });
  assert.deepEqual(await bridge.listProjectImageCandidates('local'), { ok: true, value: { candidates: [candidate] } });
  assert.deepEqual(await bridge.listProjectImageCandidates('ssh'), { ok: true, value: { candidates: [], unavailable: 'ssh' } });
  assert.equal((await bridge.listProjectImageCandidates('missing')).ok, false);
  assert.deepEqual(calls, ['/a/local/project']); assert.equal(broadcasts, 0);
  await assert.rejects(handles.get('workspace:project-image-candidates')({ ...event, sender: {} }, 'local'), /Rejected IPC sender/);
  assert.deepEqual(calls, ['/a/local/project']); assert.equal(broadcasts, 0);
});

function pngHeader(width, height) {
  const bytes = Buffer.alloc(33); Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes); bytes.writeUInt32BE(13, 8); bytes.write('IHDR', 12);
  bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20); bytes[24] = 8; bytes[25] = 6; return bytes;
}
function jpegHeader(width, height, marker = 0xc0) {
  const bytes = Buffer.alloc(23); bytes[0] = 255; bytes[1] = 0xd8; bytes[2] = 255; bytes[3] = marker;
  bytes.writeUInt16BE(17, 4); bytes[6] = 8; bytes.writeUInt16BE(height, 7); bytes.writeUInt16BE(width, 9); bytes[11] = 3;
  bytes[21] = 255; bytes[22] = 0xd9; return bytes;
}
function webpHeader(width, height, kind = 'VP8L') {
  const data = Buffer.alloc(kind === 'VP8L' ? 5 : 10);
  if (kind === 'VP8L') { data[0] = 0x2f; data.writeUInt32LE((width - 1) | ((height - 1) << 14), 1); }
  else { Buffer.from('9d012a', 'hex').copy(data, 3); data.writeUInt16LE(width, 6); data.writeUInt16LE(height, 8); }
  const chunk = Buffer.alloc(8); chunk.write(kind); chunk.writeUInt32LE(data.length, 4);
  const bytes = Buffer.concat([Buffer.from('RIFF0000WEBP'), chunk, data, ...(data.length & 1 ? [Buffer.alloc(1)] : [])]);
  bytes.writeUInt32LE(bytes.length - 8, 4); return bytes;
}
function icoHeader(payload, width = 0, height = 0) {
  const directory = Buffer.alloc(22); directory.writeUInt16LE(1, 2); directory.writeUInt16LE(1, 4); directory[6] = width; directory[7] = height;
  directory.writeUInt32LE(payload.length, 14); directory.writeUInt32LE(22, 18); return Buffer.concat([directory, payload]);
}

test('known raster headers are checked without allocating decoded pixels', () => {
  const gif = Buffer.alloc(13); gif.write('GIF89a'); gif.writeUInt16LE(80, 6); gif.writeUInt16LE(64, 8);
  const dib = Buffer.alloc(40); dib.writeUInt32LE(40); dib.writeInt32LE(80, 4); dib.writeInt32LE(128, 8);
  for (const bytes of [pngHeader(80, 64), jpegHeader(80, 64), jpegHeader(80, 64, 0xc2), gif,
    webpHeader(80, 64), webpHeader(80, 64, 'VP8 '), icoHeader(pngHeader(80, 64)), icoHeader(dib, 80, 64)]) {
    assert.deepEqual(projectImageDimensions(bytes, 'asset'), { width: 80, height: 64 });
  }
  const frame = webpHeader(80, 64), extended = Buffer.alloc(18); extended.write('VP8X'); extended.writeUInt32LE(10, 4);
  extended.writeUIntLE(79, 12, 3); extended.writeUIntLE(63, 15, 3);
  const bytes = Buffer.concat([frame.subarray(0, 12), extended, frame.subarray(12)]); bytes.writeUInt32LE(bytes.length - 8, 4);
  assert.deepEqual(projectImageDimensions(bytes, 'asset'), { width: 80, height: 64 });
  extended[8] = 2;
  const animated = Buffer.concat([frame.subarray(0, 12), extended, frame.subarray(12)]); animated.writeUInt32LE(animated.length - 8, 4);
  assert.equal(projectImageDimensions(animated, 'asset'), null);
});

test('overlarge dimensions, tiny badges and extreme aspect ratios fail the header gate', () => {
  const gif = Buffer.alloc(13); gif.write('GIF89a'); gif.writeUInt16LE(8000, 6); gif.writeUInt16LE(8000, 8);
  for (const bytes of [pngHeader(8000, 8000), jpegHeader(8000, 8000), gif, webpHeader(8000, 8000), icoHeader(pngHeader(8000, 8000))]) {
    assert.equal(projectImageDimensions(bytes, 'icon'), null);
  }
  assert.deepEqual(projectImageDimensions(pngHeader(16, 16), 'icon'), { width: 16, height: 16 });
  assert.equal(projectImageDimensions(pngHeader(16, 16), 'readme'), null);
  assert.deepEqual(projectImageDimensions(pngHeader(192, 48), 'asset'), { width: 192, height: 48 });
  assert.equal(projectImageDimensions(pngHeader(193, 48), 'asset'), null);
  assert.equal(projectImageDimensions(pngHeader(0, 48), 'asset'), null);
});

test('unknown, malformed and truncated headers are rejected before native decoding', () => {
  const png = pngHeader(80, 64), jpeg = jpegHeader(80, 64), webp = webpHeader(80, 64), ico = icoHeader(png);
  for (const bytes of [Buffer.alloc(0), Buffer.from('<svg></svg>'), png.subarray(0, 32), jpeg.subarray(0, 20), webp.subarray(0, 24), ico.subarray(0, 21)]) {
    assert.equal(projectImageDimensions(bytes, 'asset'), null);
  }
  jpeg.writeUInt16BE(1, 4); assert.equal(projectImageDimensions(jpeg, 'asset'), null);
  ico.writeUInt32LE(0x7fffffff, 18); assert.equal(projectImageDimensions(ico, 'icon'), null);
  const gif = Buffer.alloc(13); gif.write('GIF89a'); gif.writeUInt16LE(80, 6); gif.writeUInt16LE(64, 8); gif[10] = 128;
  assert.equal(projectImageDimensions(gif, 'asset'), null);
  assert.equal(projectImageDimensions(null, 'asset'), null);
});

test('real repository PNG, JPEG, ICO and a valid static WebP remain eligible', () => {
  const webp = Buffer.from('UklGRiQAAABXRUJQVlA4TBcAAAAvT8APAAdQv4K3pf8BICH8ny9F9D/1AwA=', 'base64');
  assert.deepEqual(projectImageDimensions(webp, 'asset'), { width: 80, height: 64 });
  for (const [file, source] of [['assets/icon.png', 'icon'], ['assets/icon.ico', 'icon'], ['docs/images/reading-view.jpg', 'readme']]) {
    const size = projectImageDimensions(fs.readFileSync(path.join(__dirname, '..', file)), source);
    assert.ok(size, file); assert.ok(size.width > 0 && size.height > 0, file);
  }
});


test('Unicode localized READMEs keep the existing delimited Markdown filename scope', async t => {
  const { put, scan } = fixture(t);
  for (const [name, file] of [['README.中文.md', 'material/chinese.png'], ['README.日本語.md', 'material/japanese.png'], ['README.हिन्दी.md', 'material/hindi.png']]) {
    put(name, '![' + name + '](' + file + ')'); put(file);
  }
  for (const name of ['README中文.md', 'README.中文.txt', 'README.中文.md.bak']) put(name, '![Ignored](material/ignored.png)');
  put('material/ignored.png');
  assert.deepEqual(paths(await scan()), ['material/chinese.png', 'material/hindi.png', 'material/japanese.png']);
});

test('HTML numeric and named character references resolve once before local path filtering', async t => {
  const { put, scan } = fixture(t);
  const names = ['material/decimal space.png', 'material/hex space.png', 'material/amp&name.png', "material/apos'name.png", 'material/机器人🤖.png'];
  names.forEach(name => put(name));
  put('README.md', [
    '<img src="material/decimal&#32;space.png">', '<img src="material/hex&#x20;space.png">', '<img src="material/amp&amp;name.png">',
    '<img src="material/apos&apos;name.png">', '<img src="material/机器人&#x1F916;.png">',
  ].join('\n'));
  assert.deepEqual(paths(await scan()), [...names].sort());
});

test('decoded traversal, schemes and invalid numeric references do not escape the root or abort scanning', async t => {
  const { put, scan } = fixture(t); put('../outside.png'); put('material/valid.png');
  put('README.md', [
    '<img src="&#46;&#46;/outside.png">', '<img src="&#x2e;&#x2e;&#x2f;outside.png">', '<img src="&#37;2e&#37;2e&#47;outside.png">',
    '<img src="https&#58;//example.com/remote.png">', '<img src="&#92;&#92;server/remote.png">',
    '<img src="material/bad&#0;.png">', '<img src="material/bad&#xD800;.png">', '<img src="material/bad&#x110000;.png">',
    '<img src="material/bad&#99999999999999999999999999999;.png">', '<img src="material/bad&#xZZ;.png">', '<img src="material/valid.png">',
  ].join('\n'));
  let calls = 0; const result = await scan(bytes => { calls++; return picture(bytes); });
  assert.deepEqual(paths(result), ['material/valid.png']); assert.equal(calls, 1);
});

test('entity decoding is single-pass and URL-encoded literal Markdown characters stay literal', async t => {
  const { put, scan } = fixture(t); put('material/amp&amp;.png'); put('material/literal&#32;.png'); put('material/wrong space.png');
  put('README.md', [
    '<img src="material/amp&amp;amp;.png">', '<img src="material/wrong&amp;#32;space.png">',
    '![Literal](material/literal%26%2332%3B.png)',
  ].join('\n'));
  assert.deepEqual(paths(await scan()), ['material/amp&amp;.png', 'material/literal&#32;.png']);
});
