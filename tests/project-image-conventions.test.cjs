const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { listProjectImageCandidates, LIMITS } = require('../electron/features/workspace/project-images.cjs');
const { SVG_MAX_BYTES } = require('../electron/project-svg.cjs');

const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 24"><path fill="currentColor" d="M0 0h48v24z"/></svg>';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentrix-logo-')); let serial = 0;
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  function put(file, content, size = 64) {
    if (content === undefined) {
      content = Buffer.alloc(34); Buffer.from('89504e470d0a1a0a', 'hex').copy(content); content.writeUInt32BE(13, 8); content.write('IHDR', 12);
      content.writeUInt32BE(size, 16); content.writeUInt32BE(size, 20); content[33] = ++serial;
    }
    const target = path.join(root, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, content);
  }
  const scan = () => listProjectImageCandidates(root, bytes => `data:image/png;base64,${bytes.toString('base64')}`);
  const pick = async expected => { const result = await scan(); assert.equal(result.candidates[0]?.path, expected); assert.equal(result.candidates[0]?.source, 'icon'); return result; };
  return { root, put, scan, pick };
}

for (const scope of ['', 'apps/desktop/', 'packages/native/']) {
  for (const config of ['electron-builder.yml', 'electron-builder.yaml', 'electron-builder.json', 'package.json']) {
    test(`electron-builder ${scope || 'root/'}${config} finds directories.buildResources/icon.png`, async t => {
      const { put, pick } = fixture(t);
      const settings = { directories: { buildResources: 'artwork' } };
      put(scope + config, config === 'package.json' ? JSON.stringify({ build: settings }) : config.endsWith('.json') ? JSON.stringify(settings) : '# builder config\ndirectories:\n  buildResources: "artwork" # icon inputs\n');
      put(scope + 'artwork/icon.png'); put('docs/screenshots/dashboard.png');
      put('README.md', '![Screenshot](docs/screenshots/dashboard.png)');
      await pick(scope + 'artwork/icon.png');
    });
  }
  test(`electron-builder ${scope || 'root/'} uses default build/icon.png without package metadata`, async t => {
    const { put, pick } = fixture(t); put(scope + 'build/icon.png'); await pick(scope + 'build/icon.png');
  });
}

for (const key of ['icon', 'win', 'mac', 'linux']) for (const config of ['package.json', 'electron-builder.yml', 'electron-builder.json']) {
  test(`${config} reads the declared ${key} icon before conventional logos`, async t => {
    const { put, pick } = fixture(t);
    const settings = key === 'icon' ? { icon: 'artwork/brand.svg' } : { [key]: { icon: 'artwork/brand.svg' } };
    put(config, config === 'package.json' ? JSON.stringify({ build: settings }) : config.endsWith('.json') ? JSON.stringify(settings)
      : key === 'icon' ? 'icon: artwork/brand.svg\n' : `${key}:\n  icon: 'artwork/brand.svg'\n`);
    put('artwork/brand.svg', svg); put('logo.png'); await pick('artwork/brand.svg');
  });
}

for (const extension of ['png', 'ico', 'svg']) test(`default build/icon.${extension} is a conventional icon`, async t => {
  const { put, pick } = fixture(t); put('build/icon.' + extension, extension === 'svg' ? svg : undefined); await pick('build/icon.' + extension);
});

test('Electron Forge extensionless packagerConfig.icon remains a declared icon', async t => {
  const { put, pick } = fixture(t);
  put('package.json', JSON.stringify({ config: { forge: { packagerConfig: { icon: 'packaging/brand' } } } }));
  put('packaging/brand.png'); put('logo.png'); await pick('packaging/brand.png');
});

for (const legacy of [false, true]) test(`Tauri ${legacy ? 'v1' : 'v2'} bundle.icon is resolved relative to src-tauri`, async t => {
  const { put, pick } = fixture(t), bundle = { bundle: { icon: ['branding/brand.png'] } };
  put('src-tauri/tauri.conf.json', JSON.stringify(legacy ? { tauri: bundle } : bundle));
  put('src-tauri/branding/brand.png'); put('logo.png'); await pick('src-tauri/branding/brand.png');
});

test('Tauri icons/ treats numeric image names as icons and chooses the largest square', async t => {
  const { put, pick } = fixture(t); put('src-tauri/icons/32x32.png', undefined, 32); put('src-tauri/icons/128x128.png', undefined, 128);
  await pick('src-tauri/icons/128x128.png');
});

for (const file of ['index.html', 'public/index.html']) for (const rel of ['icon', 'apple-touch-icon', 'shortcut icon']) {
  test(`${file} reads link rel="${rel}" independent of attribute order`, async t => {
    const { put, pick } = fixture(t), icon = path.posix.join(path.posix.dirname(file), 'brand.svg');
    put(file, `<!-- <link rel="icon" href="ignored.png"> --><link href="brand.svg" sizes="any" rel="${rel}">`);
    put(icon, svg); put('logo.png'); await pick(icon);
  });
}

test('root-relative web icon URLs are local while remote and data links are ignored', async t => {
  const { put, pick } = fixture(t);
  put('public/index.html', '<link rel="icon" href="/brand.svg"><link rel="icon" href="https://example.com/a.png"><link rel="icon" href="data:image/png;base64,YWJj">');
  put('public/brand.svg', svg); await pick('public/brand.svg');
});

for (const folder of ['public', 'static']) test(`${folder}/favicon.* is a conventional web icon`, async t => {
  const { put, pick } = fixture(t); put(`${folder}/favicon.png`); await pick(`${folder}/favicon.png`);
});

test('web manifest declarations keep icon priority over a generic asset', async t => {
  const { put, pick } = fixture(t); put('public/manifest.webmanifest', JSON.stringify({ icons: [{ src: 'brand.svg' }] }));
  put('public/brand.svg', svg); put('logo.png'); await pick('public/brand.svg');
});

for (const file of ['app.rc', 'src/app.rc', 'windows/app.rc', 'app.csproj']) test(`native ${file} declares a local application icon`, async t => {
  const { put, pick } = fixture(t), icon = path.posix.join(path.posix.dirname(file), 'res/brand.ico');
  put(file, file.endsWith('.rc') ? '// IDI_OLD ICON "wrong.ico"\nIDI_APP ICON DISCARDABLE "res\\brand.ico"\n' : '<Project><PropertyGroup><ApplicationIcon>res/brand.ico</ApplicationIcon></PropertyGroup></Project>');
  put(icon); put('logo.png'); await pick(icon);
});

test('Flutter/Android launcher icons use the largest density without walking arbitrary Android trees', async t => {
  const { put, pick } = fixture(t), base = 'android/app/src/main/res/';
  for (const [density, size] of [['mdpi', 48], ['xhdpi', 96], ['xxxhdpi', 192]]) put(`${base}mipmap-${density}/ic_launcher.png`, undefined, size);
  put('android/build/icon.png'); await pick(base + 'mipmap-xxxhdpi/ic_launcher.png');
});

test('Android density order is deterministic even if the source dimensions are identical', async t => {
  const { put, pick } = fixture(t), base = 'android/app/src/main/res/';
  for (const density of ['hdpi', 'mdpi', 'xxhdpi', 'xxxhdpi']) put(`${base}mipmap-${density}/ic_launcher.png`);
  await pick(base + 'mipmap-xxxhdpi/ic_launcher.png');
});

for (const prefix of ['', 'ios/Runner/', 'macos/Runner/']) test(`${prefix}*.xcassets/AppIcon.appiconset chooses its largest image`, async t => {
  const { put, pick } = fixture(t), base = prefix + 'Assets.xcassets/AppIcon.appiconset/';
  put(base + 'small.png', undefined, 32); put(base + 'store.png', undefined, 1024); await pick(base + 'store.png');
});

for (const folder of ['icons', 'icon', 'desktop/assets/icons']) for (const name of ['app', 'icon', 'logo', 'project']) {
  test(`${folder}/${name}.svg is an icon and bypasses the raster thumbnailer`, async t => {
    const { root, put } = fixture(t), base = name === 'project' ? path.basename(root) : name, file = `${folder}/${base}.svg`;
    put(file, svg);
    const result = await listProjectImageCandidates(root, () => assert.fail('SVG was rasterized'));
    assert.equal(result.candidates[0]?.path, file); assert.equal(result.candidates[0]?.source, 'icon');
    assert.match(result.candidates[0].image, /^data:image\/svg\+xml;base64,/);
    assert.match(Buffer.from(result.candidates[0].image.split(',')[1], 'base64').toString(), /fill="#f2f2f2"/);
  });
}

test('SVG in assets and README links is available for manual choice without becoming a logo', async t => {
  const { put, scan } = fixture(t); put('assets/scene.svg', svg); put('README.md', '![Scene](artwork/scene.svg)'); put('artwork/scene.svg', svg.replace('h48', 'h47'));
  assert.deepEqual((await scan()).candidates.map(({ path, source }) => [path, source]), [['artwork/scene.svg', 'readme'], ['assets/scene.svg', 'asset']]);
});

test('vendored, runtime and Python/Tcl trees are ignored even when metadata or README explicitly names them', async t => {
  const { put, scan } = fixture(t);
  const folders = ['node_modules', 'vendor', 'runtime/cpython314/tcl', 'third_party', 'external', 'tools', 'python3.14', 'cpython-3.14', 'tcl9.0', 'venv/Lib/site-packages'];
  for (const folder of folders) put(`${folder}/logo.png`);
  put('package.json', JSON.stringify({ build: { icon: 'runtime/cpython314/tcl/logo.png', directories: { buildResources: 'vendor' } } }));
  put('vendor/icon.png'); put('README.md', folders.map(folder => `![Logo](${folder}/logo.png)`).join('\n'));
  put('img/dog_on_lawn.png');
  const result = await scan(); assert.deepEqual(result.candidates.map(({ path, source }) => [path, source]), [['img/dog_on_lawn.png', 'asset']]);
});

test('an internal file link cannot disguise a vendored logo as a root icon', async t => {
  const { root, put, scan } = fixture(t); put('runtime/logo.png');
  try { fs.symlinkSync(path.join(root, 'runtime/logo.png'), path.join(root, 'icon.png')); }
  catch (error) { if (error.code === 'EPERM') return; throw error; }
  assert.deepEqual(await scan(), { candidates: [] });
});

test('commented ApplicationIcon properties are not app logo declarations', async t => {
  const { put, scan } = fixture(t); put('app.csproj', '<Project><!-- <ApplicationIcon>artwork/old.png</ApplicationIcon> --></Project>'); put('artwork/old.png');
  assert.deepEqual(await scan(), { candidates: [] });
});

test('declared icons outrank conventional ones, then proximity precedes size and SVG wins a size tie', async t => {
  const { put, pick } = fixture(t);
  put('assets/icons/app.svg', svg); put('icon.png', undefined, 32); put('assets/icon.png', undefined, 512);
  await pick('icon.png');
  put('icon.svg', svg); await pick('icon.svg');
  put('package.json', JSON.stringify({ build: { icon: 'packaging/brand.png' } })); put('packaging/brand.png');
  await pick('packaging/brand.png');
});

test('square raster variants prefer the largest actual dimensions', async t => {
  const { put, pick } = fixture(t); put('assets/icon-16.png', undefined, 16); put('assets/icon-512.png', undefined, 512); put('assets/icon-128.png', undefined, 128);
  await pick('assets/icon-512.png');
});

test('oversize SVG is skipped whole and does not stop a later logo or exceed the candidate cap', async t => {
  const { put, scan } = fixture(t); put('icon.svg', '<svg>' + ' '.repeat(SVG_MAX_BYTES) + '</svg>'); put('logo.png');
  const result = await scan(); assert.deepEqual(result.candidates.map(candidate => candidate.path), ['logo.png']); assert.ok(result.candidates.length <= LIMITS.candidates);
});
