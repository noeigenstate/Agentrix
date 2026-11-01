const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { buildMacMenuTemplate } = require('../electron/app/mac-menu.cjs');
const { registerWindowLifecycle } = require('../electron/app/window-events.cjs');
const DEFAULT_SHORTCUTS = require('../electron/shortcuts.json');
const { translate } = require('../electron/i18n.cjs');
const { cleanSettings } = require('../electron/state.cjs');
const { registerWorkspaceIpc } = require('../electron/features/workspace/ipc.cjs');

function template(options = {}) {
  return buildMacMenuTemplate({ appName: 'Agentrix', t: (text, values) => translate('zh', text, values), ...options });
}
const labels = items => items.filter(item => item.visible !== false).map(item => item.type === 'separator' ? '─' : item.label);

test('only the Agentrix app menu is visible with the agreed items and native roles', () => {
  const menus = template();
  assert.deepEqual(labels(menus), ['Agentrix']);
  assert.equal(menus.length, 1);
  assert.deepEqual(labels(menus[0].submenu), ['关于 Agentrix', '─', '新建项目', '设置…', '虚拟实验室', '数据看板', '─', '隐藏 Agentrix', '隐藏其他', '全部显示', '─', '退出 Agentrix']);
  assert.deepEqual(menus[0].submenu.filter(item => item.visible !== false && item.role).map(item => item.role), ['about', 'hide', 'hideOthers', 'unhide']);
  assert.equal(menus[0].submenu.find(item => item.label === '退出 Agentrix').accelerator, 'Command+Q');
});

test('hidden window items retain native minimize and fullscreen roles and the custom close shortcut', () => {
  let closed = 0;
  const hidden = template({ close: () => closed++ })[0].submenu.filter(item => item.visible === false);
  assert.deepEqual(hidden.map(item => [item.role, item.accelerator]), [
    ['minimize', 'Command+M'], ['togglefullscreen', 'Control+Command+F'], [undefined, 'Command+W'],
  ]);
  for (const item of hidden) assert.notEqual(item.acceleratorWorksWhenHidden, false);
  hidden[2].click(); assert.equal(closed, 1);
});

test('ready updates appear after settings and every application item sends its exact command', () => {
  const commands = [], opened = [];
  const menus = template({ updateReady: true, command: name => commands.push(name), openLab: () => opened.push('lab'), openDashboard: () => opened.push('dashboard') });
  assert.deepEqual(labels(menus[0].submenu).slice(0, 8), ['关于 Agentrix', '─', '新建项目', '设置…', '虚拟实验室', '数据看板', '重启并安装更新', '─']);
  for (const label of ['新建项目', '设置…', '虚拟实验室', '数据看板', '重启并安装更新']) menus[0].submenu.find(item => item.label === label).click();
  assert.deepEqual(commands, ['addProject', 'settings', 'installUpdate']);
  assert.deepEqual(opened, ['lab', 'dashboard']);
});

test('the dashboard item sits after settings and calls the injected opener without sending a command', () => {
  const opened = [], commands = [];
  const items = template({ command: name => commands.push(name), openLab: () => opened.push('lab'), openDashboard: () => opened.push('dashboard') })[0].submenu;
  const settings = items.findIndex(item => item.label === '设置…'), lab = items[settings + 1], dashboard = items[settings + 2];
  assert.equal(lab.label, '虚拟实验室'); assert.equal(lab.accelerator, undefined);
  assert.equal(dashboard.label, '数据看板'); assert.equal(dashboard.accelerator, undefined);
  lab.click(); dashboard.click();
  assert.deepEqual(opened, ['lab', 'dashboard']); assert.deepEqual(commands, []);
});

test('template accelerators merge custom bindings over defaults', () => {
  const custom = { addProject: 'Alt+N', settings: 'Ctrl+Shift+S' };
  for (const shortcuts of [undefined, custom, { settings: 'Alt+S' }]) {
    const menus = template({ shortcuts, updateReady: true });
    const bindings = { ...DEFAULT_SHORTCUTS, ...shortcuts };
    for (const [item, action] of [
      [menus[0].submenu[2], 'addProject'], [menus[0].submenu[3], 'settings'],
    ]) {
      assert.equal(item.accelerator, bindings[action], action);
    }
    for (const label of ['虚拟实验室', '数据看板', '重启并安装更新']) assert.equal(menus[0].submenu.find(item => item.label === label).accelerator, undefined);
  }
});

test('all menu labels use existing English vocabulary', () => {
  const menus = template({ t: (text, values) => translate('en', text, values), updateReady: true });
  assert.deepEqual(labels(menus), ['Agentrix']);
  assert.deepEqual(labels(menus[0].submenu), ['About Agentrix', '─', 'New project', 'Settings…', 'Virtual Lab', 'Dashboard', 'Restart and install update', '─', 'Hide Agentrix', 'Hide Others', 'Show All', '─', 'Quit Agentrix']);
  for (const menu of menus) for (const item of menu.submenu) if (item.label) assert.doesNotMatch(item.label, /[一-鿿]/);
});

const filename = path.join(__dirname, '../electron/main.cjs');
const source = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const functions = new Map(source.statements.filter(ts.isFunctionDeclaration).map(node => [node.name.text, node]));
function optionCallback(callee, name) {
  let callback;
  function visit(node) {
    if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && node.expression.getText(source) === callee) {
      const property = node.arguments[0].properties.find(property => property.name?.getText(source) === name);
      callback = property?.initializer || property?.name;
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(callback, `${callee}.${name}`);
  return callback.getText(source);
}

function mainFixture(platform = 'darwin') {
  const menus = [], messages = [], handlers = new Map(), calls = { quit: 0, close: 0, show: 0, tray: 0, broadcast: 0, updates: 0 };
  const store = { settings: cleanSettings(), projects: [], updateSettings(patch) { this.settings = cleanSettings({ ...this.settings, ...patch }); } };
  const update = { status: 'idle' };
  const context = vm.createContext({ buildMacMenuTemplate, menuUpdateReady: false,
    store, t: (text, values) => translate(store.settings.language, text, values), app: { name: 'Agentrix' },
    process: { platform }, Menu: { buildFromTemplate: items => items, setApplicationMenu: menu => menus.push(menu) },
    send: (...args) => messages.push(args),
    window: { close: () => calls.close++ }, tray: undefined, dashboardWindow: null, labWindow: null, desktopGlassActive: false, windowZoom: undefined, macTitlebar: null,
    updateManager: { getState: () => update }, updatesIpc: { onStateChange: () => calls.updates++ },
    showWindow: () => calls.show++, requestQuit: async () => { calls.quit++; }, report: assert.fail,
    trayMenu: () => calls.tray++,
  });
  vm.runInContext(['macMenu', 'rebuildMacMenu', 'updateStoreSettings', 'updateIndicators'].map(name => functions.get(name).getText(source)).join('\n'), context);
  const onUpdate = vm.runInContext(`(${optionCallback('UpdateManager', 'onChange')})`, context);
  registerWorkspaceIpc({ handle: (name, handler) => handlers.set(name, handler), getSettings: () => store.settings,
    updateStoreSettings: context.updateStoreSettings, broadcast: () => calls.broadcast++, chooseVoiceModel() {} });
  return { context, store, update, onUpdate, menus, messages, handlers, calls };
}

test('real menu wiring sends commands and retains quit and close behavior', () => {
  const { context, messages, calls } = mainFixture();
  const menus = context.macMenu();
  const items = menus[0].submenu;
  items[2].click(); items[3].click();
  items.find(item => item.accelerator === 'Command+Q').click();
  items.find(item => item.accelerator === 'Command+W').click();
  assert.deepEqual(messages, [['menu:command', 'addProject'], ['menu:command', 'settings']]);
  assert.equal(calls.show, 3); assert.equal(calls.quit, 1); assert.equal(calls.close, 1);
});

test('real menu wiring opens the dashboard without showing the main window and reports failures', async () => {
  const { context, messages, calls } = mainFixture();
  for (const [label, key] of [['Dashboard', 'dashboardWindow'], ['Virtual Lab', 'labWindow']]) {
    const errors = []; let opened = 0, fail = false;
    context[key] = { open: async () => { opened++; if (fail) throw new Error('boom'); } };
    context.report = error => errors.push(error.message);
    const item = context.macMenu()[0].submenu.find(item => item.label === label);
    await item.click();
    fail = true; await item.click();
    assert.equal(opened, 2); assert.deepEqual(errors, ['boom']);
    assert.deepEqual(messages, []); assert.equal(calls.show, 0);
  }
});

test('every menu command shows a hidden window before dispatch', () => {
  const { context, update, messages } = mainFixture();
  update.status = 'ready';
  const order = []; let visible = false;
  context.window = {
    isDestroyed: () => false, isMinimized: () => false,
    show: () => { visible = true; order.push('show'); }, focus: () => order.push('focus'),
  };
  context.showWindow = vm.runInContext(`(${functions.get('showWindow').getText(source)})`, context);
  const send = context.send;
  context.send = (channel, command) => {
    assert.equal(visible, true, command);
    order.push(channel); send(channel, command);
  };
  const menu = context.macMenu();
  for (const label of ['New project', 'Settings…', 'Restart and install update']) {
    const item = menu[0].submenu.find(item => item.label === label);
    visible = false; order.length = 0;
    item.click();
    assert.deepEqual(order, ['show', 'focus', 'menu:command'], item.label);
  }
  assert.deepEqual(messages, [['menu:command', 'addProject'], ['menu:command', 'settings'], ['menu:command', 'installUpdate']]);
});

for (const platform of ['darwin', 'win32', 'linux']) test(`${platform} keeps titles owned by main and blank only in macOS fullscreen`, () => {
  assert.equal(optionCallback('registerWindowLifecycle', 'updateIndicators'), 'updateIndicators');
  const { context, store, messages } = mainFixture(platform);
  const titles = [], images = [], flashes = [];
  let fullscreen = false;
  const window = Object.assign(new EventEmitter(), {
    webContents: new EventEmitter(), isDestroyed: () => false, isFullScreen: () => fullscreen,
    setTitle: title => titles.push(title), flashFrame: value => flashes.push(value),
  });
  context.window = window;
  context.tray = { isDestroyed: () => false, setImage: image => images.push(image), setToolTip() {} };
  context.trayImage = name => name;
  const register = vm.runInContext(`(${registerWindowLifecycle.toString()})`, context);
  register({ window, send: context.send, updateIndicators: context.updateIndicators });
  const setPageTitle = title => {
    let prevented = false;
    window.emit('page-title-updated', { preventDefault: () => { prevented = true; } }, title, true);
    if (!prevented) window.setTitle(title);
  };
  const mac = platform === 'darwin';

  context.updateIndicators(); assert.equal(titles.at(-1), 'Agentrix');
  store.projects = [{ unread: 2 }, { unread: 0 }, { unread: 5 }];
  context.updateIndicators(); assert.equal(titles.at(-1), '(2) Agentrix');
  setPageTitle('Agentrix'); assert.equal(titles.at(-1), '(2) Agentrix');
  fullscreen = true; window.emit('enter-full-screen');
  setPageTitle('Agentrix');
  assert.equal(titles.at(-1), mac ? '' : '(2) Agentrix');
  assert.deepEqual(messages, [['window:fullscreen-changed', true]]);

  store.projects = [{ unread: 1 }];
  context.updateIndicators(); assert.equal(titles.at(-1), mac ? '' : '(1) Agentrix');
  assert.equal(images.at(-1), 'icon-alert.png');
  store.projects = [];
  context.updateIndicators(); assert.equal(titles.at(-1), mac ? '' : 'Agentrix');
  assert.equal(images.at(-1), 'icon.png'); assert.equal(flashes.at(-1), false);

  store.projects = [{ unread: 3 }];
  fullscreen = false; window.emit('leave-full-screen');
  assert.equal(titles.at(-1), '(1) Agentrix');
  assert.deepEqual(messages, [['window:fullscreen-changed', true], ['window:fullscreen-changed', false]]);
  store.projects = [];
  context.updateIndicators(); assert.equal(titles.at(-1), 'Agentrix');
});

for (const platform of ['darwin', 'win32', 'linux']) test(`${platform} close hides to the tray${platform === 'darwin' ? ' after leaving fullscreen' : ''}`, () => {
  const order = [];
  let fullscreen = true;
  const window = Object.assign(new EventEmitter(), {
    webContents: new EventEmitter(), isDestroyed: () => false, isFullScreen: () => fullscreen, hide: () => order.push('hide'),
    setFullScreen: value => { order.push(`fullscreen:${value}`); fullscreen = value; window.emit('leave-full-screen'); },
  });
  const register = vm.runInContext(`(${registerWindowLifecycle.toString()})`, vm.createContext({ process: { platform } }));
  register({ window, getSettings: () => ({ closeToTray: true }), isQuitting: () => false, hasTray: () => true,
    send() {}, updateIndicators() {}, requestQuit: assert.fail });
  let prevented = false;
  window.emit('close', { preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  assert.deepEqual(order, platform === 'darwin' ? ['fullscreen:false', 'hide'] : ['hide']);
  order.length = 0;
  window.emit('close', { preventDefault() {} });
  assert.deepEqual(order, ['hide']);
});

test('settings refresh tray language on every platform and application menus only on macOS', () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    const { handlers, menus, calls } = mainFixture(platform);
    const mac = platform === 'darwin', settings = handlers.get('workspace:settings');
    settings({ shortcuts: { addProject: 'Alt+N' } });
    assert.equal(menus.length, mac ? 1 : 0);
    if (mac) assert.equal(menus.at(-1)[0].submenu[2].accelerator, 'Alt+N');
    assert.equal(calls.tray, 0);
    settings({ shortcuts: { addProject: 'Alt+N' }, sound: false });
    assert.equal(menus.length, mac ? 1 : 0);
    assert.equal(calls.tray, 0);
    settings({ shortcuts: {}, language: 'zh' });
    assert.equal(menus.length, mac ? 2 : 0);
    if (mac) {
      assert.equal(menus.at(-1)[0].submenu[3].label, '设置…');
      assert.equal(menus.at(-1)[0].submenu[2].accelerator, DEFAULT_SHORTCUTS.addProject);
    }
    assert.equal(calls.tray, 1);
    settings({ language: 'zh' });
    assert.equal(menus.length, mac ? 2 : 0); assert.equal(calls.tray, 1);
    settings({ language: 'en' });
    assert.equal(menus.length, mac ? 3 : 0);
    if (mac) assert.equal(menus.at(-1)[0].submenu[3].label, 'Settings…');
    assert.equal(calls.tray, 2); assert.equal(calls.broadcast, 5);
  }
});

test('update callbacks rebuild only on ready transitions while still broadcasting every progress update', () => {
  const { context, update, onUpdate, menus, messages, calls } = mainFixture();
  const initial = context.macMenu();
  const changes = [
    ['unavailable', 0, 0], ['idle', 0, 0], ['checking', 0, 0],
    ['downloading', 1, 0], ['downloading', 50, 0], ['downloading', 99, 0],
    ['ready', 100, 1], ['ready', 100, 1], ['error', 100, 2], ['current', 0, 2],
    ['ready', 100, 3], ['downloading', 1, 4], ['downloading', 50, 4],
  ];
  for (const [status, percent, rebuilds] of changes) {
    Object.assign(update, { status, percent }); onUpdate(update);
    assert.equal(menus.length, rebuilds, `${status} ${percent}%`);
    const item = (menus.at(-1) || initial)[0].submenu.find(item => item.label === 'Restart and install update');
    assert.equal(!!item, status === 'ready', status);
  }
  assert.equal(calls.updates, changes.length);
  assert.equal(messages.filter(([channel]) => channel === 'updates:changed').length, changes.length);
});

test('Windows and Linux do not rebuild the application menu', () => {
  for (const platform of ['win32', 'linux']) {
    const { context, handlers, update, onUpdate, menus, calls } = mainFixture(platform);
    context.rebuildMacMenu();
    handlers.get('workspace:settings')({ language: 'zh', shortcuts: { decisions: 'Alt+D' } });
    update.status = 'ready'; onUpdate(update);
    assert.equal(menus.length, 0); assert.equal(calls.tray, 1); assert.equal(calls.updates, 1);
  }
});

test('preload exposes an unsubscribable menu command listener', () => {
  const renderer = new EventEmitter(); let bridge;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../electron/preload.cjs'), 'utf8'), {
    require: name => {
      assert.equal(name, 'electron');
      return { ipcRenderer: renderer, contextBridge: { exposeInMainWorld: (name, api) => { assert.equal(name, 'agentrix'); bridge = api; } } };
    },
  });
  const commands = [], other = [];
  const unsubscribe = bridge.onMenuCommand(command => commands.push(command));
  const stopOther = bridge.onMenuCommand(command => other.push(command));
  renderer.emit('menu:command', {}, 'settings');
  renderer.emit('menu:command', {}, 'addProject');
  unsubscribe(); renderer.emit('menu:command', {}, 'installUpdate');
  assert.deepEqual(commands, ['settings', 'addProject']); assert.deepEqual(other, ['settings', 'addProject', 'installUpdate']);
  stopOther(); assert.equal(renderer.listenerCount('menu:command'), 0);
});
