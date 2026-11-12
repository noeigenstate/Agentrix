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
const defaults = { claudePath: 'api-then-terminal', monthlyBudgetUsd: null };
// The words of a connection test have their own tests (native-session-ui.test.cjs); here a result carries the lines it should show.
const wordsStub = { clockWords: () => '09:00', connectionLines: test => test.lines };

// The page with real hooks. The select is stood in by a component that keeps its props, so a test can read its value and choose an option.
function page(bridge, words = wordsStub, props = {}) {
  const usage = [];
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { agentrix: bridge ? { nativeSession: bridge } : {} } });
  const harness = hookHarness('src/features/settings/AgentRuntimeSettings.tsx', {
    '@phosphor-icons/react': new Proxy({}, { get: () => () => null }), './i18n': { t: fill }, './agent-runtime-settings.css': {}, './native-words': words, './native-store.ts': { usageChanged: () => usage.push('changed'), useUsageRevision: () => 0 },
    './Select': { Select: props => React.createElement('select', { 'aria-label': props.label, value: props.value, disabled: props.disabled }) },
  });
  const render = () => harness.render('AgentRuntimeSettings', props).result, tree = () => elements(render());
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
  const calls = [], reads = [], state = { settings: { ...defaults }, saved: false, usageValue: { switches: { waiting: 0 } } };
  return { calls, reads, state, usage: async projectId => { reads.push(projectId); return { ok: true, value: state.usageValue }; }, getSettings: async () => ({ ok: true, value: state.settings }), keyStatus: async () => ({ ok: true, value: { saved: state.saved } }),
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
    assert.doesNotMatch(view.html(), /Codex 的界面/, 'Codex has only app-server, so there is nothing to choose');
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
    assert.deepEqual(bridge.calls, [['set', { claudePath: 'api-only' }]]);
    assert.equal(view.select('Claude 的运行方式').props.value, 'api-only');
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
    assert.deepEqual(calls, [[undefined]], 'one owner click starts one test whose only argument is the project in use (none here), never a key');
    assert.equal(view.button('测试连接').props.disabled, true, 'the test stays pending until the bridge answers');
    finish(answer(LINES)); await settle();
    const html = view.html();
    assert.ok(!html.includes('正在测试连接…'));
    for (const text of ['<b>密钥</b><span>有效 · 182 ms</span>', '<b>Claude Code</b><span>版本过低<small>请升级 Claude Code。</small></span>', '<b>新会话将使用</b>', '检测于 09:00']) assert.ok(html.includes(text), text);
    assert.deepEqual(['is-ok', 'is-bad', 'is-warn'].map(tone => html.includes(`<li class="${tone}"`)), [true, true, true], 'each line has a tone class beside its mark');
    assert.equal((html.match(/runtime-test-mark/g) ?? []).length, 3, 'and a mark, so tone is not colour alone');
    assert.deepEqual(calls, [[undefined]], 'the call carries no key (only the project in use, none here): the key stays in the main process'); assert.ok(!html.includes(SECRET));
    // A line that compares two installs lays each out as a block: label, words, and the file on a line of its own.
    const TOOLS = String.raw`C:\Tools\claude.exe`;
    view.button('测试连接').props.onClick(); await settle();
    finish(answer([{ id: 'cli', tone: 'warn', label: 'Claude Code', text: '原生 · 版本 2.1.322', hint: '不是同一个', title: null,
      blocks: [{ label: '终端', text: '版本 2.1.300 · 来自 PATH', file: TOOLS }, { label: '原生', text: '版本 2.1.322 · 来自 官方安装器', file: null }] }])); await settle();
    const split = view.html();
    assert.ok(split.includes(`<span class="runtime-test-block"><b>终端</b><span>版本 2.1.300 · 来自 PATH<span class="runtime-test-file">${TOOLS}</span></span></span>`), 'the file sits in its own element under the words');
    assert.ok(split.includes('<span class="runtime-test-block"><b>原生</b><span>版本 2.1.322 · 来自 官方安装器</span></span>'), 'a block without a file has none');
    assert.equal((split.match(/runtime-test-split/g) ?? []).length, 1);
  } finally { view.done(); }
});

for (const [billing, path, expectedText, expectedHint, tone] of [
  [{ status: 'ok', source: 'ANTHROPIC_API_KEY' }, 'api', 'ANTHROPIC_API_KEY', null, 'ok'],
  [{ status: 'mismatch', source: 'apiKeyHelper' }, 'terminal', 'apiKeyHelper', 'Claude Code 没有使用这个密钥。', 'bad'],
  [{ status: 'mismatch', source: '/login managed key' }, null, '/login managed key', 'Claude Code 没有使用这个密钥。 当前设置不允许启动新会话。', 'bad'],
  [{ status: 'unknown', source: null }, 'terminal', '未知', '无法确认 Claude Code 的计费来源，请重试。', 'warn'],
  [undefined, 'terminal', '未知', '无法确认 Claude Code 的计费来源，请重试。', 'warn'],
  [{ status: 'ok', source: SECRET }, null, '未知', '无法确认 Claude Code 的计费来源，请重试。', 'warn'],
  // A managed apiKeyHelper keeps apiKeySource=ANTHROPIC_API_KEY (real 2.1.322): the row names the helper and main's reason.
  [{ status: 'mismatch', source: 'ANTHROPIC_API_KEY', reported: { apiKeySource: 'ANTHROPIC_API_KEY', tokenSource: 'apiKeyHelper' },
    detail: { text: '托管策略配置了 apiKeyHelper。（{detail}）', values: { detail: 'tokenSource=apiKeyHelper' } } }, 'terminal', 'apiKeyHelper', '托管策略配置了 apiKeyHelper。（tokenSource=apiKeyHelper）', 'bad'],
  [{ status: 'mismatch', source: null, reported: { apiKeySource: 'weird-source', tokenSource: null },
    detail: { text: 'Claude Code 报告的计费来源不是 ANTHROPIC_API_KEY。', values: {} } }, null, '未知值', 'Claude Code 报告的计费来源不是 ANTHROPIC_API_KEY。 当前设置不允许启动新会话。', 'bad'],
  [{ status: 'unknown', source: null, detail: { text: 'Claude Code 初始化 {seconds} 秒仍未完成，无法确认计费来源。请稍后重试。', values: { seconds: 31 } } },
    'terminal', '未知', 'Claude Code 初始化 31 秒仍未完成，无法确认计费来源。请稍后重试。', 'warn'],
]) test(`the settings page renders the real billing-source words and mark (${billing?.status ?? 'older host'}, ${billing?.reported?.tokenSource ?? billing?.reported?.apiKeySource ?? (billing?.detail ? 'with reason' : 'plain')}, ${tone}, ${path})`, async () => {
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
  assert.deepEqual([...new Set([...settings.matchAll(/\bbridge\.(\w+)\(/g)].map(match => match[1]))].sort(), ['getSettings', 'keyClear', 'keySave', 'keyStatus', 'setSettings', 'testConnection', 'usage']);
  assert.doesNotMatch(settings, /console\.|localStorage|sessionStorage|keyGet|readKey/, 'no way to read the key back, no log, no storage');
  assert.match(settings, /type="password"/);
  const dialog = code('src/features/settings/SettingsDialog.tsx');
  assert.match(dialog, /id: 'runtime', title: t\('运行方式'\)/); assert.match(dialog, /<AgentRuntimeSettings[ >]/);
  // The project in view reaches the page, so the connection test and the usage numbers are read for its scope.
  assert.match(dialog, /<AgentRuntimeSettings projectId=\{projectId\} focusOnOpen=\{focusOnOpen\} \/>/); assert.match(code('src/App.tsx'), /<SettingsDialog [^>]*projectId=\{focus\?\.id\}/);
});

test('Codex’s automatic reset is a switch that is off by default, saves alone without a path change or a stale test, and a refusal leaves it as it was', async () => {
  const bridge = fake(), view = page(bridge), reset = () => view.tree().find(node => node.type === 'input' && node.props.type === 'checkbox');
  try {
    view.render(); await settle();
    assert.equal(reset().props.checked, false, 'a setting main did not give is the default: off');
    assert.match(view.html(), /额度用完时自动使用重置次数[\s\S]*到达上限时自动用掉 1 次重置，用掉不能撤销/);
    reset().props.onChange({ target: { checked: true } }); await settle();
    assert.deepEqual(bridge.calls, [['set', { codexAutoReset: true }]], 'only this field is sent');
    assert.equal(reset().props.checked, true); assert.deepEqual(view.usage, [], 'it is not a path change: the usage card is not asked to read again');
    bridge.setSettings = async () => ({ ok: false, error: 'disk full' });
    reset().props.onChange({ target: { checked: false } }); await settle();
    assert.equal(reset().props.checked, true); assert.equal(view.alert(), 'disk full');
  } finally { view.done(); }
  const stored = fake(); stored.state.settings.codexAutoReset = true;
  const again = page(stored);
  try { again.render(); await settle(); assert.equal(again.tree().find(node => node.type === 'input' && node.props.type === 'checkbox').props.checked, true, 'the saved choice is shown'); } finally { again.done(); }
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
    view.budget().props.onChange({ target: { value: '25' } }); view.budget().props.onBlur(); await settle();
    assert.equal(view.usage.length, 4, 'the budget');
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

test('the page says a change applies to running sessions, counts those waiting from main’s number only, and reads usage and the test for the current project', async () => {
  const bridge = fake({ testConnection: async (...args) => { bridge.calls.push(['test', ...args]); return answer([]); } }), view = page(bridge, wordsStub, { projectId: 'p7' });
  bridge.state.saved = true;
  try {
    view.render(); await settle();
    assert.match(view.html(), /同时应用到正在运行的会话/);
    assert.doesNotMatch(view.html(), /在等待切换/, 'no session waiting: the line is absent, not “0”');
    assert.deepEqual(bridge.reads, ['p7'], 'usage is read for the project in use');
    view.button('测试连接').props.onClick(); await settle();
    assert.deepEqual(bridge.calls.find(call => call[0] === 'test'), ['test', 'p7'], 'so is the connection test');
  } finally { view.done(); }
  for (const [value, shown] of [[{ switches: { waiting: 3 } }, '有 3 个会话在等待切换'], [{ switches: { waiting: 0 } }, null], [{}, null], [{ switches: { waiting: '2' } }, null]]) {
    const waiting = fake(); waiting.state.usageValue = value;
    const again = page(waiting);
    try {
      again.render(); await settle();
      const line = again.tree().find(node => node.props?.role === 'status' && node.type === 'p')?.props.children;
      assert.equal(line ? elementsText(line) : null, shown, JSON.stringify(value));
    } finally { again.done(); }
  }
  const failed = fake({ usage: async () => ({ ok: false, error: 'down' }) }), none = page(failed);
  try { none.render(); await settle(); assert.doesNotMatch(none.html(), /在等待切换/, 'a failed read claims nothing'); } finally { none.done(); }
});
const elementsText = node => (Array.isArray(node) ? node.map(elementsText).join('') : React.isValidElement(node) ? elementsText(node.props.children) : typeof node === 'string' ? node : '');
// The agents page over a fake main: `saved` is what keyStatus answers (null: it cannot say); Windows or not decides the installer's command.
function agentsPage(saved, { windows = true, visible = true } = {}) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window'), reads = [];
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { agentrix: {} } });
  const bridge = { keyStatus: async () => { reads.push(1); return saved === null ? { ok: false, error: 'x' } : { ok: true, value: { saved } }; } };
  const harness = hookHarness('src/features/agents/AgentsSettings.tsx', { './i18n': { t: fill }, './platform': { isWindows: windows },
    './native-words': { viaWords: via => via, installerCommand: win => (win ? 'irm-installer' : 'curl-installer') }, './native-bridge.ts': { nativeBridge: () => bridge } });
  // The first render starts the key read, the second shows its answer.
  const render = async claude => {
    const props = { agents: { codex: { installed: true }, claude, npm: true, installing: null, message: '', error: '' }, onChange() {}, visible };
    harness.render('AgentsSettings', props); await settle();
    const section = elements(harness.render('AgentsSettings', props).result).filter(node => node.props?.className === 'agent-setting')[1];
    const inside = elements(section.props.children);
    return { status: elementsText(inside.find(node => node.type === 'small' && node.props.role === 'status').props.children), title: inside.find(node => node.type === 'small' && node.props.role === 'status').props.title,
      hint: inside.filter(node => node.type === 'small' && !node.props.role).map(node => elementsText(node.props.children))[0] ?? null,
      command: elementsText(inside.find(node => node.type === 'code')?.props.children), install: inside.some(node => node.type === 'button') };
  };
  return { render, reads, done() { harness.dispose(); if (previous) Object.defineProperty(globalThis, 'window', previous); else delete globalThis.window; } };
}
const NPM_COMMAND = 'npm install -g @anthropic-ai/claude-code';

test('the agents page says where Claude Code was found beside 已安装, and only 已安装 when main gave nothing more', async () => {
  const view = agentsPage(true);
  try {
    assert.deepEqual(await view.render({ installed: true }), { status: '已安装', title: undefined, hint: null, command: NPM_COMMAND, install: false });
    const found = await view.render({ installed: true, version: '2.1.322', via: 'npm', fileShown: '~/x/claude.exe' });
    assert.deepEqual([found.status, found.title, found.hint], ['已安装 · 版本 2.1.322 · 来自 npm', '~/x/claude.exe', null]);
    assert.deepEqual(await view.render({ installed: false }), { status: '未安装', title: undefined, hint: null, command: NPM_COMMAND, install: true });
  } finally { view.done(); }
});

test('a split, an old install, a failed check and an incomplete npm install are told with a step the owner can take: the connection test with a key saved, without one the installer or saving the key', async () => {
  const test = '到「运行方式 › 测试连接」查看原因。', saveFirst = '检查没有通过。先在「运行方式」里保存 API 密钥，再点「测试连接」查看原因。';
  const split = { installed: true, version: '2.1.300', via: 'path', fileShown: 'x', notice: 'cli_split_versions', native: { version: '2.1.322', via: 'local-bin', fileShown: 'y' } };
  for (const saved of [true, false, null]) {
    const view = agentsPage(saved);
    try {
      const label = `key saved: ${saved}`;
      assert.deepEqual([(await view.render(split)).status, (await view.render(split)).hint], ['已安装 · 终端用版本 2.1.300 · 来自 path', '原生用的是另一份：版本 2.1.322 · 来自 local-bin'], label);
      assert.deepEqual(await view.render({ installed: true, version: '2.1.300', via: 'path', reason: 'too_old' }), { status: '版本 2.1.300 过低 · 来自 path', title: undefined, hint: '请升级 Claude Code。', command: NPM_COMMAND, install: false }, label);
      for (const reason of ['timeout', 'failed', 'unreadable']) {
        const failed = await view.render({ installed: true, reason });
        assert.deepEqual([failed.status, failed.hint, failed.install], ['已安装 · 检查未通过', saved === false ? saveFirst : test, false], `${label} ${reason}`);
      }
      // Incomplete: the page no longer offers the npm command that made it, but the official installer's; without a key it is in the hint too.
      const incomplete = await view.render({ installed: true, incomplete: true });
      assert.deepEqual([incomplete.status, incomplete.command, incomplete.install], ['安装不完整', 'irm-installer', false], label);
      assert.equal(incomplete.hint, saved === false ? 'npm 装了，但里面没有原生程序。请用官方安装器重新安装：irm-installer' : `npm 装了，但里面没有原生程序。${test}`, label);
    } finally { view.done(); }
  }
  const other = agentsPage(false, { windows: false });
  try { assert.equal((await other.render({ installed: true, incomplete: true })).command, 'curl-installer', 'elsewhere the shell installer'); } finally { other.done(); }
});

test('the agents page reads the saved key when it is shown, and not while it is hidden', async () => {
  const hidden = agentsPage(true, { visible: false });
  try { await hidden.render({ installed: true }); assert.equal(hidden.reads.length, 0); } finally { hidden.done(); }
  const shown = agentsPage(true);
  try { await shown.render({ installed: true }); assert.equal(shown.reads.length, 1); } finally { shown.done(); }
});

test('a page opened to deal with the connection gives its focus to the test button, or to the key field when no key is saved, and only when asked', async () => {
  for (const [saved, expected] of [[true, 'test'], [false, 'key']]) {
    const bridge = fake(), props = {}, view = page(bridge, wordsStub, props), focused = [];
    bridge.state.saved = saved;
    try {
      view.render(); await settle();
      // The refs belong to elements that are on screen once rendered: stand in for them, then ask for the focus.
      view.secret().props.ref.current = { focus: () => focused.push('key') }; view.button('测试连接').props.ref.current = { focus: () => focused.push('test') };
      view.render(); assert.deepEqual(focused, [], 'a page opened by the menu takes no focus');
      props.focusOnOpen = true; view.render();
      assert.deepEqual(focused, [expected], `key saved: ${saved}`);
    } finally { view.done(); }
  }
});
