const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { registerMacTitlebar } = require('../electron/app/mac-titlebar.cjs');
const { createIpcAdapter } = require('../electron/shared/ipc.cjs');
const { translate, en } = require('../electron/i18n.cjs');
const { buildMacTitlebar } = require('../scripts/build-mac-titlebar.cjs');

const root = path.join(__dirname, '..');
const binary = path.join(root, 'native/mac-titlebar/build/Release/mac_titlebar.node');
const script = path.join(root, 'scripts/build-mac-titlebar.cjs');
const workspaceTooltip = language => translate(language,
  en['回到工作台 · {key}'] ? '回到工作台 · {key}' : '工作台', { key: 'Ctrl+Shift+G' });
const main = ts.createSourceFile('main.cjs', fs.readFileSync(path.join(root, 'electron/main.cjs'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const mainFunction = name => main.statements.find(node => ts.isFunctionDeclaration(node) && node.name.text === name);
const templateIcon = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=';

function styleFixture() {
  return { scale: 1, font: { size: 13, weight: 600, family: "'PingFang SC', sans-serif" },
    metrics: { height: 28, paddingX: 12, gap: 6, itemGap: 4, radius: 8, iconSize: 16, focusWidth: 2, focusOffset: 2, barHeight: 40,
      badge: { minWidth: 18, paddingX: 5, height: 17, fontSize: 11, fontWeight: 600 } },
    colors: { text: '#b5b5b5', textSelected: '#f2f2f2', hover: '#343434', selected: '#383838',
      badge: '#e5e5e5', badgeText: '#181818', focus: '#d0d0d0' },
    icons: { decisions: templateIcon, workspace: templateIcon } };
}

function fixture(options = {}) {
  const updates = [], messages = [], warnings = [], lights = [];
  let click, detached = 0, attached = 0, broadcasts = 0, language = 'en', failure;
  const handle = Buffer.alloc(8);
  const frame = { url: 'agentrix://app/index.html' };
  const window = Object.assign(new EventEmitter(), {
    getNativeWindowHandle: () => handle, isDestroyed: () => false,
    getWindowButtonPosition: () => ({ x: 16, y: 12 }), setWindowButtonPosition: position => lights.push(position),
    webContents: { mainFrame: frame },
  });
  const addon = {
    attach: (value, callback) => { assert.equal(value, handle); attached++; click = callback; },
    update: value => { if (failure) throw failure; updates.push(value); },
    detach: () => detached++,
  };
  const controller = registerMacTitlebar({ window, platform: 'darwin',
    t: (text, values) => translate(language, text, values), send: (...args) => messages.push(args),
    broadcast: () => broadcasts++, loadAddon: () => addon, warn: message => warnings.push(message), ...options });
  return { controller, window, addon, updates, messages, warnings, lights, click: id => click(id),
    setLanguage: value => { language = value; }, fail: () => { failure = new Error('update failed'); },
    get attached() { return attached; }, get detached() { return detached; }, get broadcasts() { return broadcasts; } };
}

test('attach publishes native availability only after initializing both translated buttons', () => {
  const f = fixture();
  assert.equal(f.attached, 1);
  assert.equal(f.controller.attached, true);
  assert.deepEqual(f.updates, [{ items: [
    { id: 'decisions', label: 'Decide', count: 0, selected: false,
      toolTip: 'Back to decisions · Ctrl+Shift+D', accessibilityLabel: 'Decide, 0 to decide' },
    { id: 'workspace', label: 'Workbench', selected: true, toolTip: workspaceTooltip('en'), accessibilityLabel: 'Workbench' },
  ] }]);
  assert.equal(f.broadcasts, 0, 'the initial workspace snapshot already contains availability');
  assert.deepEqual(f.warnings, []);
});

test('validated state updates count and selection; identical snapshots and extra fields do not update native controls', () => {
  const f = fixture();
  for (const value of [undefined, null, {}, [], 'workspace', { view: 'other', decisions: 1 },
    ...[-1, 0.5, NaN, Infinity, '2', Number.MAX_SAFE_INTEGER + 1].map(decisions => ({ view: 'decisions', decisions }))]) {
    f.controller.update(value);
  }
  assert.equal(f.updates.length, 1);
  f.controller.update({ view: 'decisions', decisions: 2, ignored: true });
  assert.deepEqual(f.updates.at(-1), { items: [
    { id: 'decisions', label: 'Decide', count: 2, selected: true,
      toolTip: 'Back to decisions · Ctrl+Shift+D', accessibilityLabel: 'Decide, 2 to decide' },
    { id: 'workspace', label: 'Workbench', selected: false, toolTip: workspaceTooltip('en'), accessibilityLabel: 'Workbench' },
  ] });
  f.controller.update({ view: 'decisions', decisions: 2 });
  f.controller.refresh();
  assert.equal(f.updates.length, 2);
  f.controller.update({ view: 'workspace', decisions: 0 });
  assert.equal(f.updates.at(-1).items[0].count, 0, 'zero hides the badge');
});

test('style can arrive after attachment without a state change; equivalent styles are sent only once', () => {
  const f = fixture(), style = styleFixture();
  assert.equal('style' in f.updates[0], false, 'startup keeps the system appearance');
  f.controller.update({ view: 'workspace', decisions: 0, style });
  assert.deepEqual(f.updates[1].style, style);
  assert.equal(f.controller.attached, true);
  const equivalent = styleFixture();
  equivalent.colors.textSelected = '#F2F2F2';
  equivalent.metrics.ignored = 123;
  equivalent.ignored = true;
  f.controller.update({ view: 'workspace', decisions: 0, style: equivalent });
  f.controller.refresh();
  assert.equal(f.updates.length, 2);
  assert.equal(f.broadcasts, 0);
});

test('the traffic lights centre on the page title bar at its zoom, in Electron and the addon alike', () => {
  const f = fixture(), style = styleFixture();
  f.controller.update({ view: 'workspace', decisions: 0, style });
  assert.deepEqual(f.updates.at(-1).lights, { x: 16, y: 13 }, 'a 40pt bar: 13 + 14 + 13');
  assert.deepEqual(f.lights, [{ x: 16, y: 13 }]);
  f.controller.update({ view: 'decisions', decisions: 1 });
  assert.equal('lights' in f.updates.at(-1), false, 'state alone does not move them');
  f.controller.update({ view: 'decisions', decisions: 1, style: { ...style, scale: 0.9 } });
  assert.deepEqual(f.updates.at(-1).lights, { x: 16, y: 11 }, 'a 36pt bar at 90%');
  const update = f.addon.update;
  f.addon.update = value => { update(value); return false; };
  f.controller.update({ view: 'decisions', decisions: 1, style: { ...style, scale: 0.8 } });
  assert.deepEqual(f.lights, [{ x: 16, y: 13 }, { x: 16, y: 11 }], 'a rejected style leaves Electron where the addon is');
  for (const barHeight of [0, -1, 65, undefined]) {
    f.controller.update({ view: 'workspace', decisions: 0, style: { ...style, metrics: { ...style.metrics, barHeight } } });
  }
  assert.equal(f.lights.length, 2, 'a style without a usable bar height is not accepted');
});

test('switching pages only flips selection, preserving labels, counts and the cached style', () => {
  const f = fixture();
  f.controller.update({ view: 'workspace', decisions: 0, style: styleFixture() });
  const geometry = items => items.map(({ selected, ...item }) => item);
  const initial = geometry(f.updates.at(-1).items);
  for (const view of ['decisions', 'workspace', 'decisions', 'workspace']) {
    f.controller.update({ view, decisions: 0 });
    const update = f.updates.at(-1);
    assert.deepEqual(geometry(update.items), initial);
    assert.equal(update.items.find(item => item.id === view).selected, true);
    assert.equal('style' in update, false);
  }
});

test('state and language updates reuse native style; theme and zoom changes resend it without rescaling the metrics', () => {
  const f = fixture();
  f.controller.update({ view: 'workspace', decisions: 0, style: styleFixture() });
  f.controller.update({ view: 'decisions', decisions: 8 });
  assert.equal('style' in f.updates.at(-1), false);
  assert.equal(f.updates.at(-1).items[0].count, 8);
  assert.equal(f.updates.at(-1).items[0].label, 'Decide');
  f.setLanguage('zh'); f.controller.refresh();
  assert.equal('style' in f.updates.at(-1), false);
  assert.equal(f.updates.at(-1).items[0].label, '决策');
  const style = styleFixture();
  style.scale = 0.8;
  style.colors.selected = '#e9ebef';
  f.controller.update({ view: 'decisions', decisions: 8, style });
  assert.deepEqual(f.updates.at(-1).style, style);
  assert.equal(f.updates.at(-1).style.metrics.height, 28, 'only native drawing applies scale');
  f.controller.update({ view: 'decisions', decisions: 8 });
  assert.equal(f.updates.length, 5);
});

test('cached style is an owned snapshot and normalizes canonical CSS hex case and alpha', () => {
  const f = fixture(), style = styleFixture();
  style.colors.text = '#AABBCC'; style.colors.focus = '#aAbBcCdD'; style.colors.hover = '#12345678';
  f.controller.update({ view: 'workspace', decisions: 0, style });
  const sent = f.updates.at(-1).style;
  assert.equal(sent.colors.text, '#aabbcc');
  assert.equal(sent.colors.focus, '#aabbccdd');
  assert.equal(sent.colors.hover, '#12345678');
  style.metrics.badge.height = 0; style.font.size = 0; style.colors.text = 'red'; style.icons.workspace = '';
  f.controller.refresh();
  assert.equal(f.updates.length, 2);
  assert.equal(sent.metrics.badge.height, 17);
  assert.equal(sent.font.size, 13);
  assert.equal(sent.icons.workspace, templateIcon);
});

test('malformed styles preserve the cached appearance while valid navigation and counts continue', () => {
  const f = fixture();
  f.controller.update({ view: 'workspace', decisions: 0, style: styleFixture() });
  const mutations = [
    style => { delete style.font; }, style => { style.font = []; },
    ...[0, 0.49, -1, NaN, Infinity, 2.01, '1'].map(scale => style => { style.scale = scale; }),
    ...[0, -1, NaN, 65, '13'].map(size => style => { style.font.size = size; }),
    ...[0, 99, 901, '600'].map(weight => style => { style.font.weight = weight; }),
    ...[undefined, null, 1, '', ' '.repeat(3), 'x'.repeat(1025)].map(family => style => { style.font.family = family; }),
    style => { delete style.metrics.focusWidth; }, style => { delete style.metrics.focusOffset; },
    style => { style.metrics.gap = -1; }, style => { style.metrics.height = 0; },
    style => { style.metrics.height = 65; },
    style => { style.metrics.iconSize = Infinity; }, style => { style.metrics.badge = []; },
    style => { style.metrics.badge.fontSize = 0; }, style => { style.metrics.badge.paddingX = -1; },
    style => { style.metrics.badge.minWidth = 65; },
    ...[undefined, 99, 901, '600'].map(weight => style => { style.metrics.badge.fontWeight = weight; }),
    style => { style.colors.focus = 'var(--focus-ring)'; }, style => { style.colors.text = '#12345'; },
    style => { delete style.colors.badge; }, style => { style.colors = []; },
    style => { style.colors.text = '#abc'; }, style => { style.colors.focus = '#abcd'; },
    style => { style.icons = null; }, style => { style.icons.workspace = '/tmp/icon.png'; },
    style => { style.icons.decisions = 'data:image/svg+xml;base64,PHN2Zy8+'; },
    style => { style.icons.decisions = 'data:image/png;base64,bm90IGEgcG5n'; },
    style => { style.icons.decisions += '!'; },
    style => { style.icons.decisions = `data:image/png;base64,${'A'.repeat(64 * 1024)}`; },
    style => {
      const data = Buffer.from(templateIcon.split(',')[1], 'base64');
      data.writeUInt32BE(257, 16);
      style.icons.decisions = `data:image/png;base64,${data.toString('base64')}`;
    },
  ];
  const invalid = [null, [], 1, {}, ...mutations.map(mutate => {
    const style = styleFixture(); mutate(style); return style;
  })];
  invalid.forEach((style, index) => {
    f.controller.update({ view: 'decisions', decisions: index + 1, style });
    const sent = f.updates.at(-1);
    assert.equal(sent.items[0].count, index + 1);
    assert.equal('style' in sent, false, `invalid style ${index} must not replace the cached style`);
  });
  const updates = f.updates.length;
  f.controller.update({ view: 'decisions', decisions: invalid.length, style: styleFixture() });
  assert.equal(f.updates.length, updates, 'the original cached style remains current');
  assert.equal(f.controller.attached, true);
  assert.deepEqual(f.warnings, []);
});

test('validation accepts the app zoom endpoints, maximum metric and independent font weights', () => {
  const f = fixture();
  for (const scale of [0.5, 2]) {
    const style = styleFixture();
    style.scale = scale; style.metrics.height = 64;
    style.font.weight = 900; style.metrics.badge.fontWeight = 100;
    f.controller.update({ view: 'workspace', decisions: 0, style });
    assert.deepEqual(f.updates.at(-1).style, style);
  }
});

test('a PNG rejected by the native decoder does not replace the last accepted style', () => {
  const f = fixture(), previous = styleFixture();
  f.controller.update({ view: 'workspace', decisions: 0, style: previous });
  const update = f.addon.update;
  f.addon.update = value => { update(value); return false; };
  const next = styleFixture(); next.colors.text = '#24272d';
  f.controller.update({ view: 'decisions', decisions: 1, style: next });
  f.addon.update = update;
  const updates = f.updates.length;
  f.controller.update({ view: 'decisions', decisions: 1, style: previous });
  assert.equal(f.updates.length, updates, 'the previous style remains cached');
  f.controller.update({ view: 'workspace', decisions: 2 });
  assert.equal('style' in f.updates.at(-1), false);
  assert.equal(f.controller.attached, true);
});

test('invalid initial style keeps startup usable and does not prevent a later valid style', () => {
  const f = fixture();
  f.controller.update({ view: 'decisions', decisions: 1, style: {} });
  assert.equal('style' in f.updates.at(-1), false);
  f.controller.update({ view: 'decisions', decisions: 1, style: styleFixture() });
  assert.deepEqual(f.updates.at(-1).style, styleFixture());
  assert.equal(f.controller.attached, true);
});

test('failure applying the first style restores web navigation even when state has not changed', () => {
  const f = fixture();
  f.fail();
  f.controller.update({ view: 'workspace', decisions: 0, style: styleFixture() });
  assert.equal(f.controller.attached, false);
  assert.equal(f.detached, 1);
  assert.equal(f.broadcasts, 1);
});

test('clicks request navigation without selecting a page that a dialog may reject', () => {
  const f = fixture();
  f.click('decisions'); f.click('workspace'); f.click('settings');
  assert.deepEqual(f.messages, [['titlebar:navigate', 'decisions'], ['titlebar:navigate', 'workspace']]);
  assert.equal(f.updates.length, 1);
  assert.equal(f.updates[0].items[1].selected, true);
  f.window.isDestroyed = () => true;
  f.click('decisions');
  assert.equal(f.messages.length, 2);
});

test('language changes refresh the latest count and selected page through the real settings function', () => {
  const f = fixture();
  f.controller.update({ view: 'decisions', decisions: 3 });
  const store = { settings: { language: 'en' }, updateSettings(patch) { Object.assign(this.settings, patch); } };
  const context = vm.createContext({ store, macTitlebar: f.controller, process: { platform: 'darwin' },
    trayMenu() {}, rebuildMacMenu() {} });
  vm.runInContext(mainFunction('updateStoreSettings').getText(main), context);
  f.setLanguage('zh');
  context.updateStoreSettings({ language: 'zh' });
  assert.deepEqual(f.updates.at(-1), { items: [
    { id: 'decisions', label: '决策', count: 3, selected: true,
      toolTip: '回到决策 · Ctrl+Shift+D', accessibilityLabel: '决策, 3 件待决定' },
    { id: 'workspace', label: '工作台', selected: false, toolTip: workspaceTooltip('zh'), accessibilityLabel: '工作台' },
  ] });
  context.updateStoreSettings({ language: 'zh' });
  assert.equal(f.updates.length, 3);
});

test('shortcut settings refresh native hints without changing the selected page or count', () => {
  const store = { settings: { shortcuts: { decisions: 'Alt+D' } }, updateSettings(patch) { Object.assign(this.settings, patch); } };
  const f = fixture({ getShortcuts: () => store.settings.shortcuts });
  f.controller.update({ view: 'decisions', decisions: 4 });
  assert.equal(f.updates.at(-1).items[0].toolTip, 'Back to decisions · Alt+D');
  const context = vm.createContext({ store, macTitlebar: f.controller, process: { platform: 'darwin' }, rebuildMacMenu() {} });
  vm.runInContext(mainFunction('updateStoreSettings').getText(main), context);
  context.updateStoreSettings({ shortcuts: { decisions: 'Ctrl+Alt+D' } });
  const item = f.updates.at(-1).items[0];
  assert.equal(item.toolTip, 'Back to decisions · Ctrl+Alt+D');
  assert.equal(item.accessibilityLabel, 'Decide, 4 to decide');
  assert.equal(item.selected, true);
  assert.equal(f.updates.length, 3);
  context.updateStoreSettings({ shortcuts: { decisions: 'Ctrl+Alt+D' } });
  assert.equal(f.updates.length, 3);
});

test('the workbench falls back to its label, then uses its overview shortcut when translated', t => {
  const key = '回到工作台 · {key}', previous = en[key];
  t.after(() => { if (previous === undefined) delete en[key]; else en[key] = previous; });
  delete en[key];
  const f = fixture({ getShortcuts: () => ({ overview: 'Alt+G' }) });
  assert.equal(f.updates[0].items[1].toolTip, 'Workbench');
  en[key] = 'Back to workbench · {key}';
  f.controller.refresh();
  assert.equal(f.updates.at(-1).items[1].toolTip, 'Back to workbench · Alt+G');
  f.setLanguage('zh'); f.controller.refresh();
  assert.equal(f.updates.at(-1).items[1].toolTip, '回到工作台 · Alt+G');
});

test('closing releases the addon once and ignores queued clicks and subsequent state updates', () => {
  const f = fixture();
  f.window.emit('closed'); f.window.emit('closed');
  f.click('decisions');
  f.controller.update({ view: 'decisions', decisions: 1 });
  f.controller.refresh();
  assert.equal(f.detached, 1);
  assert.equal(f.controller.attached, false);
  assert.equal(f.updates.length, 1);
  assert.deepEqual(f.messages, []);
});

test('missing, invalid or failed addons retain web navigation and warn only once', () => {
  for (const loadAddon of [() => { throw new Error('missing binary'); }, () => ({}), () => null,
    () => ({ attach() { throw new Error('attach failed'); }, update() {}, detach() {} }),
    () => ({ attach() {}, update() { throw new Error('initial update failed'); }, detach() {} })]) {
    const f = fixture({ loadAddon });
    assert.equal(f.controller.attached, false);
    f.controller.update({ view: 'decisions', decisions: 1 }); f.controller.refresh();
    assert.equal(f.warnings.length, 1);
    assert.match(f.warnings[0], /using web navigation/);
    assert.equal(f.broadcasts, 0);
  }
});

test('a runtime update failure detaches and broadcasts availability so the web buttons return', () => {
  const f = fixture();
  f.fail();
  f.controller.update({ view: 'decisions', decisions: 1 });
  f.controller.refresh(); f.window.emit('closed'); f.click('decisions');
  assert.equal(f.controller.attached, false);
  assert.equal(f.detached, 1);
  assert.equal(f.broadcasts, 1);
  assert.equal(f.warnings.length, 1);
  assert.deepEqual(f.messages, []);
});

test('Windows and Linux never load or attach the macOS binary', () => {
  for (const platform of ['win32', 'linux']) {
    const f = fixture({ platform, loadAddon: () => assert.fail('must not load the addon') });
    f.controller.update({ view: 'decisions', decisions: 1 }); f.controller.refresh();
    assert.equal(f.controller.attached, false);
    assert.equal(f.window.listenerCount('closed'), 0);
    assert.deepEqual(f.warnings, []);
    assert.deepEqual(f.updates, []);
  }
});

test('titlebar state uses the main-frame IPC guard and is registered only on macOS', () => {
  const statement = mainFunction('registerIpc').body.statements.find(node => ts.isIfStatement(node) && node.getText(main).includes('titlebar:state'));
  assert.ok(statement);
  for (const platform of ['darwin', 'win32', 'linux']) {
    const f = fixture(), ipcMain = new EventEmitter(), errors = [];
    const { listen } = createIpcAdapter({ ipcMain, getWindow: () => f.window, report: error => errors.push(error) });
    vm.runInNewContext(statement.getText(main), { process: { platform }, macTitlebar: f.controller, listen });
    assert.equal(ipcMain.listenerCount('titlebar:state'), platform === 'darwin' ? 1 : 0);
    const event = { sender: f.window.webContents, senderFrame: f.window.webContents.mainFrame };
    ipcMain.emit('titlebar:state', { ...event, senderFrame: { url: 'agentrix://app/preview' } }, { view: 'decisions', decisions: 5 });
    assert.equal(f.updates.length, 1);
    ipcMain.emit('titlebar:state', event, { view: 'decisions', decisions: 5 });
    assert.equal(f.updates.length, platform === 'darwin' ? 2 : 1);
    assert.equal(errors.length, platform === 'darwin' ? 1 : 0);
  }
});

test('preload sends state and exposes an unsubscribable navigation listener without leaking the event', () => {
  const ipcRenderer = new EventEmitter(), messages = [];
  ipcRenderer.send = (...args) => messages.push(args);
  let bridge;
  vm.runInNewContext(fs.readFileSync(path.join(root, 'electron/preload.cjs'), 'utf8'), {
    require: name => { assert.equal(name, 'electron'); return { ipcRenderer,
      contextBridge: { exposeInMainWorld: (name, value) => { assert.equal(name, 'agentrix'); bridge = value; } } }; },
  });
  const state = { view: 'decisions', decisions: 4 }, pages = [];
  bridge.setTitlebarState(state);
  assert.deepEqual(messages, [['titlebar:state', state]]);
  const unsubscribe = bridge.onTitlebarNavigate(page => pages.push(page));
  ipcRenderer.emit('titlebar:navigate', { secret: true }, 'decisions');
  unsubscribe(); ipcRenderer.emit('titlebar:navigate', {}, 'workspace');
  assert.deepEqual(pages, ['decisions']);
  assert.equal(ipcRenderer.listenerCount('titlebar:navigate'), 0);
});

test('workspace availability follows the controller, including addon failure and window close', () => {
  const declaration = mainFunction('publicState').body.statements[0].expression.properties.find(node => node.name?.getText(main) === 'nativeTitlebar');
  assert.ok(declaration);
  const f = fixture(), macTitlebar = f.controller;
  assert.equal(vm.runInNewContext(declaration.initializer.getText(main), { macTitlebar }), true);
  f.window.emit('closed');
  assert.equal(vm.runInNewContext(declaration.initializer.getText(main), { macTitlebar }), false);
  assert.equal(vm.runInNewContext(declaration.initializer.getText(main), { macTitlebar: null }), false);
});

test('packaging includes and unpacks only the macOS binary, keeping node-pty unpacking', () => {
  const { getFileMatchers } = require('app-builder-lib/out/fileMatcher.js');
  const config = require('../package.json').build;
  assert.equal(config.npmRebuild, false);
  for (const [name, platform] of [['mac', 'darwin'], ['win', 'win32'], ['linux', 'linux']]) {
    const options = { defaultSrc: root, globalOutDir: path.join(root, 'release'), customBuildOptions: config[name],
      macroExpander: value => value.replaceAll('${platform}', platform).replaceAll('${arch}', 'arm64') };
    const includes = (kind, file) => getFileMatchers(config, kind, path.join(root, 'release/app'), options)
      .some(matcher => matcher.createFilter()(path.join(root, file), { isDirectory: () => false }));
    const native = 'native/mac-titlebar/build/Release/mac_titlebar.node';
    assert.equal(includes('files', native), name === 'mac', name);
    assert.equal(includes('asarUnpack', native), name === 'mac', name);
    assert.equal(includes('files', 'native/mac-titlebar/titlebar.mm'), false);
    assert.equal(includes('files', 'native/mac-titlebar/build/node-include/include/node/node_api.h'), false);
    assert.equal(includes('asarUnpack', `node_modules/node-pty/prebuilds/${platform}-arm64/pty.node`), true);
  }
});

function setEnvironment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  const apply = entries => {
    for (const [key, value] of Object.entries(entries)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  };
  apply(values);
  t.after(() => apply(previous));
}

function buildFixture(t, environment = {}) {
  const buildRoot = path.join(root, 'native/mac-titlebar/build');
  fs.mkdirSync(buildRoot, { recursive: true });
  const directory = fs.mkdtempSync(path.join(buildRoot, 'test-'));
  t.after(async () => { await fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const source = path.join(directory, 'native/mac-titlebar');
  fs.mkdirSync(source, { recursive: true });
  for (const file of ['binding.gyp', 'titlebar.mm']) fs.writeFileSync(path.join(source, file), 'test source');
  const headers = path.join(directory, 'headers');
  fs.mkdirSync(path.join(headers, 'include/node'), { recursive: true });
  for (const file of ['node_api.h', 'common.gypi', 'config.gypi']) fs.writeFileSync(path.join(headers, 'include/node', file), 'test headers');
  setEnvironment(t, { npm_config_nodedir: headers, ...environment });
  return { root: directory, source, output: path.join(source, 'build/Release/mac_titlebar.node') };
}

test('build is offline with local headers, then a no-op; changed sources or architecture rebuild it', { skip: process.platform !== 'darwin' }, t => {
  const f = buildFixture(t), calls = [];
  const run = (node, args, options) => {
    if (node === '/usr/bin/xcode-select') {
      assert.deepEqual(args, ['-p']);
      assert.equal(options.stdio, 'ignore');
      return;
    }
    calls.push(args);
    assert.equal(node, process.execPath);
    assert.equal(options.cwd, f.source);
    assert.equal(options.env.PYTHONDONTWRITEBYTECODE, '1');
    assert.ok(options.env.TMPDIR.startsWith(path.join(f.source, 'build')));
    assert.ok(args.includes('--nodedir=build/node-include'));
    assert.ok(!args.includes('install'), 'local headers require no download');
    assert.equal(fs.existsSync(f.output), false, 'a rebuild discards the previous architecture and dependency files');
    fs.mkdirSync(path.dirname(f.output), { recursive: true });
    fs.writeFileSync(f.output, 'test binary');
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(f.output, future, future);
  };
  const options = { root: f.root, platform: 'darwin', arch: 'arm64', run };
  assert.equal(buildMacTitlebar(options), f.output);
  assert.equal(buildMacTitlebar(options), f.output);
  assert.equal(calls.length, 1);
  buildMacTitlebar({ ...options, arch: 'x64' });
  assert.equal(calls.length, 2);
  const past = new Date(0);
  fs.utimesSync(f.output, past, past);
  buildMacTitlebar({ ...options, arch: 'x64' });
  assert.equal(calls.length, 3);
});

test('failed rebuild removes a stale binary so optional startup uses the web fallback', { skip: process.platform !== 'darwin' }, t => {
  const f = buildFixture(t);
  fs.mkdirSync(path.dirname(f.output), { recursive: true });
  fs.writeFileSync(f.output, 'stale binary');
  assert.throws(() => buildMacTitlebar({ root: f.root, run: file => {
    if (file === process.execPath) throw new Error('compiler missing');
  } }), /compiler missing/);
  assert.equal(fs.existsSync(f.output), false);
});

test('without Xcode tools optional builds are quiet and preserve existing output; strict and CI builds fail', { skip: process.platform !== 'darwin' }, t => {
  const f = buildFixture(t), calls = [], output = [];
  setEnvironment(t, { CI: undefined });
  t.mock.method(console, 'log', text => output.push(text));
  t.mock.method(console, 'warn', text => output.push(text));
  fs.mkdirSync(path.dirname(f.output), { recursive: true });
  fs.writeFileSync(f.output, 'existing binary');
  const run = (file, args, options) => {
    calls.push(file);
    assert.equal(file, '/usr/bin/xcode-select');
    assert.deepEqual(args, ['-p']);
    assert.equal(options.stdio, 'ignore');
    throw new Error('no developer directory');
  };
  assert.equal(buildMacTitlebar({ root: f.root, optional: true, run }), undefined);
  assert.deepEqual(output, []);
  assert.deepEqual(calls, ['/usr/bin/xcode-select']);
  assert.equal(fs.readFileSync(f.output, 'utf8'), 'existing binary');
  assert.throws(() => buildMacTitlebar({ root: f.root, run }), /Xcode command-line tools/);
  process.env.CI = 'true';
  assert.throws(() => buildMacTitlebar({ root: f.root, optional: true, run }), /Xcode command-line tools/);
});

test('header downloads inherit mirror settings without a dist-url override', { skip: process.platform !== 'darwin' }, t => {
  const f = buildFixture(t, { npm_config_nodedir: undefined, npm_package_config_node_gyp_nodedir: undefined,
    NODEJS_ORG_MIRROR: undefined, npm_config_disturl: undefined }), exists = fs.existsSync;
  t.mock.method(fs, 'existsSync', file => String(file).endsWith(path.join('include/node', 'node_api.h')) ? false : exists(file));
  for (const [variable, arch] of [['NODEJS_ORG_MIRROR', 'arm64'], ['npm_config_disturl', 'x64']]) {
    process.env[variable] = 'https://headers.example.test/node/';
    const calls = [];
    buildMacTitlebar({ root: f.root, arch, run: (file, args, options) => {
      if (file === '/usr/bin/xcode-select') return;
      calls.push(args);
      assert.equal(options.env[variable], process.env[variable]);
      assert.ok(!args.some(argument => argument.startsWith('--dist-url')));
      if (args.includes('build')) {
        fs.mkdirSync(path.dirname(f.output), { recursive: true });
        fs.writeFileSync(f.output, 'test binary');
      }
    } });
    assert.equal(calls.length, 2);
    assert.ok(calls[0].includes('install'));
    assert.ok(calls[1].includes('build'));
    delete process.env[variable];
  }
});

test('the build script does nothing on Windows or Linux, including when sources are missing', () => {
  for (const platform of ['win32', 'linux']) {
    assert.equal(buildMacTitlebar({ root: '/missing-source', platform, run: () => assert.fail('must not build') }), undefined);
  }
});

test('optional build failures warn and continue, while strict builds and macOS CI fail', { skip: process.platform !== 'darwin' }, () => {
  for (const [flags, ci, status] of [[['--optional'], '', 0], [[], '', 1], [['--optional'], 'true', 1]]) {
    const result = spawnSync(process.execPath, [script, '--arch=invalid', ...flags], {
      encoding: 'utf8', env: { ...process.env, CI: ci },
    });
    assert.equal(result.status, status, result.stderr);
    assert.match(result.stderr, /Unsupported macOS architecture/);
  }
});

test('the compiled binary loads in plain Node and detached operations need no application or window', {
  skip: process.platform !== 'darwin' || !fs.existsSync(binary),
}, () => {
  const addon = require(binary);
  assert.deepEqual(Object.keys(addon).sort(), ['attach', 'detach', 'update']);
  addon.detach(); addon.detach();
  addon.update({ items: [
    { id: 'decisions', label: '决策', count: 2, selected: true, toolTip: '回到决策 · Ctrl+Shift+D', accessibilityLabel: '决策, 2 件待决定' },
    { id: 'workspace', label: '工作台', selected: false, toolTip: '工作台', accessibilityLabel: '工作台' },
  ] });
  for (const name of ['toolTip', 'accessibilityLabel']) {
    assert.throws(() => addon.update({ items: [
      { id: 'decisions', label: '决策', selected: true, [name]: 12 },
      { id: 'workspace', label: '工作台', selected: false },
    ] }), /optional text metadata/);
  }
  for (const count of [-1, 0.5, NaN, Infinity, '2', Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => addon.update({ items: [
      { id: 'decisions', label: '决策', count, selected: true },
      { id: 'workspace', label: '工作台', selected: false },
    ] }), /safe-integer count/);
  }
  assert.throws(() => addon.attach(Buffer.alloc(1), () => {}), /native window handle/);
  assert.throws(() => addon.update({ items: [] }), /decisions and workspace/);
});

test('the native style reader resolves installed families, weights, pixels and malformed styles without a window', {
  skip: process.platform !== 'darwin' || !fs.existsSync(binary),
}, () => {
  const addon = require(binary), style = styleFixture();
  const items = [
    { id: 'decisions', label: '决策', selected: false },
    { id: 'workspace', label: '工作台', selected: true },
  ];
  addon.detach();
  style.scale = 1.25;
  style.font.family = "'Agentrix Missing Font', 'PingFang SC', sans-serif";
  style.metrics.badge.fontWeight = 400;
  const result = addon.update({ items, style });
  assert.equal(result.fontFamily, 'PingFang SC');
  assert.match(result.fontName, /Semibold/i);
  assert.match(result.badgeFontName, /Regular/i);
  assert.equal(result.fontSize, 16.25);
  assert.equal(result.badgeFontSize, 13.75);
  assert.equal(result.height, 35);
  assert.equal(result.focusOutset, 5);
  assert.equal(result.iconSize, 20);
  style.font.family = "'Helvetica Neue', 'PingFang SC'";
  assert.equal(addon.update({ items, style }).fontFamily, 'Helvetica Neue', 'the first installed family wins');
  style.font.family = 'system-ui';
  const fallback = addon.update({ items, style });
  style.font.family = 'Agentrix Missing Font';
  assert.equal(addon.update({ items, style }).fontName, fallback.fontName);
  for (const mutate of [
    value => { value.scale = '1'; }, value => { value.font.family = 1; },
    value => { value.metrics = []; }, value => { value.metrics.badge.fontWeight = '600'; },
    value => { value.colors.text = 'not a color'; },
    value => { value.icons.workspace = 'data:image/png;base64,AA=='; },
  ]) {
    const invalid = styleFixture(); mutate(invalid);
    assert.equal(addon.update({ items, style: invalid }), false);
  }
  assert.equal(addon.update({ items }), undefined, 'state-only updates keep their existing return value');
  assert.throws(() => addon.attach(Buffer.alloc(8), () => {}), /initialized macOS application/);
});

test('native traffic-light offsets keep a 16 pt gap across accessory origins, zoom and selection', {
  skip: process.platform !== 'darwin' || !fs.existsSync(binary),
}, () => {
  const addon = require(binary);
  addon.detach();
  const items = [
    { id: 'decisions', label: '决策', count: 0, selected: false },
    { id: 'workspace', label: '工作台', selected: true },
  ];
  for (const scale of [0.5, 0.8, 1, 1.25, 2]) for (const count of [0, 2, 12345]) for (const pixels of [1, 2]) {
    const style = styleFixture(); style.scale = scale;
    items[0].count = count;
    for (const sample of [
      { mode: 'windowed', lightRight: 74, accessoryLeft: 0, accessoryBottom: 0 },
      { mode: 'full-screen strip', lightRight: 69, accessoryLeft: 60, accessoryBottom: 900 },
      { mode: 'windowed accessory after lights', lightRight: 74, accessoryLeft: 78, accessoryBottom: 10 },
      { mode: 'focus outline must not widen the gap', lightRight: 69, accessoryLeft: 82, accessoryBottom: 0 },
      { mode: 'screen to the left', lightRight: -1351, accessoryLeft: -1360, accessoryBottom: 750 },
      { mode: 'screen to the right', lightRight: 1429, accessoryLeft: 1420, accessoryBottom: -940 },
    ]) {
      const layout = { ...sample, height: 96, lightCenter: sample.accessoryBottom + 48, pixels };
      if (pixels === 2) {
        layout.accessoryLeft += 0.5; layout.lightRight += 0.5;
        layout.accessoryBottom += 0.5; layout.lightCenter += 0.5;
      }
      const result = addon.update({ items, style, layout });
      const [x, y, , height] = result.layout.frames[0];
      assert.equal(x + layout.accessoryLeft - layout.lightRight, 16, sample.mode);
      assert.ok(Math.abs(y + height / 2 + layout.accessoryBottom - layout.lightCenter) <= 0.5,
        `${sample.mode}: vertical alignment allows backing-pixel rounding`);
      assert.equal(result.layout.height, layout.height, 'AppKit retains control of accessory height');
      assert.deepEqual(result.selectionLayout, result.layout, 'selection must not move the items');
      assert.deepEqual(result.relayout, result.layout, 'the offset must not accumulate on relayout');
    }
  }
});

test('native layout preserves AppKit height, light alignment and frames when selection changes', {
  skip: process.platform !== 'darwin' || !fs.existsSync(binary),
}, () => {
  const addon = require(binary);
  addon.detach();
  const items = [
    { id: 'decisions', label: '决策', count: 0, selected: false },
    { id: 'workspace', label: '工作台', selected: true },
  ];
  for (const count of [0, 2, 12345]) for (const pixels of [1, 2]) for (const sample of [
    { scale: 1, height: 32, lightCenter: 16, expectedCenter: 16 },
    { scale: 1, height: 32, lightCenter: 17, expectedCenter: 17 },
    { scale: 1, height: 40, lightCenter: 19, expectedCenter: 19 },
    { scale: 1.25, height: 50, lightCenter: 19, expectedCenter: 22.5 },
    { scale: 2, height: 80, lightCenter: 19, expectedCenter: 36 },
  ]) {
    const style = styleFixture(); style.scale = sample.scale;
    items[0].count = count;
    const layout = { height: sample.height, lightRight: 74, lightCenter: sample.lightCenter, pixels };
    const result = addon.update({ items, style, layout });
    assert.deepEqual(result.selectionLayout, result.layout, 'changing native button state must not move its frame or icon');
    assert.deepEqual(result.relayout, result.layout, 'another layout pass must be a fixed point');
    assert.equal(result.layout.height, layout.height, 'a left accessory must preserve the height assigned by AppKit');
    for (const frame of result.layout.frames) {
      assert.equal(frame[1] + frame[3] / 2, sample.expectedCenter);
      assert.ok(frame[1] >= 0 && frame[1] + frame[3] <= layout.height);
    }
  }
  assert.throws(() => addon.attach(Buffer.alloc(8), () => {}), /initialized macOS application/);
});
