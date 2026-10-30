const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { DEFAULT_MENU_STATE, parseMenuState, buildMacMenuTemplate } = require('../electron/app/mac-menu.cjs');
const DEFAULT_SHORTCUTS = require('../electron/shortcuts.json');
const { translate } = require('../electron/i18n.cjs');
const { cleanSettings } = require('../electron/state.cjs');
const { registerWorkspaceIpc } = require('../electron/features/workspace/ipc.cjs');

function template(options = {}) {
  return buildMacMenuTemplate({ appName: 'Agentrix', t: (text, values) => translate('zh', text, values), ...options });
}
const labels = items => items.map(item => item.type === 'separator' ? '─' : item.label);

test('default menu has the agreed order, initial state and unchanged native roles', () => {
  const menus = template();
  assert.deepEqual(labels(menus), ['Agentrix', '前往', '显示', '窗口']);
  assert.deepEqual(labels(menus[0].submenu), ['关于 Agentrix', '─', '新建项目', '设置…', '─', '隐藏 Agentrix', '隐藏其他', '全部显示', '─', '退出 Agentrix']);
  assert.deepEqual(menus[0].submenu.filter(item => item.role).map(item => item.role), ['about', 'hide', 'hideOthers', 'unhide']);
  const go = menus[1].submenu;
  assert.deepEqual(labels(go), ['工作台', '决策', '─', '返回项目', '搜索项目']);
  assert.equal(go[0].checked, true); assert.equal(go[1].checked, false);
  assert.equal(go[3].enabled, false); assert.equal(go[4].enabled, true);
  assert.deepEqual(labels(menus[2].submenu), ['显示活动栏']);
  assert.equal(menus[2].submenu[0].type, 'checkbox');
  assert.equal(menus[2].submenu[0].enabled, false); assert.equal(menus[2].submenu[0].checked, false);
  assert.deepEqual(labels(menus[3].submenu), ['最小化', '缩放', '切换全屏', '─', '关闭窗口']);
  assert.deepEqual(menus[3].submenu.slice(0, 3).map(item => item.role), ['minimize', 'zoom', 'togglefullscreen']);
  assert.equal(menus[0].submenu.at(-1).accelerator, 'Command+Q');
  assert.equal(menus[3].submenu.at(-1).accelerator, 'Command+W');
  assert.equal(menus[0].submenu.at(-1).registerAccelerator, undefined);
  assert.equal(menus[3].submenu.at(-1).registerAccelerator, undefined);
});

test('view, decision count, return and focus update menu selection and availability', () => {
  const menus = template({ state: { ...DEFAULT_MENU_STATE, view: 'decisions', decisions: 7, canReturn: true, focused: true, activityPane: true } });
  const go = menus[1].submenu, activity = menus[2].submenu[0];
  assert.equal(go[0].checked, false); assert.equal(go[1].checked, true);
  assert.equal(go[1].label, '决策 (7)');
  assert.equal(go[3].enabled, true); assert.equal(go[4].enabled, false);
  assert.equal(activity.enabled, true); assert.equal(activity.checked, true);
  const overview = template({ state: { ...DEFAULT_MENU_STATE, canReturn: true, activityPane: true } });
  assert.equal(overview[1].submenu[3].enabled, true);
  assert.equal(overview[2].submenu[0].enabled, false);
  assert.equal(overview[2].submenu[0].checked, true);
});

test('reading and terminal form a radio pair only when a switch is available', () => {
  for (const reading of [true, false]) {
    const view = template({ state: { ...DEFAULT_MENU_STATE, reading } })[2].submenu;
    assert.deepEqual(labels(view), ['显示活动栏', '─', '阅读视图', '终端']);
    assert.deepEqual(view.slice(2).map(item => item.type), ['radio', 'radio']);
    assert.deepEqual(view.slice(2).map(item => item.checked), [reading, !reading]);
  }
});

test('ready updates appear after settings and every application item sends its exact command', () => {
  const commands = [];
  const menus = template({ updateReady: true, state: { ...DEFAULT_MENU_STATE, reading: true }, command: name => commands.push(name) });
  assert.deepEqual(labels(menus[0].submenu).slice(0, 6), ['关于 Agentrix', '─', '新建项目', '设置…', '重启并安装更新', '─']);
  for (const item of [...menus[0].submenu.slice(2, 5), ...menus[1].submenu, ...menus[2].submenu]) item.click?.();
  assert.deepEqual(commands, ['addProject', 'settings', 'installUpdate', 'workspace', 'decisions', 'overview', 'search', 'activityPane', 'reading', 'terminal']);
});

test('application accelerators display current custom bindings over defaults without registering keys', () => {
  const custom = { addProject: 'Alt+N', settings: 'Ctrl+Shift+S', decisions: 'Alt+D', overview: 'Alt+Left', search: 'Ctrl+Alt+F' };
  for (const shortcuts of [undefined, custom, { decisions: 'Alt+D' }]) {
    const menus = template({ shortcuts, updateReady: true, state: { ...DEFAULT_MENU_STATE, reading: false } });
    const bindings = { ...DEFAULT_SHORTCUTS, ...shortcuts };
    for (const [item, action] of [
      [menus[0].submenu[2], 'addProject'], [menus[0].submenu[3], 'settings'],
      [menus[1].submenu[1], 'decisions'], [menus[1].submenu[3], 'overview'], [menus[1].submenu[4], 'search'],
    ]) {
      assert.equal(item.accelerator, bindings[action], action);
      assert.equal(item.registerAccelerator, false, action);
    }
    for (const item of [menus[0].submenu[4], menus[1].submenu[0], ...menus[2].submenu]) assert.equal(item.accelerator, undefined);
  }
});

test('all menu labels use existing English vocabulary and translate the decision count', () => {
  const menus = template({ t: (text, values) => translate('en', text, values), updateReady: true,
    state: { ...DEFAULT_MENU_STATE, decisions: 2, reading: true } });
  assert.deepEqual(labels(menus), ['Agentrix', 'Go', 'View', 'Window']);
  assert.deepEqual(labels(menus[0].submenu).slice(2, 5), ['New project', 'Settings…', 'Restart and install update']);
  assert.deepEqual(labels(menus[1].submenu), ['Workbench', 'Decide (2)', '─', 'Back to projects', 'Search projects']);
  assert.deepEqual(labels(menus[2].submenu), ['Show activity pane', '─', 'Reading view', 'Terminal']);
  for (const menu of menus) for (const item of menu.submenu) if (item.label) assert.doesNotMatch(item.label, /[一-鿿]/);
});

const invalidStates = [undefined, null, [], 'workspace', false, 0, {},
  ...['overview', '', null].map(view => ({ ...DEFAULT_MENU_STATE, view })),
  ...[-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '2'].map(decisions => ({ ...DEFAULT_MENU_STATE, decisions })),
  ...['canReturn', 'focused', 'activityPane', 'reading'].flatMap(key => [undefined, 0, 'true'].map(value => ({ ...DEFAULT_MENU_STATE, [key]: value }))),
];
test('state validation rejects malformed fields and copies only the contract fields', () => {
  for (const state of invalidStates) assert.equal(parseMenuState(state), null);
  for (const reading of [null, true, false]) {
    const state = { ...DEFAULT_MENU_STATE, reading, ignored: 'extra' };
    const parsed = parseMenuState(state);
    assert.deepEqual(parsed, { ...DEFAULT_MENU_STATE, reading });
    state.decisions = 8;
    assert.equal(parsed.decisions, 0);
  }
});

const filename = path.join(__dirname, '../electron/main.cjs');
const source = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const functions = new Map(source.statements.filter(ts.isFunctionDeclaration).map(node => [node.name.text, node]));
function optionCallback(callee, name) {
  let callback;
  function visit(node) {
    if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && node.expression.getText(source) === callee) {
      callback = node.arguments[0].properties.find(property => property.name?.getText(source) === name)?.initializer;
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(callback, `${callee}.${name}`);
  return callback.getText(source);
}
const stateRegistration = functions.get('registerIpc').body.statements.find(node => node.getText(source).includes("listen('menu:state'"));
assert.ok(stateRegistration);

function mainFixture(platform = 'darwin') {
  const menus = [], messages = [], handlers = new Map(), calls = { quit: 0, close: 0, show: 0, tray: 0, broadcast: 0, updates: 0 };
  const store = { settings: cleanSettings(), updateSettings(patch) { this.settings = cleanSettings({ ...this.settings, ...patch }); } };
  const update = { status: 'idle' };
  const context = vm.createContext({ DEFAULT_MENU_STATE, parseMenuState, buildMacMenuTemplate, menuState: DEFAULT_MENU_STATE,
    menuUpdateReady: false,
    store, t: (text, values) => translate(store.settings.language, text, values), app: { name: 'Agentrix' },
    process: { platform }, Menu: { buildFromTemplate: items => items, setApplicationMenu: menu => menus.push(menu) },
    send: (...args) => messages.push(args), listen: (name, handler) => handlers.set(name, handler),
    window: { close: () => calls.close++ }, desktopGlassActive: false, windowZoom: undefined,
    updateManager: { getState: () => update }, updatesIpc: { onStateChange: () => calls.updates++ },
    showWindow: () => calls.show++, requestQuit: async () => { calls.quit++; }, report: assert.fail,
    trayMenu: () => calls.tray++,
  });
  vm.runInContext(['macMenu', 'rebuildMacMenu', 'setMenuState', 'updateStoreSettings'].map(name => functions.get(name).getText(source)).join('\n'), context);
  vm.runInContext(stateRegistration.getText(source), context);
  const onUpdate = vm.runInContext(`(${optionCallback('UpdateManager', 'onChange')})`, context);
  const rebuildMenus = vm.runInContext(`(${optionCallback('registerWorkspaceIpc', 'rebuildMenus')})`, context);
  registerWorkspaceIpc({ handle: (name, handler) => handlers.set(name, handler), getSettings: () => store.settings,
    updateStoreSettings: context.updateStoreSettings, broadcast: () => calls.broadcast++, rebuildMenus, chooseVoiceModel() {} });
  return { context, store, update, onUpdate, menus, messages, handlers, calls };
}

test('macOS IPC ignores invalid and identical states, rebuilding once for each changed field', () => {
  const { handlers, menus, context } = mainFixture();
  const receive = handlers.get('menu:state');
  for (const state of [...invalidStates, { ...DEFAULT_MENU_STATE }]) receive(state);
  assert.equal(menus.length, 0);
  let state = { ...DEFAULT_MENU_STATE };
  for (const [key, value] of Object.entries({ view: 'decisions', decisions: 4, canReturn: true, focused: true, activityPane: true, reading: false })) {
    const previous = menus.length;
    state = { ...state, [key]: value }; receive(state);
    assert.equal(menus.length, previous + 1, key);
    receive({ ...state, ignored: 'extra' });
    assert.equal(menus.length, previous + 1, 'duplicate state');
  }
  assert.equal(menus.at(-1)[1].submenu[1].label, 'Decide (4)');
  state.decisions = 100;
  assert.equal(context.menuState.decisions, 4, 'caller mutation cannot change the accepted state');
});

test('real menu wiring sends commands and retains quit and close behavior', () => {
  const { context, messages, calls } = mainFixture();
  const menus = context.macMenu();
  menus[0].submenu[2].click(); menus[1].submenu[1].click(); menus[0].submenu.at(-1).click(); menus[3].submenu.at(-1).click();
  assert.deepEqual(messages, [['menu:command', 'addProject'], ['menu:command', 'decisions']]);
  assert.equal(calls.show, 1); assert.equal(calls.quit, 1); assert.equal(calls.close, 1);
});

test('native automatic checks stay at the confirmed state when the renderer blocks a command', () => {
  const { handlers, menus } = mainFixture();
  handlers.get('menu:state')({ ...DEFAULT_MENU_STATE, focused: true, reading: true });
  // Simulate Electron toggling its items before invoking click, with no renderer state update afterward.
  const go = menus.at(-1)[1].submenu;
  go[0].checked = false; go[1].checked = true; go[1].click();
  assert.equal(menus.at(-1)[1].submenu[0].checked, true);
  assert.equal(menus.at(-1)[1].submenu[1].checked, false);
  const activity = menus.at(-1)[2].submenu[0];
  activity.checked = true; activity.click();
  assert.equal(menus.at(-1)[2].submenu[0].checked, false);
  const view = menus.at(-1)[2].submenu;
  view[2].checked = false; view[3].checked = true; view[3].click();
  assert.equal(menus.at(-1)[2].submenu[2].checked, true);
  assert.equal(menus.at(-1)[2].submenu[3].checked, false);
  handlers.get('menu:state')({ ...DEFAULT_MENU_STATE, view: 'decisions', focused: true, activityPane: true, reading: false });
  assert.equal(menus.at(-1)[1].submenu[1].checked, true);
  assert.equal(menus.at(-1)[2].submenu[0].checked, true);
  assert.equal(menus.at(-1)[2].submenu[3].checked, true);
});

test('settings changes refresh accelerators and language without rebuilding for unrelated settings', () => {
  const { handlers, menus, calls } = mainFixture();
  const settings = handlers.get('workspace:settings');
  settings({ shortcuts: { decisions: 'Alt+D' } });
  assert.equal(menus.length, 1);
  assert.equal(menus.at(-1)[1].submenu[1].accelerator, 'Alt+D');
  settings({ shortcuts: { decisions: 'Alt+D' }, sound: false });
  assert.equal(menus.length, 1);
  settings({ shortcuts: {}, language: 'zh' });
  assert.equal(menus.length, 2);
  assert.equal(menus.at(-1)[1].label, '前往');
  assert.equal(menus.at(-1)[1].submenu[1].accelerator, DEFAULT_SHORTCUTS.decisions);
  assert.equal(calls.tray, 1);
  settings({ language: 'en' });
  assert.equal(menus.length, 3); assert.equal(menus.at(-1)[1].label, 'Go');
  assert.equal(calls.tray, 2); assert.equal(calls.broadcast, 4);
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
    if (item) { item.click(); assert.deepEqual(messages.at(-1), ['menu:command', 'installUpdate']); }
  }
  assert.equal(calls.updates, changes.length);
  assert.equal(messages.filter(([channel]) => channel === 'updates:changed').length, changes.length);
});

test('Windows and Linux do not register menu state IPC or rebuild the application menu', () => {
  for (const platform of ['win32', 'linux']) {
    const { context, handlers, update, onUpdate, menus, calls } = mainFixture(platform);
    assert.equal(handlers.has('menu:state'), false);
    context.rebuildMacMenu();
    handlers.get('workspace:settings')({ language: 'zh', shortcuts: { decisions: 'Alt+D' } });
    update.status = 'ready'; onUpdate(update);
    assert.equal(menus.length, 0); assert.equal(calls.tray, 1); assert.equal(calls.updates, 1);
  }
});

test('preload exposes the Agentrix state sender and an unsubscribable menu command listener', () => {
  const renderer = new EventEmitter(), sent = []; let bridge;
  renderer.send = (...args) => sent.push(args);
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../electron/preload.cjs'), 'utf8'), {
    require: name => {
      assert.equal(name, 'electron');
      return { ipcRenderer: renderer, contextBridge: { exposeInMainWorld: (name, api) => { assert.equal(name, 'agentrix'); bridge = api; } } };
    },
  });
  bridge.setMenuState(DEFAULT_MENU_STATE);
  assert.deepEqual(sent, [['menu:state', DEFAULT_MENU_STATE]]);
  const commands = [], other = [];
  const unsubscribe = bridge.onMenuCommand(command => commands.push(command));
  const stopOther = bridge.onMenuCommand(command => other.push(command));
  renderer.emit('menu:command', {}, 'settings');
  unsubscribe(); renderer.emit('menu:command', {}, 'workspace');
  assert.deepEqual(commands, ['settings']); assert.deepEqual(other, ['settings', 'workspace']);
  stopOther(); assert.equal(renderer.listenerCount('menu:command'), 0);
});
