const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const React = require('react');

const nodes = node => Array.isArray(node) ? node.flatMap(nodes) : React.isValidElement(node) ? [node, ...nodes(node.props.children)] : [];
const image = 'data:image/png;base64,aW1hZ2U=';
function fixture(t, projects) {
  const before = global.window;
  global.window = { agentrix: new Proxy({}, { get: (_target, name) => { assert.fail(`settings list unexpectedly accessed ${String(name)}`); } }) };
  t.after(() => { global.window = before; });
  let editing = null;
  const Child = () => null;
  const filename = path.join(__dirname, '../src/features/settings/ProjectImagesSettings.tsx'), mod = new Module(filename, module);
  mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename));
  const original = mod.require.bind(mod);
  mod.require = name => name === 'react' ? { useState: () => [editing, value => { editing = value; }] }
    : name.endsWith('.css') ? {} : name === '../../shared/i18n' ? { t: (text, values = {}) => text.replace(/\{(\w+)\}/g, (_match, key) => values[key]) }
    : name === '../workspace/ProjectImageDialog' ? { ProjectImageDialog: Child } : original(name);
  mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, filename);
  const render = (current = projects) => mod.exports.ProjectImagesSettings({ projects: current });
  return { render, child: (current = projects) => nodes(render(current)).find(node => node.type === Child) };
}

const projects = [
  { id: 'remote', name: 'Remote', path: '/srv/work', kind: 'ssh', ssh: { host: 'dev' }, image, imageMode: 'auto' },
  { id: 'custom', name: 'Local image', path: 'C:/work/image', kind: 'local', image },
  { id: 'number', name: 'Local number', path: 'C:/work/number', kind: 'local', imageMode: 'number' },
  { id: 'empty', name: 'Local automatic', path: 'C:/work/empty', kind: 'local' },
];

test('thumbnail preferences list every open project in workspace order, including SSH and original numbering', t => {
  const h = fixture(t, projects), tree = nodes(h.render());
  const rows = tree.filter(node => node.props.className === 'setting-row project-image-setting-row');
  assert.deepEqual(rows.map(row => row.props['data-project-image-id']), projects.map(project => project.id));
  assert.equal(tree.filter(node => node.type === 'button').length, projects.length);
  assert.ok(tree.some(node => node.type === 'small' && node.props.children === 'dev:/srv/work'));
  assert.deepEqual(tree.filter(node => node.props.className === 'project-image-setting-mode').map(node => node.props.children), ['自动', '自选', '编号', '自动']);
  assert.deepEqual(tree.filter(node => node.props.className === 'project-image-setting-thumb').map(node => React.isValidElement(node.props.children) ? 'image' : node.props.children), ['image', 'image', '03', '04']);
  assert.equal(h.child(), undefined);
});

test('opening an editor resolves the current project and its current workspace index', t => {
  const h = fixture(t, projects);
  nodes(h.render()).find(node => node.type === 'button' && node.props['aria-label'] === '更改 Local image 的项目图片').props.onClick();
  assert.equal(h.child().props.project, projects[1]);
  assert.equal(h.child().props.index, 1);
  const updated = { ...projects[1], image: 'background-update', imageMode: 'auto' }, reordered = [updated, projects[0]];
  assert.equal(h.child(reordered).props.project, updated); assert.equal(h.child(reordered).props.index, 0);
  h.child().props.onClose(); assert.equal(h.child(), undefined);
});

test('removing an edited project unmounts its dialog and an empty workspace has no controls', t => {
  const h = fixture(t, projects);
  nodes(h.render()).find(node => node.type === 'button').props.onClick(); assert.ok(h.child());
  assert.equal(h.child(projects.slice(1)), undefined);
  const empty = nodes(h.render([]));
  assert.equal(empty.some(node => node.type === 'button'), false);
  assert.ok(empty.some(node => node.props.children === '当前没有打开的项目。'));
});

function settingsDialogFixture(t, props = {}) {
  const before = global.window, slots = [], updates = [];
  global.window = { agentrix: new Proxy({}, { get: (_target, name) => { assert.fail(`settings navigation unexpectedly accessed ${String(name)}`); } }) };
  t.after(() => { global.window = before; });
  let cursor = 0;
  const hooks = {
    useState(value) { const index = cursor++; if (!(index in slots)) slots[index] = value; return [slots[index], next => { slots[index] = typeof next === 'function' ? next(slots[index]) : next; }]; },
    useRef(value) { const index = cursor++; return slots[index] ??= { current: value }; },
    useEffect(callback) { const index = cursor++; if (!(index in slots)) { slots[index] = true; callback(); } },
  };
  const List = () => null, Avatar = () => null;
  const filename = path.join(__dirname, '../src/features/settings/SettingsDialog.tsx'), mod = new Module(filename, module);
  mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename));
  const original = mod.require.bind(mod), empty = () => null;
  const components = {
    '../voice/VoiceButton': { VoiceModelSetting: empty }, '../shortcuts/ShortcutSettings': { ShortcutSettings: empty },
    '../agents/AgentsSettings': { AgentsSettings: empty }, './TerminalFontSettings': { TerminalFontSettings: empty },
    './UserAvatarSetting': { UserAvatarSetting: Avatar }, './ThemeSetting': { ThemeSetting: empty }, './ProjectImagesSettings': { ProjectImagesSettings: List }, './AboutSettings': { AboutSettings: empty },
  };
  mod.require = name => name === 'react' ? hooks : name === '@phosphor-icons/react' ? new Proxy({}, { get: () => empty })
    : name === '../../shared/i18n' ? { t: (text, values = {}) => text.replace(/\{(\w+)\}/g, (_match, key) => values[key]), currentLanguage: () => 'zh' }
    : name === '../../shared/Select' ? { Select: empty }
    : name === '../../shared/platform' ? { isMac: false, isLinux: false }
    : name === '../shortcuts/shortcuts' ? { shortcut: () => 'Ctrl+Shift+V' } : components[name] || original(name);
  mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, filename);
  const settings = { language: 'zh', surface: 'solid', glassTransparency: null, uiZoom: null, terminalFontWeight: 400, userAvatar: '', shortcuts: {} };
  const render = () => { cursor = 0; return mod.exports.SettingsDialog({ settings, initialSection: 'appearance', localShell: null, agents: null, updates: null, update: patch => updates.push(patch), close: empty, quit: empty, onGuide: empty, onAgents: empty, onCheckUpdate: empty, onInstallUpdate: empty, onDownloadPage: empty, projects, ...props }); };
  const find = predicate => nodes(render()).find(predicate);
  return { render, updates, List, Avatar, find,
    open: () => find(node => node.props['data-project-images-open'] === true).props.onClick(),
    tab: id => find(node => node.props['data-settings-tab'] === id),
    section: id => find(node => node.props.id === `settings-${id}`),
    title: () => find(node => node.props.className === 'settings-main-head').props.children[0].props.children,
  };
}

test('project thumbnails enter from one appearance row and keep the original sidebar categories', t => {
  const h = settingsDialogFixture(t), tree = nodes(h.render());
  assert.deepEqual(tree.filter(node => node.props['data-settings-tab']).map(node => node.props['data-settings-tab']), ['appearance', 'notifications', 'terminal', 'agents', 'shortcuts', 'about']);
  const appearance = h.section('appearance'), children = React.Children.toArray(appearance.props.children);
  const avatar = children.findIndex(node => node.type === h.Avatar), entry = children.findIndex(node => node.props['data-project-images-setting'] === true);
  assert.equal(entry, avatar + 1); assert.equal(children[entry].props.className, 'setting-row');
  assert.equal(h.section('project-images').props.hidden, true);
  assert.equal(tree.some(node => node.type === h.List), false);
  h.open();
  assert.equal(h.title(), '项目缩略图'); assert.equal(h.tab('appearance').props['aria-current'], 'page');
  assert.equal(h.tab('appearance').props['aria-controls'], 'settings-project-images');
  assert.equal(h.section('appearance').props.hidden, true); assert.equal(h.section('project-images').props.hidden, false);
  assert.equal(h.find(node => node.type === h.List).props.projects, projects);
  assert.equal(nodes(h.render()).filter(node => node.type === 'dialog').length, 1); assert.deepEqual(h.updates, []);
});

test('back to appearance restores its existing controls without saving settings', t => {
  const h = settingsDialogFixture(t);
  h.open(); h.find(node => node.props['data-project-images-back'] === true).props.onClick();
  assert.equal(h.title(), '外观'); assert.equal(h.section('appearance').props.hidden, false);
  assert.equal(h.section('project-images').props.hidden, true); assert.equal(h.find(node => node.type === h.List), undefined);
  assert.ok(h.find(node => node.type === h.Avatar)); assert.ok(h.find(node => node.props['data-project-images-setting'] === true));
  assert.equal(h.tab('appearance').props['aria-controls'], 'settings-appearance'); assert.deepEqual(h.updates, []);
});

test('choosing any sidebar category exits thumbnail management, including choosing appearance again', t => {
  const h = settingsDialogFixture(t);
  for (const id of ['notifications', 'terminal', 'agents', 'shortcuts', 'about', 'appearance']) {
    h.tab('appearance').props.onClick(); h.open(); h.tab(id).props.onClick();
    assert.equal(h.section('project-images').props.hidden, true); assert.equal(h.find(node => node.type === h.List), undefined);
    h.tab('appearance').props.onClick(); assert.equal(h.title(), '外观'); assert.equal(h.section('appearance').props.hidden, false);
  }
  assert.deepEqual(h.updates, []);
});

test('sidebar arrow navigation leaves thumbnail management and returns to the ordinary appearance page', t => {
  const h = settingsDialogFixture(t); let prevented = 0;
  h.open();
  h.find(node => node.type === 'nav').props.onKeyDown({ key: 'ArrowDown', preventDefault() { prevented++; } });
  assert.equal(h.tab('notifications').props['aria-current'], 'page'); assert.equal(h.section('project-images').props.hidden, true);
  h.find(node => node.type === 'nav').props.onKeyDown({ key: 'ArrowUp', preventDefault() { prevented++; } });
  assert.equal(h.title(), '外观'); assert.equal(h.section('appearance').props.hidden, false); assert.equal(prevented, 2); assert.deepEqual(h.updates, []);
});

test('appearance thumbnail management accepts existing SettingsDialog callers without a projects prop', t => {
  const h = settingsDialogFixture(t, { projects: undefined }); h.open();
  assert.deepEqual(h.find(node => node.type === h.List).props.projects, []); assert.deepEqual(h.updates, []);
});

test('interface zoom row follows the language row and offers automatic plus 80-150 percent', t => {
  const h = settingsDialogFixture(t, { uiZoom: 110 }), children = React.Children.toArray(h.section('appearance').props.children);
  const row = children.findIndex(node => nodes(node).some(inner => inner.props.label === '界面缩放')), language = children.findIndex(node => nodes(node).some(inner => inner.props.label === '语言'));
  assert.equal(row, language + 1);
  const select = h.find(node => node.props.label === '界面缩放').props;
  assert.deepEqual(select.options.map(option => option.label), ['自动（当前 110%）', '80%', '90%', '100%', '110%', '125%', '150%']);
  assert.equal(select.value, 'auto');
  select.onChange('125'); select.onChange('auto');
  assert.deepEqual(h.updates, [{ uiZoom: 125 }, { uiZoom: null }]);
});

test('interface zoom row shows an explicit choice and reads 100 percent before the workspace reports one', t => {
  const explicit = settingsDialogFixture(t, { settings: { language: 'zh', surface: 'solid', uiZoom: 90, userAvatar: '', shortcuts: {} } });
  assert.equal(explicit.find(node => node.props.label === '界面缩放').props.value, '90');
  assert.equal(settingsDialogFixture(t).find(node => node.props.label === '界面缩放').props.options[0].label, '自动（当前 100%）');
});

