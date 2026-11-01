const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const ts = require('typescript');
const { WorkspaceStore, cleanSettings } = require('../electron/state.cjs');
const { translate } = require('../electron/i18n.cjs');
const { buildMacMenuTemplate } = require('../electron/app/mac-menu.cjs');

const root = path.join(__dirname, '..');
const invalid = [undefined, null, '', 'fr', 'zh-CN', 'ZH', false, 0, {}, []];
function workspaceFile(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentrix-locale-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, 'workspace.json');
}
function renderer() {
  const filename = path.join(root, 'src/shared/i18n.ts');
  const document = { documentElement: { lang: 'en' } }, exports = {};
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(code, { require: createRequire(filename), exports, document,
    // A Chinese OS/browser locale must never choose the product's default.
    navigator: { language: 'zh-CN', languages: ['zh-CN'] } }, { filename });
  return { ...exports, document };
}

test('a fresh workspace defaults to English without creating or rewriting a workspace file', t => {
  const file = workspaceFile(t);
  assert.equal(new WorkspaceStore(file).settings.language, 'en');
  assert.equal(cleanSettings().language, 'en');
  assert.equal(fs.existsSync(file), false);
});

test('missing settings, unset language and invalid persisted languages load in English without migration writes', t => {
  const file = workspaceFile(t);
  for (const settings of [undefined, {}, ...invalid.map(language => ({ language }))]) {
    const saved = JSON.stringify({ version: 2, projects: [], settings });
    fs.writeFileSync(file, saved);
    const store = new WorkspaceStore(file);
    assert.equal(store.settings.language, 'en');
    assert.equal(store.warning, null);
    assert.equal(fs.readFileSync(file, 'utf8'), saved);
  }
});

test('explicit Chinese and English preferences survive unrelated settings updates and restart', t => {
  const file = workspaceFile(t);
  for (const language of ['zh', 'en']) {
    const saved = JSON.stringify({ version: 2, projects: [], settings: { language } });
    fs.writeFileSync(file, saved);
    const store = new WorkspaceStore(file);
    assert.equal(store.settings.language, language);
    assert.equal(fs.readFileSync(file, 'utf8'), saved);
    store.updateSettings({ sound: false });
    assert.equal(new WorkspaceStore(file).settings.language, language);
  }
  const store = new WorkspaceStore(file);
  store.updateSettings({ language: 'zh' });
  assert.equal(new WorkspaceStore(file).settings.language, 'zh', 'Chinese remains selectable');
  store.updateSettings({ language: 'en' });
  assert.equal(new WorkspaceStore(file).settings.language, 'en');
});

test('renderer first paint is English before settings arrive, including on a Chinese browser locale', () => {
  const ui = renderer();
  assert.match(fs.readFileSync(path.join(root, 'index.html'), 'utf8'), /<html lang="en">/);
  assert.equal(ui.currentLanguage(), 'en');
  assert.equal(ui.document.documentElement.lang, 'en');
  assert.equal(ui.t('正在打开工作区…'), 'Opening workspace…');
  assert.equal(ui.t('Agentrix 是桌面应用'), 'Agentrix is a desktop app');
  assert.equal(ui.t('请在项目目录运行 npm start，或双击打包后的应用。'), 'Run npm start in the project directory, or open the packaged app.');
  assert.equal(ui.t('工作台设置'), 'Workspace settings');
  ui.applyLanguage('zh');
  assert.equal(ui.currentLanguage(), 'zh');
  assert.equal(ui.document.documentElement.lang, 'zh-CN');
  assert.equal(ui.t('工作台设置'), '工作台设置');
  for (const language of ['en', ...invalid]) {
    ui.applyLanguage('zh');
    ui.applyLanguage(language);
    assert.equal(ui.currentLanguage(), 'en');
    assert.equal(ui.document.documentElement.lang, 'en');
    assert.equal(ui.t('添加项目'), 'Add project');
    assert.equal(ui.t('终端 {n}', { n: 2 }), 'Terminal 2');
    assert.equal(ui.t('正在删除：报告.txt'), 'Deleting: 报告.txt');
  }
});

test('backend translation before settings and for invalid language uses English; explicit Chinese stays Chinese', () => {
  for (const language of ['en', ...invalid]) {
    assert.equal(translate(language, '添加项目'), 'Add project');
    assert.equal(translate(language, 'Agentrix 无法启动'), 'Agentrix could not start');
    assert.equal(translate(language, '终端 {n}', { n: 2 }), 'Terminal 2');
    assert.equal(translate(language, '正在删除：报告.txt'), 'Deleting: 报告.txt');
  }
  assert.equal(translate('zh', '添加项目'), '添加项目');
});

// Execute the real main-process menu and notification builders with inert native APIs.
test('native menus and completion notifications follow default English and explicit Chinese', () => {
  const filename = path.join(root, 'electron/main.cjs'), text = fs.readFileSync(filename, 'utf8');
  const source = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const functions = source.statements.filter(node => ts.isFunctionDeclaration(node)
    && ['macMenu', 'trayMenu', 'notifyCompletion'].includes(node.name?.text)).map(node => node.getText(source));
  assert.equal(functions.length, 3);
  const translator = source.statements.find(node => ts.isVariableStatement(node)
    && node.declarationList.declarations.some(declaration => declaration.name.getText(source) === 't'));
  assert.ok(translator);
  let trayItems, notification;
  class Notification {
    static isSupported() { return true; }
    constructor(options) { notification = options; }
    on() {} show() {}
  }
  const context = vm.createContext({ translate, store: undefined, app: { name: 'Agentrix' }, path, root,
    buildMacMenuTemplate, updateManager: undefined,
    Menu: { buildFromTemplate: items => items }, Notification, window: { isFocused: () => true },
    tray: { isDestroyed: () => false, setContextMenu: items => { trayItems = items; } } });
  vm.runInContext(`${translator.getText(source)}\n${functions.join('\n')}`, context);
  // No store yet: native fallbacks already use English.
  assert.equal(vm.runInContext('macMenu()', context)[0].submenu[0].label, 'About Agentrix');
  for (const language of [undefined, 'fr', 'en', 'zh']) {
    context.store = { settings: { language, notifications: true, sound: false } };
    const chinese = language === 'zh';
    const menu = vm.runInContext('macMenu()', context);
    assert.equal(menu.length, 1);
    assert.equal(menu[0].submenu[3].label, chinese ? '设置…' : 'Settings…');
    vm.runInContext('trayMenu(); notifyCompletion({ id: "test", name: "Demo" })', context);
    assert.equal(trayItems[0].label, chinese ? '打开 Agentrix' : 'Open Agentrix');
    assert.equal(notification.title, translate(language, '{name} · 本轮已完成', { name: 'Demo' }));
    assert.equal(notification.body, translate(language, '这一轮任务已结束，点击查看终端。'));
    if (!chinese) assert.doesNotMatch(notification.title + notification.body, /[一-鿿]/);
  }
});
