const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const React = require('react');

const nodes = node => Array.isArray(node) ? node.flatMap(nodes) : React.isValidElement(node) ? [node, ...nodes(node.props.children)] : [];
const tick = () => new Promise(resolve => setImmediate(resolve));
const image = 'data:image/webp;base64,UklGRg==';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function fixture(t, options = {}) {
  const before = global.window, calls = [], scans = [], decoded = [], cleanups = [], slots = [];
  let cursor = 0, closed = 0;
  const hooks = {
    useState(value) { const index = cursor++; if (!(index in slots)) slots[index] = value; return [slots[index], next => { slots[index] = next; }]; },
    useRef(value) { const index = cursor++; return slots[index] ??= { current: value }; },
    useId() { return `id-${cursor++}`; },
    useEffect(callback, deps) { const index = cursor++, previous = slots[index]; if (previous && deps.every((value, i) => Object.is(value, previous[i]))) return; slots[index] = deps; cleanups.push(callback()); },
  };
  global.window = { agentrix: {
    async setProjectImage(...args) { calls.push(args); return options.save ? options.save(...args) : { ok: true }; },
    async listProjectImageCandidates(...args) { scans.push(args); return options.scan ? options.scan(...args) : { ok: true, value: { candidates: [] } }; },
    startTerminal() { assert.fail('image editing started a terminal'); },
    removeProject() { assert.fail('image editing removed a project'); },
  } };
  t.after(() => { global.window = before; });
  const filename = path.join(__dirname, '../src/features/workspace/ProjectImageDialog.tsx'), mod = new Module(filename, module);
  mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename));
  const original = mod.require.bind(mod);
  mod.require = name => name === 'react' ? hooks : name === '@phosphor-icons/react' ? { X: () => React.createElement('svg') } : name.endsWith('.css') ? {} : name === '../../shared/i18n' ? { t: text => text }
    : name === '../settings/avatar-image' ? { AVATAR_TYPES: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'], AVATAR_MAX_BYTES: 10 * 1024 * 1024,
      async avatarFromFile(file) { decoded.push(file); return options.decode ? options.decode(file) : image; } } : original(name);
  mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, filename);
  const project = { id: 'project-1', name: 'Project', image: options.image, imageMode: options.mode };
  const render = () => { cursor = 0; return mod.exports.ProjectImageDialog({ project, index: 1, onClose: () => { closed++; } }); };
  const button = text => nodes(render()).find(node => node.type === 'button' && node.props.children === text);
  const pick = async (file = { type: 'image/png', size: 24 }) => {
    nodes(render()).find(node => node.type === 'input').props.onChange({ target: { files: [file], value: 'chosen-file' } });
    await tick();
  };
  return { calls, scans, decoded, render, button, pick, project, closed: () => closed, unmount: () => cleanups.forEach(cleanup => cleanup?.()),
    submit: () => nodes(render()).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }) };
}

test('opening, previewing, and canceling never persist a project image or change its input', async t => {
  const h = fixture(t), before = JSON.stringify(h.project);
  assert.ok(h.button('保存').props.disabled);
  await h.pick();
  assert.equal(nodes(h.render()).find(node => node.type === 'img').props.src, image);
  assert.equal(h.button('保存').props.disabled, false);
  h.button('取消').props.onClick();
  assert.equal(h.closed(), 1); assert.deepEqual(h.calls, []); assert.equal(JSON.stringify(h.project), before);
});

test('save waits for backend success and ignores duplicate submits while pending', async t => {
  const pending = deferred(), h = fixture(t, { save: () => pending.promise });
  await h.pick();
  const submit = nodes(h.render()).find(node => node.type === 'form').props.onSubmit;
  submit({ preventDefault() {} }); submit({ preventDefault() {} });
  assert.deepEqual(h.calls, [['project-1', image, 'custom']]); assert.equal(h.closed(), 0);
  assert.ok(h.button('正在保存…').props.disabled); assert.ok(h.button('取消').props.disabled);
  pending.resolve({ ok: true }); await tick(); assert.equal(h.closed(), 1);
});

test('restoring the numbered style stages an empty image with the explicit number mode', async t => {
  const h = fixture(t, { image });
  h.button('恢复原样').props.onClick();
  assert.deepEqual(h.calls, []); assert.equal(nodes(h.render()).some(node => node.type === 'img'), false);
  assert.ok(nodes(h.render()).some(node => node.type === 'span' && node.props.children === '02'));
  h.submit(); await tick(); assert.deepEqual(h.calls, [['project-1', '', 'number']]); assert.equal(h.closed(), 1);
});

test('a rejected save leaves the draft visible, shows the backend error, and permits retry', async t => {
  let failed = true;
  const h = fixture(t, { save: () => failed ? { ok: false, error: 'Project is unavailable' } : { ok: true } });
  await h.pick(); h.submit(); await tick();
  assert.equal(h.closed(), 0); assert.equal(nodes(h.render()).find(node => node.props.role === 'alert').props.children, 'Project is unavailable');
  assert.equal(h.button('保存').props.disabled, false);
  failed = false; h.submit(); await tick(); assert.equal(h.closed(), 1); assert.equal(h.calls.length, 2);
});

test('unsupported and oversized files leave the saved preview untouched without decoding or persisting', async t => {
  const h = fixture(t, { image });
  for (const file of [{ type: 'image/tiff', size: 24 }, { type: 'image/png', size: 10 * 1024 * 1024 + 1 }, { type: 'image/svg+xml', size: 100 * 1024 + 1 }]) {
    await h.pick(file);
    assert.equal(nodes(h.render()).find(node => node.type === 'img').props.src, image);
    assert.ok(nodes(h.render()).some(node => node.props.role === 'alert'));
  }
  assert.deepEqual(h.decoded, []); assert.deepEqual(h.calls, []);
});

test('manual SVG files retain their original bytes for main validation and never use the raster decoder', async t => {
  for (const type of ['image/svg+xml', '']) {
    const text = '<svg viewBox="0 0 48 24"><title>图标</title><path fill="currentColor" d="M0 0h48v24z"/></svg>';
    const bytes = Uint8Array.from(Buffer.from(text)), h = fixture(t);
    const input = nodes(h.render()).find(node => node.type === 'input');
    assert.ok(input.props.accept.includes('image/svg+xml') && input.props.accept.includes('.svg'));
    await h.pick({ type, name: 'app.svg', size: bytes.length, arrayBuffer: async () => bytes.buffer });
    const expected = 'data:image/svg+xml;base64,' + Buffer.from(text).toString('base64');
    assert.equal(nodes(h.render()).find(node => node.type === 'img').props.src, expected);
    assert.deepEqual(h.decoded, []); h.submit(); await tick();
    assert.deepEqual(h.calls, [['project-1', expected, 'custom']]);
  }
});

test('main refusal of a hostile manual SVG uses the existing dialog error and preserves the saved project', async t => {
  const h = fixture(t, { image, save: () => ({ ok: false, error: 'Static SVG required' }) });
  const bytes = Uint8Array.from(Buffer.from('<svg onload="alert(1)"/>'));
  await h.pick({ type: 'image/svg+xml', name: 'bad.svg', size: bytes.length, arrayBuffer: async () => bytes.buffer });
  h.submit(); await tick();
  assert.equal(nodes(h.render()).find(node => node.props.role === 'alert').props.children, 'Static SVG required');
  assert.equal(h.closed(), 0); assert.equal(h.project.image, image); assert.deepEqual(h.decoded, []);
});

test('a newer file wins over an older decode and a decode completing after cancel is ignored', async t => {
  const first = deferred(), second = deferred(), h = fixture(t, { decode: file => file.name === 'first' ? first.promise : second.promise });
  await h.pick({ type: 'image/png', size: 24, name: 'first' });
  await h.pick({ type: 'image/png', size: 24, name: 'second' });
  second.resolve('new-image'); await tick(); first.resolve('old-image'); await tick();
  assert.equal(nodes(h.render()).find(node => node.type === 'img').props.src, 'new-image');
  const late = deferred(), canceled = fixture(t, { decode: () => late.promise });
  await canceled.pick(); canceled.button('取消').props.onClick(); canceled.unmount(); late.resolve('late-image'); await tick();
  assert.equal(nodes(canceled.render()).some(node => node.type === 'img'), false); assert.deepEqual(canceled.calls, []);
});

test('Escape consumes the dialog cancel event without persisting or allowing the native event to close another surface', t => {
  const h = fixture(t, { image }); let prevented = false, stopped = false;
  h.render().props.onCancel({ preventDefault() { prevented = true; }, stopPropagation() { stopped = true; } });
  assert.ok(prevented); assert.ok(stopped); assert.equal(h.closed(), 1); assert.deepEqual(h.calls, []);
});

const candidate = (file = 'assets/icon.png', source = 'icon', image = 'data:image/png;base64,Y2FuZGlkYXRl') => ({ path: file, source, image });
const listing = candidates => ({ ok: true, value: { candidates } });
const candidateButtons = h => nodes(h.render()).filter(node => node.type === 'button' && node.props.className === 'project-image-candidate');
const preview = h => nodes(h.render()).find(node => node.type === 'div' && node.props.className === 'project-image-preview').props.children;

test('opening scans once, lists bounded candidates with sources, and keeps the original saved image', async t => {
  const choices = [candidate(), candidate('docs/demo.png', 'readme'), candidate('public/banner.jpg', 'asset'), ...Array.from({ length: 5 }, (_, i) => candidate(`images/${i}.png`))];
  const h = fixture(t, { image, scan: () => listing(choices) });
  h.render(); await tick();
  assert.deepEqual(h.scans, [['project-1']]);
  assert.equal(candidateButtons(h).length, 6); assert.equal(preview(h).props.src, image);
  assert.ok(candidateButtons(h).every(node => node.props['aria-pressed'] === false));
  assert.equal(candidateButtons(h)[0].props['aria-label'], '使用项目图片：assets/icon.png');
  for (const text of ['图标文件', 'README 引用', '项目素材']) assert.ok(nodes(h.render()).some(node => node.props.children === text));
  assert.equal(h.button('保存').props.disabled, true); assert.deepEqual(h.calls, []);
});

test('clicking a candidate only stages its static snapshot until explicit save', async t => {
  const choice = candidate(), h = fixture(t, { scan: () => listing([choice]) });
  h.render(); await tick(); candidateButtons(h)[0].props.onClick();
  assert.equal(preview(h).props.src, choice.image); assert.equal(candidateButtons(h)[0].props['aria-pressed'], true);
  assert.deepEqual(h.calls, []); assert.equal(h.project.image, undefined);
  h.submit(); await tick(); assert.deepEqual(h.calls, [['project-1', choice.image, 'custom']]); assert.equal(h.closed(), 1);
});

test('refreshing candidates preserves a staged choice even when the source file has changed', async t => {
  const old = candidate(), updated = candidate(old.path, old.source, 'data:image/png;base64,bmV3'); let scans = 0;
  const h = fixture(t, { scan: () => listing([++scans === 1 ? old : updated]) });
  h.render(); await tick(); candidateButtons(h)[0].props.onClick();
  h.button('重新查找').props.onClick(); await tick();
  assert.equal(h.scans.length, 2); assert.equal(preview(h).props.src, old.image);
  assert.equal(candidateButtons(h)[0].props['aria-pressed'], false); assert.deepEqual(h.calls, []);
});

test('late scan results do not replace a manual selection or prevent saving while scanning', async t => {
  const pending = deferred(), h = fixture(t, { scan: () => pending.promise });
  h.render(); await h.pick();
  assert.equal(h.button('保存').props.disabled, false); assert.equal(preview(h).props.src, image);
  pending.resolve(listing([candidate()])); await tick();
  assert.equal(preview(h).props.src, image); assert.deepEqual(h.calls, []);
});

test('a superseded scan cannot replace newer candidates or a staged image', async t => {
  const first = deferred(), second = deferred(); let count = 0;
  const choice = candidate('new/icon.png'), h = fixture(t, { image, scan: () => ++count === 1 ? first.promise : second.promise });
  h.render(); h.button('重新查找').props.onClick();
  second.resolve(listing([choice])); await tick(); candidateButtons(h)[0].props.onClick();
  first.resolve(listing([candidate('old/icon.png')])); await tick();
  assert.equal(candidateButtons(h)[0].props.title, choice.path); assert.equal(preview(h).props.src, choice.image); assert.deepEqual(h.calls, []);
});

test('a candidate selection wins over an older manual decode', async t => {
  const pending = deferred(), choice = candidate(), h = fixture(t, { scan: () => listing([choice]), decode: () => pending.promise });
  h.render(); await tick(); await h.pick(); candidateButtons(h)[0].props.onClick();
  pending.resolve('late-manual-image'); await tick();
  assert.equal(preview(h).props.src, choice.image); assert.equal(h.button('保存').props.disabled, false);
});

test('cancel, Escape and unmount ignore pending scans without saving or changing the original picture', async t => {
  for (const method of ['cancel', 'escape', 'unmount']) {
    const pending = deferred(), h = fixture(t, { image, scan: () => pending.promise });
    h.render();
    if (method === 'cancel') h.button('取消').props.onClick();
    else if (method === 'escape') h.render().props.onCancel({ preventDefault() {}, stopPropagation() {} });
    else h.unmount();
    pending.resolve(listing([candidate()])); await tick();
    assert.equal(candidateButtons(h).length, 0); assert.equal(preview(h).props.src, image); assert.deepEqual(h.calls, []);
  }
});

test('empty results and SSH projects explain manual selection without changing the saved image', async t => {
  for (const [value, text] of [
    [{ candidates: [] }, '没有找到合适的图片，可以自行选择。'],
    [{ candidates: [], unavailable: 'ssh' }, '远程项目暂不自动查找图片，可以选择本机图片。'],
  ]) {
    const h = fixture(t, { image, scan: () => ({ ok: true, value }) }); h.render(); await tick();
    assert.ok(nodes(h.render()).some(node => node.props.children === text));
    assert.equal(preview(h).props.src, image); assert.equal(h.button('更换图片').props.disabled, false); assert.deepEqual(h.calls, []);
  }
});

test('scan errors are bounded, retryable, and independent of manual upload', async t => {
  for (const failure of [() => ({ ok: false, error: 'sensitive long backend diagnostic' }), () => { throw new Error('untrusted path'); }]) {
    let failed = true;
    const h = fixture(t, { scan: () => failed ? failure() : listing([candidate()]) });
    h.render(); await tick();
    assert.equal(nodes(h.render()).find(node => node.props.role === 'alert').props.children, '未能查找项目图片，请重试');
    await h.pick(); assert.equal(preview(h).props.src, image);
    failed = false; h.button('重新查找').props.onClick(); await tick();
    assert.equal(nodes(h.render()).some(node => node.props.role === 'alert'), false); assert.equal(candidateButtons(h).length, 1);
    assert.equal(preview(h).props.src, image); assert.deepEqual(h.calls, []);
  }
});

test('an untouched dialog follows a background automatic assignment without creating a draft', async t => {
  const h = fixture(t);
  h.render(); await tick();
  h.project.image = image; h.project.imageMode = 'auto'; h.render();
  assert.equal(preview(h).props.src, image);
  assert.equal(h.button('保存').props.disabled, true);
  h.project.imageMode = 'custom'; h.render();
  assert.equal(h.button('保存').props.disabled, true); assert.deepEqual(h.calls, []);
});

test('background project updates never replace an edited preview or its custom mode', async t => {
  const choice = candidate(), h = fixture(t, { scan: () => listing([choice]) });
  h.render(); await tick(); candidateButtons(h)[0].props.onClick();
  h.project.image = 'background-image'; h.project.imageMode = 'auto'; h.render();
  assert.equal(preview(h).props.src, choice.image);
  h.submit(); await tick(); assert.deepEqual(h.calls, [['project-1', choice.image, 'custom']]);
});

test('choosing the same automatic snapshot manually is a mode-only change', async t => {
  const choice = candidate(), h = fixture(t, { image: choice.image, mode: 'auto', scan: () => listing([choice]) });
  h.render(); await tick(); assert.equal(h.button('保存').props.disabled, true);
  candidateButtons(h)[0].props.onClick(); assert.equal(h.button('保存').props.disabled, false);
  h.submit(); await tick(); assert.deepEqual(h.calls, [['project-1', choice.image, 'custom']]);
});

test('restoring an empty automatic project explicitly opts into numbering', async t => {
  const h = fixture(t); h.render(); await tick();
  assert.equal(h.button('恢复原样').props.disabled, false); h.button('恢复原样').props.onClick();
  assert.equal(h.button('保存').props.disabled, false); h.submit(); await tick();
  assert.deepEqual(h.calls, [['project-1', '', 'number']]);
});

test('automatic selection refetches candidates and stages only the first ranked icon until save', async t => {
  const first = candidate('public/icon.png'), second = candidate('docs/screenshot.png', 'readme', 'second-image');
  const h = fixture(t, { image, scan: () => listing([first, second]) });
  h.render(); await tick(); h.button('重新自动选择').props.onClick(); await tick();
  assert.equal(h.scans.length, 2); assert.equal(preview(h).props.src, first.image);
  assert.equal(h.project.image, image); assert.deepEqual(h.calls, []);
  h.submit(); await tick(); assert.deepEqual(h.calls, [['project-1', first.image, 'auto']]);
});

test('automatic selection with no candidates permits a mode-only save from numbering', async t => {
  const h = fixture(t, { mode: 'number' }); h.render(); await tick();
  h.button('重新自动选择').props.onClick(); await tick();
  assert.equal(preview(h).type, 'span'); assert.equal(h.button('保存').props.disabled, false);
  h.submit(); await tick(); assert.deepEqual(h.calls, [['project-1', '', 'auto']]);
});

test('automatic reselection ignores screenshots and assets but leaves them available for manual choice', async t => {
  const choices = [candidate('docs/demo.png', 'readme'), candidate('img/dog.png', 'asset')];
  const h = fixture(t, { image, mode: 'custom', scan: () => listing(choices) });
  h.render(); await tick(); h.button('重新自动选择').props.onClick(); await tick();
  assert.equal(preview(h).type, 'span'); assert.equal(candidateButtons(h).length, 2);
  h.submit(); await tick(); assert.deepEqual(h.calls, [['project-1', '', 'auto']]);
});

test('reselecting an already empty automatic project creates no redundant save', async t => {
  const h = fixture(t); h.render(); await tick(); h.button('重新自动选择').props.onClick(); await tick();
  assert.equal(h.button('保存').props.disabled, true); h.submit(); await tick(); assert.deepEqual(h.calls, []);
});

test('a manual candidate wins over a late automatic selection result', async t => {
  const pending = deferred(), manual = candidate('manual.png'), automatic = candidate('automatic.png', 'icon', 'automatic-image'); let scans = 0;
  const h = fixture(t, { scan: () => ++scans === 1 ? listing([manual]) : pending.promise });
  h.render(); await tick(); h.button('重新自动选择').props.onClick();
  candidateButtons(h)[0].props.onClick(); pending.resolve(listing([automatic])); await tick();
  assert.equal(preview(h).props.src, manual.image); assert.equal(h.button('保存').props.disabled, false);
  h.submit(); await tick(); assert.deepEqual(h.calls, [['project-1', manual.image, 'custom']]);
});

test('canceling ignores a late automatic choice and never persists it', async t => {
  const pending = deferred(); let scans = 0;
  const h = fixture(t, { image, scan: () => ++scans === 1 ? listing([]) : pending.promise });
  h.render(); await tick(); h.button('重新自动选择').props.onClick(); h.button('取消').props.onClick();
  pending.resolve(listing([candidate()])); await tick();
  assert.equal(preview(h).props.src, image); assert.deepEqual(h.calls, []); assert.equal(h.closed(), 1);
});

test('a background update alone cannot be submitted before the preview-sync effect settles', async t => {
  const h = fixture(t); h.render(); await tick();
  h.project.image = image; h.project.imageMode = 'auto'; h.submit(); await tick();
  assert.equal(preview(h).props.src, image); assert.equal(h.button('保存').props.disabled, true); assert.deepEqual(h.calls, []);
});

test('failed or invalid choices do not freeze an untouched preview against later automatic updates', async t => {
  for (const failure of ['invalid-file', 'decode', 'automatic']) {
    let scans = 0;
    const h = fixture(t, {
      decode: () => { throw new Error('Decode failed'); },
      scan: () => ++scans === 1 ? listing([]) : { ok: false, error: 'Scan failed' },
    });
    h.render(); await tick();
    if (failure === 'automatic') { h.button('重新自动选择').props.onClick(); await tick(); }
    else await h.pick({ type: failure === 'invalid-file' ? 'image/tiff' : 'image/png', size: 24 });
    assert.ok(nodes(h.render()).some(node => node.props.role === 'alert'));
    h.project.image = image; h.project.imageMode = 'auto'; h.render();
    assert.equal(preview(h).props.src, image); assert.equal(h.button('保存').props.disabled, true);
    h.submit(); await tick(); assert.deepEqual(h.calls, []);
  }
});
