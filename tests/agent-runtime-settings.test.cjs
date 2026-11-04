const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { hookHarness } = require('./helpers/hook-harness.cjs');

// The 运行方式 settings page: the API key (write-only), Claude's path, Codex's view and the monthly budget, against a fake main process.
// No real key, SDK or account is involved; the "key" below is a made-up string.
const SECRET = 'sk-ant-made-up-for-this-test';
const fill = (text, values = {}) => text.replace(/\{(\w+)\}/g, (match, key) => values[key] ?? match);
const elements = node => Array.isArray(node) ? node.flatMap(elements) : React.isValidElement(node) ? [node, ...elements(node.props.children)] : [];
const settle = async () => { for (let round = 0; round < 6; round++) await new Promise(resolve => setImmediate(resolve)); };
const defaults = { claudePath: 'api-then-terminal', codexView: 'native', monthlyBudgetUsd: null };
// The words of a connection test have their own tests (native-session-ui.test.cjs); here a result carries the lines it should show.
const wordsStub = { clockWords: () => '09:00', connectionLines: test => test.lines };

// The page with real hooks. The select is stood in by a component that keeps its props, so a test can read its value and choose an option.
function page(bridge, words = wordsStub) {
  const usage = [];
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { agentrix: bridge ? { nativeSession: bridge } : {} } });
  const harness = hookHarness('src/features/settings/AgentRuntimeSettings.tsx', {
    '@phosphor-icons/react': new Proxy({}, { get: () => () => null }), './i18n': { t: fill }, './agent-runtime-settings.css': {}, './native-words': words, './native-store.ts': { usageChanged: () => usage.push('changed') },
    './Select': { Select: props => React.createElement('select', { 'aria-label': props.label, value: props.value, disabled: props.disabled }) },
  });
  const render = () => harness.render('AgentRuntimeSettings').result, tree = () => elements(render());
  const select = label => tree().find(node => node.props?.label === label), input = predicate => tree().find(node => node.type === 'input' && predicate(node.props));
  const button = label => tree().find(node => node.type === 'button' && node.props.children === label);
  return {
    usage, render, tree, select, button, html: () => renderToStaticMarkup(render()),
    secret: () => input(props => props.type === 'password'), budget: () => input(props => props.inputMode === 'decimal'),
    status: () => tree().find(node => node.type === 'small' && node.props.role === 'status')?.props.children, alert: () => tree().find(node => node.props?.role === 'alert')?.props.children,
    done() { harness.dispose(); if (previous) Object.defineProperty(globalThis, 'window', previous); else delete globalThis.window; },
  };
}
const fake = (patch = {}) => {
  const calls = [], state = { settings: { ...defaults }, saved: false };
  return { calls, state, getSettings: async () => ({ ok: true, value: state.settings }), keyStatus: async () => ({ ok: true, value: { saved: state.saved } }),
    setSettings: async value => { calls.push(['set', value]); Object.assign(state.settings, value); return { ok: true, value: state.settings }; },
    keySave: async key => { calls.push(['save', key]); state.saved = true; return { ok: true, value: { saved: true } }; },
    keyClear: async () => { calls.push(['clear']); state.saved = false; return { ok: true, value: { saved: false } }; }, ...patch };
};

test('the page shows the saved settings, whether a key is saved, and the three Claude paths and two Codex views', async () => {
  const bridge = fake(); bridge.state.settings.monthlyBudgetUsd = 50; bridge.state.saved = true;
  const view = page(bridge);
  try {
    view.render(); await settle();
    assert.equal(view.status(), '已保存');
    assert.equal(view.select('Claude 的运行方式').props.value, 'api-then-terminal');
    assert.deepEqual(view.select('Claude 的运行方式').props.options.map(option => option.value), ['api-then-terminal', 'api-only', 'terminal-only']);
    assert.match(view.select('Claude 的运行方式').props.options[0].label, /默认/, 'API, then the terminal when the quota is used up, is the default');
    assert.deepEqual([view.select('Codex 的界面').props.value, view.select('Codex 的界面').props.options.map(option => option.value)], ['native', ['native', 'terminal']]);
    assert.equal(view.budget().props.value, '50');
    assert.equal(view.select('Claude 的运行方式').props.className, 'runtime-select', 'its trigger is wide enough for “（默认）”');
    const css = fs.readFileSync(path.join(__dirname, '../src/features/settings/agent-runtime-settings.css'), 'utf8');
    assert.match(css, /\.setting-row \.select-trigger\.runtime-select \{ width: 300px; max-width: 48%; \}/);
    assert.equal(view.secret().props.value, '', 'the saved key is never shown, only that it is saved');
  } finally { view.done(); }
});

test('a key is sent once, its field empties at once, it never shows again, and clearing it is one click', async () => {
  const bridge = fake(), view = page(bridge);
  try {
    view.render(); await settle();
    assert.equal(view.status(), '未保存'); assert.equal(view.button('清除'), undefined, 'nothing to clear yet');
    view.secret().props.onChange({ target: { value: SECRET } });
    assert.equal(view.secret().props.value, SECRET); assert.equal(view.button('保存').props.disabled, false);
    view.button('保存').props.onClick();
    assert.equal(view.secret().props.value, '', 'the field is empty the moment it is sent');
    await settle();
    assert.deepEqual(bridge.calls, [['save', SECRET]]);
    assert.equal(view.status(), '已保存'); assert.ok(!view.html().includes(SECRET), 'the page never holds the key again');
    assert.equal(view.secret().props.placeholder, '输入新的 key 以替换');
    view.secret().props.onKeyDown({ key: 'Enter' }); assert.equal(bridge.calls.length, 1, 'Enter on an empty field sends nothing');
    assert.match(view.button('保存').props.className, /\bbutton secondary\b/); assert.equal(view.button('清除').props.className, 'text-button', 'clearing is the quieter action beside saving');
    view.button('清除').props.onClick(); await settle();
    assert.deepEqual(bridge.calls.at(-1), ['clear']); assert.equal(view.status(), '未保存');
  } finally { view.done(); }
});

test('a refused key shows the reason and the page keeps its state; Enter in the field sends too', async () => {
  const bridge = fake({ keySave: async key => { bridge.calls.push(['save', key]); return { ok: false, error: 'No secure storage on this system' }; } }), view = page(bridge);
  try {
    view.render(); await settle();
    view.secret().props.onChange({ target: { value: SECRET } }); view.secret().props.onKeyDown({ key: 'Enter' }); await settle();
    assert.deepEqual(bridge.calls, [['save', SECRET]]); assert.equal(view.alert(), 'No secure storage on this system'); assert.equal(view.status(), '未保存');
    assert.ok(!view.html().includes(SECRET));
  } finally { view.done(); }
});

test('Claude’s path and Codex’s view are changed one at a time; a refused change leaves the page as it was and says why', async () => {
  const bridge = fake(), view = page(bridge);
  try {
    view.render(); await settle();
    view.select('Claude 的运行方式').props.onChange('api-only'); await settle();
    view.select('Codex 的界面').props.onChange('terminal'); await settle();
    assert.deepEqual(bridge.calls, [['set', { claudePath: 'api-only' }], ['set', { codexView: 'terminal' }]]);
    assert.deepEqual([view.select('Claude 的运行方式').props.value, view.select('Codex 的界面').props.value], ['api-only', 'terminal']);
    bridge.setSettings = async () => ({ ok: false, error: 'disk full' });
    view.select('Claude 的运行方式').props.onChange('terminal-only'); await settle();
    assert.equal(view.select('Claude 的运行方式').props.value, 'api-only'); assert.equal(view.alert(), 'disk full');
  } finally { view.done(); }
});

test('the budget saves on leaving the field or Enter: dollars above zero, empty for none, and nothing else', async () => {
  const bridge = fake(), view = page(bridge);
  try {
    view.render(); await settle();
    const type = value => view.budget().props.onChange({ target: { value } });
    type('50.5'); view.budget().props.onBlur(); await settle();
    type(''); view.budget().props.onKeyDown({ key: 'Enter' }); await settle();
    assert.deepEqual(bridge.calls, [['set', { monthlyBudgetUsd: 50.5 }], ['set', { monthlyBudgetUsd: null }]]);
    view.budget().props.onBlur(); await settle();
    assert.equal(bridge.calls.length, 2, 'an unchanged budget sends nothing');
    for (const bad of ['abc', '0', '-3']) { type(bad); view.budget().props.onBlur(); await settle(); assert.equal(view.alert(), '月预算要大于 0；留空表示不限。', bad); }
    assert.equal(bridge.calls.length, 2, 'and none of those was sent');
  } finally { view.done(); }
});

const LINES = [
  { id: 'key', tone: 'ok', label: '密钥', text: '有效 · 182 ms', hint: null, title: null },
  { id: 'cli', tone: 'bad', label: 'Claude Code', text: '版本过低', hint: '请升级 Claude Code。', title: null },
  { id: 'path', tone: 'warn', label: '新会话将使用', text: '未知', hint: null, title: null },
];
const answer = lines => ({ ok: true, value: { checkedAt: 1, lines } });

test('测试连接 waits for a saved key and for the owner’s click, shows its progress, then lists every line with a tone mark and the next step', async () => {
  let finish; const calls = [];
  const bridge = fake({ testConnection: (...args) => { calls.push(args); return new Promise(resolve => { finish = resolve; }); } }), view = page(bridge);
  try {
    view.render(); await settle();
    assert.equal(view.button('测试连接').props.disabled, true, 'no key saved, nothing to test'); assert.equal(view.button('测试连接').props.title, '先保存 API key');
    view.secret().props.onChange({ target: { value: SECRET } }); view.button('保存').props.onClick(); await settle();
    assert.equal(view.button('测试连接').props.disabled, false); assert.equal(view.button('测试连接').props.title, undefined);
    assert.equal(calls.length, 0, 'saving a key runs no test: only a click does');
    view.button('测试连接').props.onClick();
    assert.ok(view.html().includes('正在测试连接…')); assert.equal(view.button('测试连接').props.disabled, true, 'one test at a time');
    assert.equal(view.secret().props.disabled, true); assert.equal(view.button('保存').props.disabled, true); assert.equal(view.button('清除').props.disabled, true);
    // The bridge call starts asynchronously; a disabled button cannot receive another browser click.
    await settle();
    assert.deepEqual(calls, [[]], 'one owner click starts one test with no key in its arguments');
    assert.equal(view.button('测试连接').props.disabled, true, 'the test stays pending until the bridge answers');
    finish(answer(LINES)); await settle();
    const html = view.html();
    assert.ok(!html.includes('正在测试连接…'));
    for (const text of ['<b>密钥</b><span>有效 · 182 ms</span>', '<b>Claude Code</b><span>版本过低<small>请升级 Claude Code。</small></span>', '<b>新会话将使用</b>', '检测于 09:00']) assert.ok(html.includes(text), text);
    assert.deepEqual(['is-ok', 'is-bad', 'is-warn'].map(tone => html.includes(`<li class="${tone}"`)), [true, true, true], 'each line has a tone class beside its mark');
    assert.equal((html.match(/runtime-test-mark/g) ?? []).length, 3, 'and a mark, so tone is not colour alone');
    assert.deepEqual(calls, [[]], 'the call carries nothing: the key stays in the main process'); assert.ok(!html.includes(SECRET));
  } finally { view.done(); }
});

for (const [billing, path, expectedText, expectedHint, tone] of [
  [{ status: 'ok', source: 'ANTHROPIC_API_KEY' }, 'api', 'ANTHROPIC_API_KEY', null, 'ok'],
  [{ status: 'mismatch', source: 'apiKeyHelper' }, 'terminal', 'apiKeyHelper', 'Claude Code 没有使用这个密钥，新会话将走终端。', 'bad'],
  [{ status: 'mismatch', source: '/login managed key' }, null, '/login managed key', 'Claude Code 没有使用这个密钥，当前设置不允许启动新会话。', 'bad'],
  [{ status: 'unknown', source: null }, 'terminal', '未知', '无法确认 Claude Code 的计费来源，请重试。', 'warn'],
  [undefined, 'terminal', '未知', '无法确认 Claude Code 的计费来源，请重试。', 'warn'],
  [{ status: 'ok', source: SECRET }, null, '未知', '无法确认 Claude Code 的计费来源，请重试。', 'warn'],
]) test(`the settings page renders the real billing-source words and mark (${billing?.status ?? 'older host'}, ${tone}, ${path})`, async () => {
  const wordsHarness = hookHarness('src/features/native-session/native-words.ts', { './i18n': { t: fill } });
  const value = { checkedAt: 1, key: { status: 'ok', detail: null, latencyMs: 10 }, models: ['synthetic-model'],
    cli: { status: 'ok', version: '2.1.318', required: '2.1.317' }, billing, path, reason: null };
  const bridge = fake({ testConnection: async () => ({ ok: true, value }) }); bridge.state.saved = true;
  const view = page(bridge, { clockWords: () => '09:00', connectionLines: test => wordsHarness.render('connectionLines', test).result });
  try {
    view.render(); await settle(); view.button('测试连接').props.onClick(); await settle();
    const row = view.tree().find(node => node.type === 'li' && node.props.children.some(child => child?.type === 'b' && child.props.children === '计费来源'));
    assert.ok(row); assert.equal(row.props.className, `is-${tone}`);
    const html = view.html();
    assert.ok(html.includes(`<b>计费来源</b><span>${expectedText}`));
    if (expectedHint) assert.ok(html.includes(expectedHint));
    assert.equal((html.match(/runtime-test-mark/g) || []).length, 5);
    assert.equal(html.includes(SECRET), false);
    assert.ok(html.indexOf('<b>Claude Code</b>') < html.indexOf('<b>计费来源</b>'));
    assert.ok(html.indexOf('<b>计费来源</b>') < html.indexOf('<b>新会话将使用</b>'));
  } finally { view.done(); wordsHarness.dispose(); }
});

test('a test that cannot finish says why, and a result goes stale when the key or the path changes', async () => {
  const answers = [{ ok: false, error: 'bridge closed' }, answer(LINES), answer(LINES), answer(LINES)];
  const bridge = fake({ testConnection: async () => answers.shift() ?? Promise.reject(new Error('boom')) }); bridge.state.saved = true;
  const view = page(bridge);
  try {
    view.render(); await settle();
    view.button('测试连接').props.onClick(); await settle();
    assert.equal(view.alert(), '测试没有完成：bridge closed'); assert.ok(!view.html().includes('检测于'));
    view.button('测试连接').props.onClick(); await settle();
    assert.ok(view.html().includes('检测于 09:00')); assert.equal(view.alert(), undefined);
    view.select('Claude 的运行方式').props.onChange('api-only'); await settle();
    assert.ok(!view.html().includes('检测于'), 'another path, another answer: the old one is gone');
    view.button('测试连接').props.onClick(); await settle();
    assert.ok(view.html().includes('检测于 09:00'));
    view.button('清除').props.onClick(); await settle();
    assert.ok(!view.html().includes('检测于'), 'a cleared key leaves no result'); assert.equal(view.button('测试连接').props.disabled, true);
  } finally { view.done(); }
  const sync = page(fake({ testConnection: () => { throw new Error('no bridge call'); } }));
  try {
    sync.render(); await settle(); sync.secret().props.onChange({ target: { value: SECRET } }); sync.button('保存').props.onClick(); await settle();
    sync.button('测试连接').props.onClick(); await settle();
    assert.equal(sync.alert(), '测试没有完成：no bridge call', 'a bridge that throws is an error line, never a hang');
    assert.equal(sync.button('测试连接').props.disabled, false, 'and the owner can try again');
  } finally { sync.done(); }
});

test('a window without the bridge says so and offers nothing to change', () => {
  const view = page(null);
  try {
    assert.match(view.html(), /这个版本没有原生会话。/); assert.equal(view.tree().filter(node => node.type === 'input').length, 0);
  } finally { view.done(); }
});

test('the budget parser: dollars above zero to the cent, empty is none, anything else is not a budget', () => {
  const harness = hookHarness('src/features/settings/AgentRuntimeSettings.tsx', { '@phosphor-icons/react': new Proxy({}, { get: () => () => null }), './i18n': { t: fill }, './agent-runtime-settings.css': {}, './Select': {}, './native-words': wordsStub });
  const parse = text => harness.render('parseBudget', text).result;
  assert.deepEqual(['50', '0.5', ' 12 ', '1e3', '', '   '].map(text => parse(text)), [50, 0.5, 12, 1000, null, null]);
  assert.deepEqual(['0', '-1', 'abc', 'Infinity', '1,5'].map(text => parse(text)), [undefined, undefined, undefined, undefined, undefined]);
});

test('the key goes only to keySave and is never read back, logged or stored; the page is a section of the settings dialog', () => {
  const code = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8').replace(/\/\/.*$/gm, '');
  const settings = code('src/features/settings/AgentRuntimeSettings.tsx');
  assert.deepEqual([...new Set([...settings.matchAll(/\bbridge\.(\w+)\(/g)].map(match => match[1]))].sort(), ['getSettings', 'keyClear', 'keySave', 'keyStatus', 'setSettings', 'testConnection']);
  assert.doesNotMatch(settings, /console\.|localStorage|sessionStorage|keyGet|readKey/, 'no way to read the key back, no log, no storage');
  assert.match(settings, /type="password"/);
  const dialog = code('src/features/settings/SettingsDialog.tsx');
  assert.match(dialog, /id: 'runtime', title: t\('运行方式'\)/); assert.match(dialog, /<AgentRuntimeSettings \/>/);
});

test('the page’s spacing values are on the scale and its buttons keep a 32px hit area', () => {
  const css = fs.readFileSync(path.join(__dirname, '../src/features/settings/agent-runtime-settings.css'), 'utf8'), scale = new Set([0, 2, 4, 8, 12, 16, 20, 24, 32, 40, 48, 64]);
  for (const [, property, value] of css.matchAll(/\b((?:padding|margin|gap|column-gap|row-gap)(?:-\w+)?): ([^;}]+)[;}]/g))
    for (const size of value.match(/-?\d+(?:\.\d+)?px/g) ?? []) assert.ok(scale.has(Math.abs(parseFloat(size))), `${property}: ${size}`);
  assert.match(css, /\.runtime-key \.text-button \{ min-height: 32px;/);
});

test('every accepted change (key saved, key cleared, a setting, the budget) makes the usage card read again; a refused one does not', async () => {
  const bridge = fake(), view = page(bridge);
  try {
    view.render(); await settle();
    view.secret().props.onChange({ target: { value: SECRET } }); view.button('保存').props.onClick(); await settle();
    assert.equal(view.usage.length, 1, 'a saved key');
    view.button('清除').props.onClick(); await settle();
    assert.equal(view.usage.length, 2, 'a cleared key');
    view.select('Claude 的运行方式').props.onChange('api-only'); await settle();
    assert.equal(view.usage.length, 3, 'Claude’s path');
    view.select('Codex 的界面').props.onChange('terminal'); await settle();
    assert.equal(view.usage.length, 4, 'Codex’s view');
    view.budget().props.onChange({ target: { value: '25' } }); view.budget().props.onBlur(); await settle();
    assert.equal(view.usage.length, 5, 'the budget');
  } finally { view.done(); }
  const refused = { ok: false, error: 'refused' };
  const bad = fake({ keySave: async () => refused, keyClear: async () => refused, setSettings: async () => refused });
  bad.state.saved = true;
  const again = page(bad);
  try {
    again.render(); await settle();
    again.secret().props.onChange({ target: { value: SECRET } }); again.button('保存').props.onClick(); await settle();
    again.button('清除').props.onClick(); await settle();
    again.select('Claude 的运行方式').props.onChange('api-only'); await settle();
    again.budget().props.onChange({ target: { value: '25' } }); again.budget().props.onBlur(); await settle();
    assert.deepEqual(again.usage, [], 'nothing was accepted, so nothing to read again');
  } finally { again.done(); }
});
