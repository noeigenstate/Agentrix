const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { hookHarness } = require('./helpers/hook-harness.cjs');

// The native session view: the model the events fold into, the store that keeps it, the view and its request cards, the launcher's choice of
// route, the grid cell it takes and the parent relay that no longer types. A fake bridge stands in for the main process everywhere: no real
// SDK, app-server, key or account is ever touched.
const src = path.join(__dirname, '..', 'src');


function makeLoader(overrides = {}) {
  const cache = new Map();
  const resolve = (from, name) => [name, `${name}.ts`, `${name}.tsx`].map(candidate => path.resolve(path.dirname(from), candidate)).find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
  function load(filename) {
    if (cache.has(filename)) return cache.get(filename).exports;
    const mod = new Module(filename, module);
    mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename));
    cache.set(filename, mod);
    const original = mod.require.bind(mod);
    mod.require = name => {
      if (Object.hasOwn(overrides, name)) return overrides[name];
      if (name.endsWith('.css')) return {};
      if (name.endsWith('.json')) return original(name);
      if (name === '@phosphor-icons/react') return new Proxy({}, { get: (_, icon) => () => React.createElement('svg', { 'data-icon': icon }) });
      return name.startsWith('.') ? load(resolve(filename, name)) : original(name);
    };
    mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename);
    return mod.exports;
  }
  return relative => load(path.join(src, relative));
}

// The heavy neighbours are stood in: Markdown by an element that says its text, the avatar and the width-fitting hook by plain ones.
const fit = { index: 0 };   // which hint the width-fitting hook says fits; one past the list is "none does"
const load = makeLoader({
  './Markdown': { Markdown: ({ text }) => React.createElement('div', { className: 'md' }, text) },
  '../../shared/UserAvatar': { UserAvatar: () => React.createElement('i', { className: 'avatar' }) },
  '../../shared/useFittingHint': { fullHintProps: () => ({}), HIDDEN_NOTE: {}, useFittingHint: (box, hints) => hints[fit.index] ?? '' },
  './ResetQuota': { ResetQuota: () => null },
  '../voice/voice-input': { dictateInto: () => () => {} },
  '../voice/VoiceButton': { VoiceButton: ({ disabled, name }) => React.createElement('button', { type: 'button', className: 'icon-button voice-button', disabled, 'aria-label': `语音输入 ${name}` }) },
});
const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
before(() => { Object.defineProperty(globalThis, 'document', { configurable: true, value: { documentElement: { dataset: {}, lang: '' }, getElementById: () => null } }); load('shared/i18n.ts').applyLanguage('zh'); });
after(() => { if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument); else delete globalThis.document; });

const settle = async () => { for (let round = 0; round < 6; round++) await new Promise(resolve => setImmediate(resolve)); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const elements = node => Array.isArray(node) ? node.flatMap(elements) : React.isValidElement(node) ? [node, ...elements(node.props.children)] : [];
// The same, with the hook-free components below the first level run as well, so a card’s inner parts are seen.
const deep = node => Array.isArray(node) ? node.flatMap(deep) : React.isValidElement(node) ? (typeof node.type === 'function' ? deep(node.type(node.props)) : [node, ...deep(node.props.children)]) : [];
const fill = (text, values = {}) => text.replace(/\{(\w+)\}/g, (match, key) => values[key] ?? match);

// What main answers a /status or /usage query with, in the send receipt's `local` field (never an item of the conversation).
const statusLocal = (over = {}) => ({ command: 'status',
  session: { model: 'gpt-6.1-sol', effort: 'high', fast: true, approval: 'never', sandbox: 'readOnly', cwd: '/offline/project' },
  account: { provider: 'openai', kind: 'subscription' },
  tokens: { total: 130, input: 100, output: 30, cachedInput: 20, reasoning: 10, context: 60000, window: 200000 },
  limits: [{ id: '5h', usedPercent: 25, resetsAtMs: 2000000000000 }, { id: 'week', usedPercent: 100, resetsAtMs: 2000500000000 }], errors: [], ...over });
const nothingKnown = { command: 'status', session: {}, account: {}, tokens: {}, limits: [], errors: [] };

const NOW = 2000000000000;
const rowsOf = group => group.rows.map(row => [row.label, row.value, row.note]);
const readPanel = (agent, local) => load('features/native-session/panel-read.ts').readPanel(agent, { status: 'consumed', local }, NOW);

test('the Codex panels read main’s facts: the quota used up is the alert, the groups are quota bars, rows and chips, and what is not known reads 未知', () => {
  const { codexPanel } = load('features/native-session/panel-codex.ts'), panel = codexPanel(statusLocal(), NOW);
  assert.deepEqual([panel.agent, panel.title, panel.command], ['codex', 'Codex 状态', '/status']);
  assert.equal(panel.alert.strong, '每周额度已用完'); assert.match(panel.alert.text, /^，.+ 恢复$/);
  assert.deepEqual([panel.hero.value, panel.hero.unit, panel.hero.caption, panel.hero.percent], ['60k', '/ 200k', '上下文已用 30%', 30]);
  assert.deepEqual(panel.groups.map(group => [group.kind, group.title]), [['quota', '额度'], ['rows', '会话'], ['chips', '权限'], ['rows', '账号'], ['rows', '本会话 token']]);
  const [quota, session, permissions, account, tokens] = panel.groups;
  assert.deepEqual(quota.quotas.map(row => [row.name, row.used, row.full, row.percent]), [['5 小时', '25%', false, 25], ['每周', '100%', true, 100]]);
  assert.match(quota.quotas[0].when, /^重置于 /); assert.match(quota.quotas[1].when, /^恢复于 /, 'a quota at 100% is used up and says when it recovers');
  assert.deepEqual(rowsOf(session), [['模型', 'gpt-6.1-sol', undefined], ['思考强度', 'high', undefined], ['快速模式', '开', undefined], ['工作目录', '/offline/project', undefined]]);
  assert.deepEqual(permissions.chips, [{ text: '审批：从不询问' }, { text: '沙箱：只读', warn: false }]);
  assert.deepEqual(rowsOf(account), [['登录方式', 'ChatGPT 订阅', undefined], ['模型服务', 'OpenAI', undefined]]);
  assert.deepEqual(rowsOf(tokens), [['合计', '130', undefined], ['输入', '100', '其中缓存 20'], ['输出', '30', '其中推理 10']]);
  assert.deepEqual(codexPanel(statusLocal({ session: { ...statusLocal().session, sandbox: 'dangerFullAccess' } }), NOW).groups[2].chips[1], { text: '沙箱：完全访问', warn: true }, 'full access is the one chip that warns');

  const blank = codexPanel(nothingKnown, NOW);
  assert.deepEqual([blank.hero, blank.alert], [undefined, undefined]);
  for (const group of blank.groups.filter(group => group.kind === 'rows')) for (const row of group.rows) assert.equal(row.value, '未知', row.label);
  assert.deepEqual(blank.groups[2].chips.map(chip => chip.text), ['审批：未知', '沙箱：未知']);
  assert.ok(blank.groups[0].quotas.every(row => row.used === '未知' && row.when === '' && !row.full && row.percent === null), 'no zero and no guess');
  assert.equal(codexPanel({ command: 'compact' }, NOW), null); assert.equal(codexPanel(null, NOW), null);
  assert.equal(codexPanel(statusLocal({ tokens: { total: -1, input: 1.5, output: '3' } }), NOW).groups[4].rows[0].value, '未知', 'a count that is not a count is not known');
});

test('Codex /usage puts the used-up window first and says what the session used; a failed read is the alert and gives its reason, never main’s private message', () => {
  const { codexPanel } = load('features/native-session/panel-codex.ts'), usage = codexPanel(statusLocal({ command: 'usage' }), NOW);
  assert.deepEqual([usage.title, usage.command, usage.hero], ['Codex 额度', '/usage', undefined]);
  assert.deepEqual(usage.groups.map(group => group.title), ['额度', '本会话']);
  assert.deepEqual(usage.groups[0].quotas.map(row => row.name), ['每周', '5 小时'], 'the window that is used up comes first');
  assert.deepEqual(rowsOf(usage.groups[1]), [['合计', '130', undefined], ['上下文', '60k / 200k', '30%']]);
  const failed = codexPanel(statusLocal({ account: { provider: 'openai', kind: 'unknown' }, limits: [], errors: [{ source: 'account', reason: 'RPC -32603' }, { source: 'limits', reason: '请求超时' }] }), NOW);
  assert.deepEqual(failed.alert, { strong: '额度读取失败', text: '（请求超时）' });
  assert.equal(rowsOf(failed.groups[3])[0][1], '读取失败（RPC -32603）'); assert.deepEqual(failed.groups[0].quotas.map(row => row.used), ['读取失败（请求超时）', '读取失败（请求超时）']);
  assert.equal(codexPanel(statusLocal({ errors: [{ source: 'other', reason: 'x' }, { source: 'limits', reason: '' }] }), NOW).alert.strong, '每周额度已用完', 'a source or a reason that is none is dropped');
});

const contextLocal = { command: 'context', context: { model: 'claude-opus-5-5', tokens: 58400, window: 1000000, autoCompact: true, autoCompactThreshold: 830000,
  // The SDK’s own shape: `kind` says what counts as used, `id` names a part; a name is only shown when there is no known id.
  categories: [{ id: 'free-space', name: 'Free space', tokens: 941600, kind: 'free' }, { id: 'autocompact-buffer', name: 'Autocompact buffer', tokens: 33000, kind: 'buffer' }, { id: 'mcp-tools-deferred', name: 'MCP tools (deferred)', tokens: 5000, kind: 'deferred' },
    { id: 'messages', name: 'Messages', tokens: 25800, kind: 'used' }, { id: 'system-prompt', name: 'System prompt', tokens: 14200, kind: 'used' }, { id: 'system-tools', name: 'System tools', tokens: 12100, kind: 'used' },
    { id: 'memory-files', name: 'Memory files', tokens: 6300, kind: 'used' }, { name: 'Buffer files', tokens: 900, kind: 'used' }],
  memory: [{ name: 'MEMORY.md', tokens: 3100 }], mcp: [{ name: 'playwright', tokens: 6800 }], skills: [{ name: 'model-routing', tokens: 2400 }] } };

test('Claude /context: the number and its bar, the three biggest parts and the rest in a composition, and the biggest of each kind', () => {
  const panel = readPanel('claude', contextLocal);
  assert.deepEqual([panel.agent, panel.title, panel.command, panel.alert], ['claude', '上下文用量', '/context', undefined]);
  assert.deepEqual([panel.hero.value, panel.hero.unit, panel.hero.caption, Math.round(panel.hero.percent * 10)], ['58.4k', '/ 1M', '已用 6% · 自动压缩在 83% 触发', 58]);
  const [composition, biggest] = panel.groups;
  assert.deepEqual([composition.kind, composition.title, biggest.title], ['composition', '已用部分的构成', '占用最多的']);
  assert.deepEqual(composition.segments.map(part => [part.label, part.value]), [['对话消息', '25.8k'], ['系统提示', '14.2k'], ['工具定义', '12.1k'], ['其他', '7.2k']], 'only kind "used" is in the bar: free, buffer and deferred parts are not, and a used part whose name says "buffer" is');
  const renamed = categories => readPanel('claude', { ...contextLocal, context: { ...contextLocal.context, categories } }).groups.find(group => group.kind === 'composition')?.segments.map(part => part.label) ?? [];
  const used = (id, name, tokens) => ({ id, name, tokens, kind: 'used' });
  assert.deepEqual(renamed([used('brand-new', 'Brand new', 30), used('System_Prompt', 'Whatever', 20), used(undefined, 'No id', 10)]), ['Brand new', '系统提示', 'No id'], 'by id: an id not known or missing shows the SDK’s own name, a known one the owner’s word whatever its name');
  assert.deepEqual(renamed([{ id: 'messages', name: 'Messages', tokens: 30 }, { id: 'messages', name: 'Messages', tokens: 20, kind: 'free' }]), [], 'a part with no kind is not known to be used');
  assert.ok(Math.abs(composition.segments.reduce((sum, part) => sum + part.share, 0) - 100) < 1e-9);
  assert.deepEqual(rowsOf(biggest), [['MCP 工具', 'playwright', '6.8k'], ['记忆文件', 'MEMORY.md', '3.1k'], ['技能', 'model-routing', '2.4k']]);
  assert.equal(readPanel('claude', { ...contextLocal, context: { ...contextLocal.context, autoCompact: false } }).hero.caption, '已用 6% · 自动压缩已关闭');
  assert.equal(readPanel('claude', { ...contextLocal, context: { ...contextLocal.context, autoCompact: null } }).hero.caption, '已用 6%', 'a setting the SDK did not give is not told');
  assert.equal(readPanel('claude', { command: 'context', context: {} }), null, 'no context from the SDK is a failure to tell, not a window of unknowns');
});

test('Claude /cost: the spend of the session with the month beside it, the time and the models; what is not there is 未知 or left out', () => {
  const local = { command: 'cost', costUsdMicros: 1840000, durationMs: 1390000, apiDurationMs: 402000, month: { spentMicros: 36520000, budgetUsd: 100 },
    models: [{ model: 'claude-opus-5-5', costUsdMicros: 1620000, input: 412000, output: 9800, cacheRead: null, cacheWrite: null }, { model: 'claude-haiku-5-5', costUsdMicros: 220000, input: 188000, output: 4100, cacheRead: null, cacheWrite: null }] };
  const panel = readPanel('claude', local);
  assert.deepEqual([panel.title, panel.command, panel.hero.value, panel.hero.caption, panel.hero.percent], ['本会话花费', '/cost', '$1.84', 'API 计费 · 本月已用 $36.52 / $100', 36.52]);
  assert.deepEqual(panel.groups.map(group => group.title), ['用时（本次打开以来）', '按模型']);
  assert.deepEqual(rowsOf(panel.groups[0]), [['总用时', '23 分 10 秒', undefined], ['API 用时', '6 分 42 秒', undefined]]);
  assert.deepEqual(rowsOf(panel.groups[1]), [['claude-opus-5-5', '$1.62', '输入 412k · 输出 9.8k'], ['claude-haiku-5-5', '$0.22', '输入 188k · 输出 4.1k']]);
  const bare = readPanel('claude', { command: 'cost', costUsdMicros: null, durationMs: null, apiDurationMs: null, models: [], month: { spentMicros: null, budgetUsd: null } });
  assert.deepEqual([bare.hero.value, bare.hero.caption, bare.hero.percent, bare.groups], ['未知', 'API 计费', null, []], 'no spend is not $0.00, and nothing else is invented');
  assert.equal(readPanel('claude', { ...local, costUsdMicros: 3000 }).hero.value, '<$0.01');
});

test('Claude /status and /usage: the session and account rows, the spend of the month with its quota windows, and a notice or a failed read as the alert', () => {
  const status = readPanel('claude', { command: 'status', context: contextLocal.context, errors: [], account: { kind: 'api' },
    session: { model: 'claude-opus-5-5', effort: 'high', cwd: '/work', sessionId: 'abc-123', version: '2.1.318', permission: 'default', mcp: [{ name: 'playwright', status: 'connected' }] } });
  assert.deepEqual([status.title, status.command, status.alert, status.hero.value], ['Claude 状态', '/status', undefined, '58.4k']);
  assert.deepEqual(status.groups.map(group => group.title), ['会话', '账号', 'MCP 服务']);
  assert.deepEqual(rowsOf(status.groups[0]).map(row => row.slice(0, 2)), [['模型', 'claude-opus-5-5'], ['思考强度', 'high'], ['工作目录', '/work'], ['会话 ID', 'abc-123'], ['Claude Code 版本', '2.1.318'], ['权限模式', 'default']]);
  assert.deepEqual([rowsOf(status.groups[1])[0].slice(0, 2), rowsOf(status.groups[2])[0].slice(0, 2)], [['登录方式', 'API 密钥'], ['playwright', 'connected']]);
  const failed = readPanel('claude', { command: 'status', context: null, errors: [{ source: 'context', reason: '原因未知' }], account: { kind: 'unknown' }, session: { model: null, effort: null, cwd: null, sessionId: null, version: null, permission: null, mcp: [] } });
  assert.deepEqual([failed.alert, failed.hero, failed.groups.map(group => group.title)], [{ strong: '上下文读取失败', text: '（原因未知）' }, undefined, ['会话', '账号']]);
  assert.deepEqual(rowsOf(failed.groups[0]).map(row => row[1]), ['未知', '未知', '未知', '未知'], 'what the session does not know is not left out of the core rows, and the optional ones are');
  assert.equal(rowsOf(failed.groups[1])[0][1], '未知');

  const local = { command: 'usage', month: { spentMicros: 36520000, budgetUsd: 100 }, today: { spentMicros: 1840000 }, tokens: { input: 600000, output: 13900, cacheRead: null, cacheWrite: null }, notice: null,
    limits: [{ id: 'five_hour', usedPercent: 100, resetsAtMs: NOW }, { id: 'seven_day', usedPercent: 40, resetsAtMs: NOW + 3600000 }] };
  const usage = readPanel('claude', local);
  assert.deepEqual([usage.title, usage.command, usage.hero.value, usage.hero.unit, usage.hero.caption, usage.hero.percent], ['Claude 用量', '/usage', '$36.52', '/ $100', '本月 API 花费', 36.52]);
  assert.equal(usage.alert.strong, '5 小时额度已用完');
  assert.deepEqual(usage.groups.map(group => group.title), ['用量限额', '花费', '本会话 token']);
  assert.deepEqual(usage.groups[0].quotas.map(row => [row.name, row.used, row.full]), [['5 小时', '100%', true], ['每周', '40%', false]]);
  assert.deepEqual([rowsOf(usage.groups[1]).map(row => row.slice(0, 2)), rowsOf(usage.groups[2]).map(row => row.slice(0, 2))], [[['今天', '$1.84'], ['本月', '$36.52']], [['输入', '600,000'], ['输出', '13,900']]]);
  assert.deepEqual(readPanel('claude', { ...local, limits: [], notice: { code: 'credits_required', resetsAtMs: null } }).alert, { strong: 'API 余额不足', text: '' }, 'the notice the SDK gave is told in our words');
  const none = readPanel('claude', { command: 'usage', month: { spentMicros: null, budgetUsd: null }, today: { spentMicros: null }, tokens: {}, limits: [], notice: null });
  assert.deepEqual([none.hero.value, none.hero.unit, none.hero.percent, none.alert, none.groups.map(group => group.title)], ['未知', undefined, null, undefined, ['花费']]);
});

test('a panel is also plain text for "copy all", and a receipt that answers nothing is no panel', () => {
  const { panelText, localOf } = load('features/native-session/native-panel.ts'), panel = readPanel('codex', statusLocal());
  const text = panelText(panel).split('\n');
  assert.equal(text[0], 'Codex 状态 /status'); assert.match(text[1], /^每周额度已用完，.+ 恢复$/);
  assert.ok(text.includes('模型  gpt-6.1-sol') && text.includes('输入  100 其中缓存 20') && text.includes('审批：从不询问 / 沙箱：只读'), 'rows, notes and chips each read as a line');
  assert.match(text.at(-1), /^\d{2}:\d{2} 读取$/);
  const { readPanel: read } = load('features/native-session/panel-read.ts');
  assert.deepEqual([read('codex', { status: 'consumed' }), read('claude', { local: { command: 'compact' } }), read('claude', null), localOf({ local: { command: 'cost' } }).command], [null, null, null, 'cost']);
});

test('a reset or recovery time reads 今天 HH:MM today and 11月13日 周四 16:26 on another day, in the alert and on the quota bar alike; English says Thu, Nov 13, 16:26', () => {
  const { resetWords } = load('features/native-session/native-panel.ts'), { codexPanel } = load('features/native-session/panel-codex.ts'), i18n = load('shared/i18n.ts');
  const now = new Date(2025, 10, 10, 9, 0).getTime(), today = new Date(2025, 10, 10, 19, 22).getTime(), thursday = new Date(2025, 10, 13, 16, 26).getTime(), tomorrow = new Date(2025, 10, 11, 0, 5).getTime();
  assert.deepEqual([resetWords(today, now), resetWords(thursday, now), resetWords(tomorrow, now)], ['今天 19:22', '11月13日 周四 16:26', '11月11日 周二 00:05']);
  const panel = codexPanel(statusLocal({ limits: [{ id: '5h', usedPercent: 0, resetsAtMs: today }, { id: 'week', usedPercent: 100, resetsAtMs: thursday }] }), now);
  assert.deepEqual([panel.alert.text, panel.groups[0].quotas.map(row => row.when)], ['，11月13日 周四 16:26 恢复', ['重置于 今天 19:22', '恢复于 11月13日 周四 16:26']], 'the alert and the bar say it the same way');
  i18n.applyLanguage('en');
  try {
    assert.deepEqual([resetWords(today, now), resetWords(thursday, now)], ['Today 19:22', 'Thu, Nov 13, 16:26']);
    assert.equal(codexPanel(statusLocal({ limits: [{ id: '5h', usedPercent: 0, resetsAtMs: today }, { id: 'week', usedPercent: 100, resetsAtMs: thursday }] }), now).alert.text, ', recovers Thu, Nov 13, 16:26');
  } finally { i18n.applyLanguage('zh'); }
});

test('the panel is the approved sheet: mark, title, command and three buttons; alert, number and bar; the five kinds of group; the footer; skeleton bars while asking', () => {
  const { NativePanel } = load('features/native-session/NativePanel.tsx');
  const html = state => renderToStaticMarkup(React.createElement(NativePanel, { state, onClose() {}, onRefresh() {} }));
  const ready = (agent, local) => html({ agent, command: local.command, state: 'ready', panel: readPanel(agent, local) });
  const sheet = ready('codex', statusLocal());
  assert.match(sheet, /<dialog open="" [^>]*class="native-panel"[^>]*aria-modal="true"[^>]*aria-label="Codex 状态"/);
  assert.match(sheet, /native-panel-mark"><svg[^>]*agent-brand-codex/, 'the app’s own brand mark, not a drawing of its own');
  assert.match(sheet, /<strong class="native-panel-title">Codex 状态<\/strong><code class="native-panel-cmd">\/status<\/code>/);
  assert.deepEqual([...sheet.matchAll(/<button type="button" class="icon-button" title="([^"]*)"/g)].map(match => match[1]), ['重新读取', '复制全部', '关闭（Esc）'], 'refresh, copy all, close');
  assert.match(sheet, /<div class="native-panel-alert" role="alert"><svg data-icon="WarningCircle"><\/svg><span><b>每周额度已用完<\/b>，[^<]+ 恢复<\/span>/);
  assert.match(sheet, /native-panel-big num" title="60k">60k<small>\/ 200k<\/small>/); assert.match(sheet, /native-panel-cap">上下文已用 30%/);
  assert.deepEqual([...sheet.matchAll(/<h3 class="native-panel-group-title">([^<]*)<\/h3>/g)].map(match => match[1]), ['额度', '会话', '权限', '账号', '本会话 token']);
  assert.equal([...sheet.matchAll(/native-panel-quota is-out/g)].length, 1, 'only the window that is used up is marked');
  assert.match(sheet, /native-panel-state"><svg data-icon="WarningCircle"><\/svg>已用完<\/span><b class="num">100%<\/b>/); assert.match(sheet, /native-panel-when">恢复于 /);
  assert.equal([...sheet.matchAll(/role="progressbar"/g)].length, 3, 'the number’s bar and the two windows');
  assert.match(sheet, /<dt title="模型">模型<\/dt><dd class="num" title="gpt-6\.1-sol">gpt-6\.1-sol<\/dd>/); assert.match(sheet, /native-panel-note">其中缓存 20/);
  assert.match(sheet, /native-panel-chip">审批：从不询问<\/span>/); assert.doesNotMatch(sheet, /native-panel-chip is-warn/, 'a read-only sandbox does not warn');
  assert.match(sheet, /<footer class="native-panel-foot"><span>\d{2}:\d{2} 读取<\/span><span class="native-panel-spacer"><\/span><span><kbd>Esc<\/kbd> 关闭<\/span><span><kbd>Ctrl<\/kbd> <kbd>C<\/kbd> 复制<\/span>/);
  assert.doesNotMatch(sheet, /<pre|reading-local-output|本地系统输出|reading-terminal/, 'it is a sheet, not the terminal popup and not a message');

  const context = ready('claude', contextLocal);
  assert.match(context, /native-panel-mark"><svg/); assert.doesNotMatch(context, /agent-brand-codex/);
  assert.match(context, /native-panel-meter is-stack" role="img"/); assert.deepEqual([...context.matchAll(/<i class="is-seg-(\d)"/g)].map(match => match[1]), ['1', '2', '3', '4', '1', '2', '3', '4'], 'a bar part and a legend swatch for each');
  assert.match(context, /<ul class="native-panel-legend"><li><i class="is-seg-1"><\/i><span title="对话消息">对话消息<\/span><b class="num">25\.8k<\/b>/);
  const warn = html({ agent: 'codex', command: 'status', state: 'ready', panel: readPanel('codex', statusLocal({ session: { ...statusLocal().session, sandbox: 'dangerFullAccess' } })) });
  assert.match(warn, /native-panel-chip is-warn"><i><\/i>沙箱：完全访问/);
  const suggest = html({ agent: 'codex', command: 'usage', state: 'ready', panel: { agent: 'codex', title: '无法识别的命令', command: '/usgae', groups: [{ kind: 'suggest', items: [{ command: '/usage', description: '查看额度' }] }], readAt: NOW } });
  assert.match(suggest, /<div class="native-panel-suggest"><button type="button"><code>\/usage<\/code><span>查看额度<\/span><\/button><\/div>/, 'the panel can offer commands to pick; no command offers them yet');

  const loading = html({ agent: 'claude', command: 'context', state: 'loading' });
  assert.match(loading, /aria-label="上下文用量"/); assert.match(loading, /role="status" aria-label="正在读取…"/); assert.equal([...loading.matchAll(/<i /g)].length, 7, 'bars where the number and three groups will be');
  assert.match(loading, /<button type="button" class="icon-button" title="重新读取"[^>]*disabled=""/); assert.match(loading, /title="复制全部"[^>]*disabled=""/);
  assert.doesNotMatch(loading, /native-panel-group-title|native-panel-rows|Ctrl/, 'asking is not a half-filled window');
  const failed = html({ agent: 'codex', command: 'status', state: 'failed', error: '会话正在切换，请稍后重试。' });
  assert.match(failed, /role="alert"><svg data-icon="WarningCircle"><\/svg><span><b>读取失败<\/b>（会话正在切换，请稍后重试。）<\/span>/); assert.match(failed, /title="复制全部"[^>]*disabled=""/);
  assert.doesNotMatch(failed, /title="重新读取"[^>]*disabled=""/, 'a failed read can be read again');
});

test('the panel’s style takes colours, radii and tokens from the app: no literal colour, the radii of the sheet, and every variable exists', () => {
  const read = file => fs.readFileSync(path.join(src, file), 'utf8'), css = read('features/native-session/native-panel.css'), themes = read('shared/styles/themes.css'), base = read('shared/styles/styles.css') + read('shared/styles/typography.css');
  assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ''), /#[0-9a-f]{3,8}\b|\brgba?\((?!0 0 0 \/ \.35\)|from var\(--text-1\) r g b)|\b(hsl|oklch|lab)\(/i, 'only the shadow’s black and ink derived from --text-1');
  const defined = new Set([...(themes + base + css).matchAll(/(--[\w-]+)\s*:/g)].map(match => match[1])), used = [...css.matchAll(/var\((--[\w-]+)/g)].map(match => match[1]);
  assert.deepEqual([...new Set(used)].filter(name => !defined.has(name)), [], 'no variable that nothing defines');
  assert.deepEqual([...new Set([...css.matchAll(/--(track|seg-\d)\s*:[^;]*;/g)].flatMap(match => match[0].match(/#[0-9a-f]{3,8}/gi) ?? []))], [], 'the track and the parts are mixed from existing tokens');
  const rule = selector => css.match(new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`, 'm'))?.[1] ?? '';
  assert.match(rule('.native-panel'), /border-radius: 16px/); assert.match(rule('.native-panel'), /width: min\(520px, calc\(100% - 32px\)\)/); assert.match(rule('.native-panel'), /max-height: calc\(100% - 132px\)/);
  for (const selector of ['.native-panel-cmd', '.native-panel-chip', '.native-toast']) assert.match(rule(selector), /border-radius: 999px/, selector);
  assert.match(rule('.native-panel-meter'), /border-radius: 999px/); assert.match(rule('.native-panel-alert'), /border-radius: 8px/); assert.match(rule('.native-panel-suggest button'), /border-radius: 8px/);
  assert.match(rule('.native-panel-rows'), /grid-template-columns: 96px 1fr/); assert.match(css, /animation: native-panel-rise \.16s ease-out/);
  assert.match(rule('.native-panel-scrim'), /color-mix\(in srgb, var\(--bg-app\) 70%, transparent\)/, 'the page colour at the strength the reading view’s own overlay uses'); assert.match(rule(':root[data-theme="light"] .native-panel-scrim'), /var\(--bg-app\) 35%/, 'and very light in the light theme');
  assert.match(rule('.native-panel-quota.is-out .native-panel-meter > i'), /var\(--danger\)/); assert.match(rule('.native-panel-meter > i'), /var\(--usage\)/);
});

// A window with the listeners, selection and size observers the panel needs; `close()` hands the globals back. A key goes to every listener of the window in
// the order they were added, as on the real one: stopPropagation keeps it from the page below but not from the window's other listeners.
// `resized(at)` tells the panel made at that place that its box changed size (to nothing, when its node says so).
function panelWindow() {
  const listeners = [], observers = [], clipboard = [], state = { selection: '' }, saved = ['window', 'navigator', 'ResizeObserver'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, writable: true, value: class { constructor(run) { this.run = run; observers.push(this); } observe() {} disconnect() { observers.splice(observers.indexOf(this), 1); } } });
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { addEventListener: (type, fn, capture) => listeners.push({ type, fn, capture }), removeEventListener: (type, fn) => listeners.splice(listeners.findIndex(row => row.fn === fn && row.type === type), 1), getSelection: () => ({ toString: () => state.selection }) } });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: { clipboard: { writeText: async text => { clipboard.push(text); } } } });
  const key = init => {
    const calls = []; let halted = false;
    for (const row of [...listeners]) if (!halted) row.fn({ target: {}, preventDefault: () => calls.push('prevent'), stopPropagation: () => calls.push('stop'), stopImmediatePropagation: () => { halted = true; }, ...init });
    return calls;
  };
  return { listeners, observers, clipboard, state, key, resized: at => observers[at].run(), close() { for (const [name, descriptor] of saved) if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; } };
}

// The panel's nodes, stood in: its dialog, inside the session view that holds it (with that view's message box), drawn or not, at its own place on the page.
function panelNodes(buttons = [], left = 0) {
  const inside = {}, box = {}, view = { contains: node => node === inside || node === box || node === dialog };
  const dialog = { drawn: true, focus() {}, contains: node => node === inside, querySelectorAll: () => buttons, closest: selector => selector === '[data-native-session]' ? view : null, getClientRects: () => dialog.drawn ? [{}] : [],
    getBoundingClientRect: () => dialog.drawn ? { left, top: 100, width: 400, height: 300 } : { left: 0, top: 0, width: 0, height: 0 } };
  return { dialog, inside, box, centre: [left + 200, 250] };
}

test('the panel closes on an Esc pressed in its own session view before the message box sees it, on a press of the backdrop and on its button; Tab stays among its buttons, Ctrl+C copies it all and refresh reads again', async () => {
  const closed = [], refreshed = [], win = panelWindow(), previousActive = document.activeElement;
  const harness = hookHarness('src/features/native-session/NativePanel.tsx', { '@phosphor-icons/react': new Proxy({}, { get: () => () => null }), './i18n': { t: fill }, './feed-parts': { AgentMark() {} },
    './native-panel.ts': load('features/native-session/native-panel.ts'), './panel-keys.ts': load('features/native-session/panel-keys.ts'), './native-panel.css': {} });
  try {
    const props = { state: { agent: 'codex', command: 'status', state: 'ready', panel: readPanel('codex', statusLocal()) }, onClose: refocus => closed.push(refocus), onRefresh: () => refreshed.push(true) };
    const tree = () => harness.render('NativePanel', props).result, root = tree();
    assert.deepEqual(win.listeners.map(row => [row.type, row.capture]), [['keydown', true]], 'captured, so the box’s own Esc (which stops a running agent) never fires');
    const nodes = [0, 1, 2].map(at => ({ at, focus() { document.activeElement = this; } })), dialog = elements(root).find(node => node.type === 'dialog'), { inside, box, dialog: node } = panelNodes(nodes);
    dialog.props.ref.current = node;
    assert.deepEqual(win.key({ key: 'a', target: box }), []); assert.equal(closed.length, 0);
    for (const [target, where] of [[{}, 'another project’s box or a terminal'], [null, 'nothing at all']]) { assert.deepEqual(win.key({ key: 'Escape', target }), [], 'an Esc aimed at ' + where + ' is not the panel’s'); assert.equal(closed.length, 0); }
    assert.deepEqual(win.key({ key: 'Escape', target: box }), ['prevent', 'stop'], 'in its own view’s message box it comes first: the agent is not stopped'); assert.equal(closed.length, 1);
    assert.deepEqual(win.key({ key: 'Escape', target: inside }), ['prevent', 'stop']); assert.equal(closed.length, 2);
    closed.length = 1;
    const press = (target, button = 0) => { const calls = []; root.props.onMouseDown({ button, target, currentTarget: root, preventDefault: () => calls.push('prevent') }); return calls; };
    assert.deepEqual(press({}), []); assert.deepEqual(press(root, 2), []); assert.equal(closed.length, 1, 'a press inside, or with another button, does not close');
    assert.deepEqual(press(root), ['prevent']); assert.equal(closed.length, 2);
    const buttons = () => elements(root).filter(node => node.type === 'button'), [refresh, copy, close] = buttons();
    close.props.onClick(); assert.deepEqual(closed, [true, true, true], 'its own Esc, a press on its backdrop and its button all send the cursor back to its box'); refresh.props.onClick(); assert.equal(refreshed.length, 1);

    // Tab and Ctrl+C count only inside the dialog, which here is a stand-in node holding three buttons.
    assert.deepEqual(win.key({ key: 'Tab', target: box }), [], 'outside the dialog Tab is the page’s');
    document.activeElement = nodes[2]; assert.deepEqual(win.key({ key: 'Tab', target: inside }), ['prevent']); assert.equal(document.activeElement, nodes[0], 'after the last button comes the first');
    win.key({ key: 'Tab', target: inside }); assert.equal(document.activeElement, nodes[1]);
    document.activeElement = nodes[0]; win.key({ key: 'Tab', shiftKey: true, target: inside }); assert.equal(document.activeElement, nodes[2], 'before the first comes the last');
    document.activeElement = {}; win.key({ key: 'Tab', target: inside }); assert.equal(document.activeElement, nodes[0], 'from the dialog itself it enters at the first');
    assert.deepEqual(win.key({ key: 'c', ctrlKey: true, target: {} }), []); await settle(); assert.deepEqual(win.clipboard, [], 'outside the dialog Ctrl+C is the page’s');
    win.state.selection = 'some text'; assert.deepEqual(win.key({ key: 'c', ctrlKey: true, target: inside }), []); await settle(); assert.deepEqual(win.clipboard, [], 'a selection is copied as it is');
    win.state.selection = ''; assert.deepEqual(win.key({ key: 'C', ctrlKey: true, target: inside }), ['prevent']); await settle();
    assert.equal(win.clipboard.length, 1); assert.equal(win.clipboard[0], load('features/native-session/native-panel.ts').panelText(props.state.panel), 'the whole panel as plain text');
    copy.props.onClick(); await settle(); assert.equal(win.clipboard.length, 2);
    const done = tree(); assert.equal(elements(done).filter(node => node.type === 'button')[1].props.title, '已复制', 'the button says it was copied');
    harness.dispose(); assert.deepEqual([win.listeners.length, win.observers.length], [0, 0], 'the listener and the observer go with the window');
  } finally { document.activeElement = previousActive; win.close(); }
});

test('a panel left open in one project never takes the Esc pressed in another, and goes when its own project is hidden', () => {
  const win = panelWindow(), closed = { a: 0, b: 0 }, refocused = [], views = {};
  const open = name => {
    const harness = hookHarness('src/features/native-session/NativePanel.tsx', { '@phosphor-icons/react': new Proxy({}, { get: () => () => null }), './i18n': { t: fill }, './feed-parts': { AgentMark() {} },
      './native-panel.ts': load('features/native-session/native-panel.ts'), './panel-keys.ts': load('features/native-session/panel-keys.ts'), './native-panel.css': {} });
    const root = harness.render('NativePanel', { state: { agent: 'claude', command: 'cost', state: 'loading' }, onClose: refocus => { closed[name]++; refocused.push(refocus); }, onRefresh() {} }).result;
    views[name] = panelNodes(); elements(root).find(node => node.type === 'dialog').props.ref.current = views[name].dialog;
    return harness;
  };
  const harnesses = [open('a'), open('b')];
  try {
    assert.deepEqual(win.key({ key: 'Escape', target: views.b.box }), ['prevent', 'stop']); assert.deepEqual(closed, { a: 0, b: 1 }, 'the Esc pressed in B closes B’s panel only, though A’s was opened first');
    assert.deepEqual(win.key({ key: 'Escape', target: {} }), []); assert.deepEqual(closed, { a: 0, b: 1 }, 'a terminal’s Esc reaches the terminal');
    win.resized(0); assert.equal(closed.a, 0, 'a resize of a panel that is drawn closes nothing');
    views.a.dialog.drawn = false; win.resized(0); assert.deepEqual(closed, { a: 1, b: 1 }, 'hiding A’s project closes the panel left open in it');
    assert.deepEqual(refocused, [true, false], 'and takes no focus for a box that is not there to see');
  } finally { for (const harness of harnesses) harness.dispose(); win.close(); }
});

// A page with several panels at once and nothing focused. What is drawn at a point is the overlay when one covers the page, else the inside of the panel
// whose centre it is. `open(name, left, onClose)` puts a real panel there; a closed one is taken off the page, as its view does.
function panelPage() {
  const shown = {}, harnesses = {}, overlay = {}, saved = ['body', 'elementFromPoint', 'activeElement'].map(name => [name, Object.hasOwn(document, name), document[name]]);
  let covered = false;
  document.body = {}; document.activeElement = document.body;
  document.elementFromPoint = (x, y) => covered ? overlay : Object.values(shown).find(nodes => nodes.dialog.drawn && nodes.centre[0] === x && nodes.centre[1] === y)?.inside ?? null;
  return { shown, cover(value) { covered = value; },
    open(name, left, onClose) {
      const harness = hookHarness('src/features/native-session/NativePanel.tsx', { '@phosphor-icons/react': new Proxy({}, { get: () => () => null }), './i18n': { t: fill }, './feed-parts': { AgentMark() {} },
        './native-panel.ts': load('features/native-session/native-panel.ts'), './panel-keys.ts': load('features/native-session/panel-keys.ts'), './native-panel.css': {} });
      const root = harness.render('NativePanel', { state: { agent: 'codex', command: 'usage', state: 'loading' }, onClose: refocus => { harness.dispose(); delete shown[name]; delete harnesses[name]; onClose(refocus); }, onRefresh() {} }).result;
      shown[name] = panelNodes([], left); elements(root).find(node => node.type === 'dialog').props.ref.current = shown[name].dialog; harnesses[name] = harness;
    },
    close() {
      for (const harness of Object.values(harnesses)) harness.dispose();
      for (const [name, had, value] of saved) if (had) document[name] = value; else delete document[name];
    } };
}

test('with nothing focused (after a press on the panel’s text) one Esc closes one panel, the newest that nothing lies over, and a panel that does not take it leaves the key alone', () => {
  const win = panelWindow(), page = panelPage(), closed = { a: 0, b: 0 }, refocused = [];
  const open = (name, left) => page.open(name, left, refocus => { closed[name]++; refocused.push(refocus); }), press = target => win.key({ key: 'Escape', target });
  try {
    open('a', 0);
    assert.deepEqual(press(document.body), ['prevent', 'stop']); assert.deepEqual(closed, { a: 1, b: 0 }, 'the plain case: one panel, nothing over it');
    open('a', 0); open('b', 600);
    page.cover(true);
    assert.deepEqual(press(document.body), []); assert.deepEqual(closed, { a: 1, b: 0 }, 'under a guide, a dialog or a menu no panel takes the key, and none prevents or stops it');
    page.cover(false);
    assert.deepEqual(press(document.documentElement), ['prevent', 'stop']); assert.deepEqual(closed, { a: 1, b: 1 }, 'two panels in view: one press closes one, the newest');
    assert.deepEqual(press(document), ['prevent', 'stop']); assert.deepEqual(closed, { a: 2, b: 1 }, 'the next press closes the other');
    assert.deepEqual(press(document.body), []); assert.deepEqual(closed, { a: 2, b: 1 }, 'with no panel left the key is the page’s');
    open('a', 0); open('b', 600);
    page.shown.b.dialog.drawn = false;
    assert.deepEqual(press(document.body), ['prevent', 'stop']); assert.deepEqual(closed, { a: 3, b: 1 }, 'a panel that is not drawn is passed over, though it is the newer');
    page.shown.b.dialog.drawn = true;
    assert.deepEqual(win.key({ key: 'a', target: document.body }), []); assert.deepEqual(press({}), [], 'a key pressed in something else is still never a panel’s');
    assert.deepEqual([closed, refocused], [{ a: 3, b: 1 }, [false, false, false, false]], 'and a panel closed with nothing focused moves the focus nowhere');
  } finally { page.close(); win.close(); }
});

test('two panels in the grid with nothing focused: Esc, Esc closes both in order, interrupts no agent and leaves the focus on the page', async () => {
  const interrupts = [], bridge = { send: () => new Promise(() => {}), interrupt: async (...args) => { interrupts.push(args); return { ok: true, value: {} }; } };
  const working = ev => [ev('session.state', { state: 'running', reason: null })];
  const views = { a: sessionView(working, bridge, { provider: 'codex' }), b: sessionView(working, bridge, { provider: 'claude' }) }, boxes = {};
  const win = panelWindow(), page = panelPage(), order = [];
  window.agentrix = { nativeSession: bridge };
  // A key goes to the window first and, unless a panel stopped it there, to the message box that holds the focus.
  const escape = () => {
    const target = document.activeElement, calls = win.key({ key: 'Escape', target }), name = Object.keys(boxes).find(key => boxes[key] === target);
    if (name && !calls.includes('stop')) keyIn(views[name], 'Escape');
  };
  try {
    for (const [name, left] of [['a', 0], ['b', 600]]) {
      const view = views[name];
      boxes[name] = voiceBox(view, '/usage'); view.press(); view.tree();
      page.open(name, left, refocus => { order.push(name); view.panel().onClose(refocus); view.tree(); });
    }
    document.activeElement = document.body;
    escape(); assert.deepEqual([order, document.activeElement === document.body, views.a.panel() !== undefined, views.b.panel()], [['b'], true, true, undefined], 'the first Esc closes the newer panel and the focus stays on the page');
    escape(); await settle();
    assert.deepEqual([order, document.activeElement === document.body, views.a.panel(), interrupts], [['b', 'a'], true, undefined, []], 'the second closes the other: no agent was stopped');
    document.activeElement = boxes.b; escape(); await settle();
    assert.equal(interrupts.length, 1, 'an Esc the owner presses in a message box still stops that agent');
  } finally { page.close(); win.close(); views.b.done(); views.a.done(); }
});

test('the panel keeps refresh and copy shut while it asks and copy shut when it failed', () => {
  const win = panelWindow(), harness = hookHarness('src/features/native-session/NativePanel.tsx', { '@phosphor-icons/react': new Proxy({}, { get: () => () => null }), './i18n': { t: fill }, './feed-parts': { AgentMark() {} },
    './native-panel.ts': load('features/native-session/native-panel.ts'), './panel-keys.ts': load('features/native-session/panel-keys.ts'), './native-panel.css': {} });
  try {
    const disabled = state => elements(harness.render('NativePanel', { state, onClose() {}, onRefresh() {} }).result).filter(node => node.type === 'button').map(node => !!node.props.disabled);
    assert.deepEqual(disabled({ agent: 'claude', command: 'cost', state: 'loading' }), [true, true, false]);
    assert.deepEqual(disabled({ agent: 'claude', command: 'cost', state: 'failed', error: 'x' }), [false, true, false]);
    assert.deepEqual(disabled({ agent: 'claude', command: 'context', state: 'ready', panel: readPanel('claude', contextLocal) }), [false, false, false]);
  } finally { harness.dispose(); win.close(); }
});

test('the window opens for Codex /status and /usage and for Claude /context, /cost, /status and /usage; arguments and other words stay messages', () => {
  const { composerAction } = load('features/native-session/native-composer.ts');
  for (const agent of ['codex', 'claude']) for (const command of ['status', 'usage']) assert.deepEqual(composerAction(`/${command}`, agent), { kind: 'panel', command });
  for (const command of ['context', 'cost']) assert.deepEqual([composerAction(`/${command}`, 'claude'), composerAction(`/${command}`, 'codex')], [{ kind: 'panel', command }, null], `${command} is Claude’s`);
  for (const agent of ['codex', 'claude']) for (const words of ['/status now', '/usage?', '/statuses', 'explain /status', '/prompts:mine', '/context now', '/cost x']) assert.equal(composerAction(words, agent), null, `${agent}: ${words}`);
});

test('a child user-side message shows its factual planner or owner avatar, with a neutral unknown planner', () => {
  const { ConversationFeed } = load('features/reading/ConversationFeed.tsx');
  const render = sender => renderToStaticMarkup(React.createElement(ConversationFeed, {
    entries: [{ id: 'u:brief', at: 1000, role: 'user', text: 'Same words', sender }], agent: 'codex', projectId: 'p', live: false, onError() {},
  }));
  const planner = render({ kind: 'planner', agent: 'claude', model: 'claude-opus-5-5' });
  assert.match(planner, /Opus 5\.5/); assert.doesNotMatch(planner, /class="avatar"|>你</);
  const unknown = render({ kind: 'planner', agent: null, model: null });
  assert.match(unknown, /主模型/); assert.doesNotMatch(unknown, /class="avatar"|>你</);
  const unreported = render({ kind: 'planner', agent: 'claude', model: null });
  assert.match(unreported, /主模型/); assert.doesNotMatch(unreported, /agent-brand-claude|class="avatar"/);
  const codex = render({ kind: 'planner', agent: 'codex', model: 'gpt-6.1-sol' });
  assert.match(codex, /GPT-6\.1-Sol/); assert.match(codex, /agent-brand-codex/); assert.doesNotMatch(codex, /class="avatar"|>你</);
  assert.match(render({ kind: 'owner' }), /class="avatar"/); assert.match(render(undefined), />你</);
});

// One runtime's event stream: sequence numbers count up; `extra` overrides any field of an event.
function stream(base = {}) {
  let n = 0;
  return (type, payload = {}, extra = {}) => ({ schemaVersion: 1, eventId: `e${++n}`, sequence: n, connectionEpoch: 'ep1', provider: 'claude', transport: 'claude-sdk', projectId: 'p1', terminalId: 't1',
    runtimeSessionId: 'rs1', providerSessionId: null, runId: null, turnId: 'turn1', itemId: null, receivedAtMs: 1000 + n, occurredAtMs: 1000 + n, replay: false, ...base, type, payload, ...extra });
}

// ---- the model ----------------------------------------------------------------------------------------------------------------------
test('events fold into one conversation: deltas stream, a completed snapshot replaces them, repeats change nothing, and what no event says stays null', () => {
  const { applyEvents, emptyModel } = load('features/native-session/native-model.ts'), ev = stream();
  const events = [
    ev('session.state', { state: 'running', reason: null }),
    ev('item.upsert', { kind: 'user-message', status: 'completed', content: { text: 'hi', clientMessageId: 'c1' } }, { itemId: 'u1' }),
    ev('item.delta', { channel: 'text', text: 'Hel' }, { itemId: 'a1' }),
    ev('item.delta', { channel: 'text', text: 'lo' }, { itemId: 'a1' }),
  ];
  const streamed = applyEvents(emptyModel(), events).model;
  assert.deepEqual([streamed.order, streamed.items.a1.kind, streamed.items.a1.deltas.text], [['u1', 'a1'], 'agent-message', 'Hello']);
  const done = applyEvents(streamed, [ev('item.upsert', { kind: 'agent-message', status: 'completed', content: { text: 'Hello there' } }, { itemId: 'a1' })]).model;
  assert.deepEqual([done.items.a1.deltas.text, done.items.a1.content.text, done.order], ['', 'Hello there', ['u1', 'a1']], 'the completed snapshot replaces the streamed pieces');
  assert.deepEqual(applyEvents(done, events).model, done, 'events heard again change nothing');
  const bare = applyEvents(emptyModel(), [ev('session.state', { state: 'idle' })]).model;
  assert.deepEqual([bare.path, bare.diff, bare.plan, bare.error, bare.session.reason], [null, null, null, null, null], 'nothing is invented');
});

test('a gap stops the fold and asks for a snapshot; another session or connection epoch is dropped and asked about once', () => {
  const { applyEvents, emptyModel } = load('features/native-session/native-model.ts'), ev = stream();
  const model = applyEvents(emptyModel(), [ev('session.state', { state: 'idle' })]).model;
  const gap = applyEvents(model, [ev('turn.started'), ev('session.state', { state: 'waiting' }, { sequence: 9 }), ev('session.state', { state: 'running' }, { sequence: 10 })]);
  assert.deepEqual([gap.resync, gap.model.lastSequence, gap.model.session.state], [true, 2, 'idle'], 'the events after the gap wait for the snapshot');
  for (const base of [{ connectionEpoch: 'ep2' }, { runtimeSessionId: 'rs2' }]) {
    const other = stream(base), delta = () => other('item.delta', { channel: 'text', text: 'x' }, { itemId: 'z' });
    const first = applyEvents(model, [delta()]), again = applyEvents(first.model, [delta()]);
    assert.deepEqual([first.resync, again.resync, first.model.items], [true, false, model.items], JSON.stringify(base));
  }
  const strict = applyEvents(emptyModel(), [ev('session.state', { state: 'idle' }, { sequence: 40 }), ev('session.state', { state: 'running' }, { sequence: 44 })], false);
  assert.deepEqual([strict.resync, strict.model.session.state], [false, 'running'], 'a snapshot’s own events may be compacted');
});

test('requests wait for the owner until they are resolved, an ended session has none, and receipts follow the runtime', () => {
  const { applyEvents, emptyModel, canSend, isOver } = load('features/native-session/native-model.ts'), ev = stream();
  const model = applyEvents(emptyModel(), [
    ev('session.state', { state: 'waiting', reason: null }),
    ev('request.opened', { requestId: 'r1', kind: 'command', blocking: true, title: 'Run npm test', preview: 'npm test', actions: [], providerData: {} }),
    ev('request.opened', { requestId: 'r1', kind: 'command', title: 'again' }),
    ev('request.opened', { requestId: 'r2', kind: 'question', title: 'Which?', questions: [{ id: 'q1', question: 'Which?', options: [{ label: 'A' }] }] }),
    ev('input.receipt', { clientMessageId: 'c9', status: 'queued' }),
    ev('input.receipt', { clientMessageId: 'c9', status: 'consumed' }),
  ]).model;
  assert.deepEqual(model.requests.map(request => [request.id, request.kind, request.title, request.questions.length]), [['r1', 'command', 'Run npm test', 0], ['r2', 'question', 'Which?', 1]]);
  assert.equal(model.receipts.c9, 'consumed');
  const resolved = applyEvents(model, [ev('request.resolved', { requestId: 'r1', resolution: 'allowed', reason: null })]).model;
  assert.deepEqual(resolved.requests.map(request => request.id), ['r2']);
  const over = applyEvents(resolved, [ev('session.state', { state: 'stopped', reason: 'user' })]).model;
  assert.deepEqual([over.requests, canSend(model), canSend(over), isOver(over)], [[], true, false, true]);
});

test('a reasoning summary is no part of the model, a diff and a plan are replaced by the next and cleared by a new turn, and a turn ends with its own status', () => {
  const { applyEvents, emptyModel } = load('features/native-session/native-model.ts'), ev = stream();
  const model = applyEvents(emptyModel(), [
    ev('turn.started', { origin: 'user', clientMessageId: 'c1' }),
    ev('item.delta', { channel: 'reasoning-summary', text: 'first ', index: 0 }, { itemId: 'th' }),
    ev('turn.diff', { diff: '+one' }), ev('turn.diff', { diff: '+one\n+two' }),
    ev('plan.updated', { explanation: 'x', steps: [{ step: 'A', status: 'pending' }] }), ev('plan.updated', { explanation: null, steps: [{ step: 'A', status: 'completed' }, { step: 'B', status: null }] }),
    ev('path.changed', { previous: 'api', selected: 'terminal', reason: 'budget_exhausted' }),
    ev('error', { code: 'rate', message: 'Too many requests', retryable: true, willRetry: true, stage: 'turn' }),
  ]).model;
  assert.deepEqual([model.items.th, model.order], [undefined, []], 'a thinking summary is kept nowhere: the conversation does not show it');
  assert.equal(model.diff, '+one\n+two');
  assert.deepEqual(model.plan, { explanation: null, steps: [{ text: 'A', status: 'completed' }, { text: 'B', status: null }] });
  assert.deepEqual([model.path.selected, model.path.reason, model.error.willRetry, model.turn.running], ['terminal', 'budget_exhausted', true, true]);
  const ended = applyEvents(model, [ev('turn.completed', { status: 'interrupted', error: null })]).model;
  assert.deepEqual([ended.turn, ended.error], [{ running: false, status: 'interrupted', error: null, end: { reason: null, message: null, durationMs: null, costUsdMicros: null, costEstimated: null, tokens: null } }, model.error]);
  assert.deepEqual([ended.diff === model.diff, ended.plan === model.plan], [true, true], 'the end of a turn keeps its diff and plan to read');
  const next = applyEvents(ended, [ev('turn.started', {})]).model;
  assert.deepEqual([next.error, next.diff, next.plan], [null, null, null], 'a new turn clears the last error, diff and plan');
});

test('a stream a newer message replaced is discarded whole: the half answer already heard goes, a late piece is dropped, and no entry is drawn for it', () => {
  const { applyEvents, emptyModel } = load('features/native-session/native-model.ts'), { nativeEntries } = load('features/native-session/native-entries.ts'), ev = stream();
  const heard = applyEvents(emptyModel(), [ev('item.delta', { channel: 'text', text: 'half an ans', index: 0 }, { itemId: 'old:0' }), ev('item.delta', { channel: 'text', text: 'The whole', index: 0 }, { itemId: 'new:0' })]).model;
  assert.deepEqual(nativeEntries(heard).map(entry => entry.text), ['half an ans', 'The whole']);
  const dropped = applyEvents(heard, [ev('item.upsert', { kind: 'agent-message', status: 'interrupted', content: { text: '', discarded: true } }, { itemId: 'old:0' }), ev('item.delta', { channel: 'text', text: 'late', index: 0 }, { itemId: 'old:0' })]).model;
  assert.deepEqual(nativeEntries(dropped).map(entry => entry.text), ['The whole'], 'the discarded item is hidden and its late piece does not bring it back');
  assert.equal(dropped.items['old:0'].deltas.text, '');
});

// ---- the words ----------------------------------------------------------------------------------------------------------------------
test('words: receipts, routes, money and quota windows say what is known and "未知" for what is not', () => {
  const words = load('features/native-session/native-words.ts'), item = (kind, content = {}, extra = {}) => ({ id: 'i', kind, status: null, content, turnId: null, at: null, deltas: { text: '', output: '', plan: '' }, ...extra });
  assert.deepEqual(['queued', 'delivered', 'consumed', 'rejected', 'unknown', 'mystery', null].map(words.receiptWord), ['已排队', '已送达', '已被读取', '未送达', '送达状态未知', null, null]);
  assert.deepEqual([null, undefined, 0, 5, 1_234_567].map(words.money), ['未知', '未知', '$0.00', '<$0.01', '$1.23'], 'unknown is not zero, and zero is not unknown');
  assert.deepEqual(['budget_exhausted', 'native_cli_required', 'no_key', 'something_new', 'a.b-c', null, '输入框里有未发送的文字', 'process exited'].map(words.reasonWords),
    ['本月 API 预算已用完', '未找到原生 Claude Code，无法通过 API 运行', '还没有保存 API key', null, null, null, '输入框里有未发送的文字', 'process exited'],
    'a code we know is said in words, a code nobody mapped is not shown, and a sentence main wrote for the owner is shown as it is');
  assert.deepEqual(words.windowWords({ usedPercent: 40, windowDurationMins: 300, resetsAtMs: null }), { span: '5 小时', used: '40%', resets: '未知' });
  assert.deepEqual([words.windowWords(null), words.windowWords({ usedPercent: null, windowDurationMins: 10080, resetsAtMs: null }).used], [null, '未知']);
  assert.deepEqual(['in_progress', 'completed', 'failed', 'declined', null].map(status => words.itemState(item('command', {}, { status }))), ['running', 'done', 'failed', null, null]);
  assert.deepEqual([words.messageText(item('agent-message', { text: 'final' }, { deltas: { text: 'streamed', output: '', plan: '' } })), words.messageText(item('agent-message', { text: 'final' }))], ['streamed', 'final']);
  assert.deepEqual(words.commandOf(item('command', { command: ['npm', 'test'], exitCode: 1, durationMs: 1500, output: 'old' }, { deltas: { text: '', output: 'live', plan: '' } })),
    { command: 'npm test', phrase: null, cwd: null, exitCode: 1, durationMs: 1500, output: 'live' });
  assert.deepEqual(words.fileChanges(item('file-change', { path: 'a.ts', diff: '+x' })), [{ path: 'a.ts', kind: null, diff: '+x' }]);
});

// ---- the store ----------------------------------------------------------------------------------------------------------------------
async function withBridge(bridge, run) {
  const store = load('features/native-session/native-store.ts'), saved = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { agentrix: { nativeSession: bridge } } });
  try { await run(store); } finally { store.disposeNativeStore(); if (saved) Object.defineProperty(globalThis, 'window', saved); else delete globalThis.window; }
}
// The hooks read the store without a browser: a server render takes the current snapshot.
const read = (use) => { let found; renderToStaticMarkup(React.createElement(() => { found = use(); return null; })); return found; };
const entriesOf = store => read(store.useNativeEntries);

test('the window subscribes first and asks for a snapshot after; events that arrive meanwhile are folded on top of it and a repeat drops', async () => {
  const ev = stream(), history = [ev('session.state', { state: 'idle' }), ev('item.upsert', { kind: 'user-message', status: 'completed', content: { text: 'hi', clientMessageId: 'c1' } }, { itemId: 'u1', replay: true })];
  const live = ev('item.delta', { channel: 'text', text: 'Hello' }, { itemId: 'a1' }), asked = [];
  let emit = null, release; const gate = new Promise(resolve => { release = resolve; });
  const bridge = { onEvent: listener => { emit = listener; return () => { emit = null; }; }, snapshot: async id => { asked.push(id); await gate; return { ok: true, value: { runtimeSessionId: 'rs1', lastSequence: 2, events: history } }; } };
  await withBridge(bridge, async store => {
    store.ensureNativeSession('t1');
    assert.ok(emit, 'events are subscribed before the snapshot is asked for'); assert.deepEqual(asked, ['t1']);
    emit(live); emit(history[1]);
    release(); await settle();
    const entry = entriesOf(store).get('t1');
    assert.deepEqual([entry.model.order, entry.model.items.a1.deltas.text, entry.model.lastSequence, asked], [['u1', 'a1'], 'Hello', 3, ['t1']]);
    assert.equal(store.nativeShown(entry), true);
  });
});

test('a gap in the sequence asks for one new snapshot, which covers the missing events', async () => {
  const ev = stream(), first = [ev('session.state', { state: 'idle' })], lost = ev('item.upsert', { kind: 'user-message', status: 'completed', content: { text: 'hi' } }, { itemId: 'u1' });
  const next = ev('item.delta', { channel: 'text', text: 'ok' }, { itemId: 'a1' });
  let emit = null, calls = 0;
  const bridge = { onEvent: listener => { emit = listener; return () => {}; }, snapshot: async () => ({ ok: true, value: ++calls === 1 ? { runtimeSessionId: 'rs1', lastSequence: 1, events: first } : { runtimeSessionId: 'rs1', lastSequence: 3, events: [...first, lost, next] } }) };
  await withBridge(bridge, async store => {
    store.ensureNativeSession('t1'); await settle();
    emit(next); await settle();
    assert.equal(calls, 1, 'the snapshot is asked for after a short pause, not at once');
    await sleep(400);
    assert.equal(calls, 2);
    assert.deepEqual([entriesOf(store).get('t1').model.order, entriesOf(store).get('t1').model.lastSequence], [['u1', 'a1'], 3]);
  });
});

test('a finished session’s view can be closed until another starts, and a session moved to the terminal gives way to it with its reason', async () => {
  const ev = stream(), second = stream({ runtimeSessionId: 'rs2' }), moved = stream({ terminalId: 't2' });
  const ended = [ev('session.state', { state: 'stopped', reason: 'user' })], next = [second('session.state', { state: 'idle' })];
  const switched = [moved('session.state', { state: 'running' }), moved('path.changed', { previous: 'api', selected: 'terminal', reason: 'rate_limited' })];
  let emit = null, answer = { t1: ended, t2: switched };
  const bridge = { onEvent: listener => { emit = listener; return () => {}; }, snapshot: async id => ({ ok: true, value: { runtimeSessionId: answer[id][0].runtimeSessionId, lastSequence: answer[id].at(-1).sequence, events: answer[id] } }) };
  await withBridge(bridge, async store => {
    store.ensureNativeSession('t1'); store.ensureNativeSession('t2'); await settle();
    assert.equal(store.nativeShown(entriesOf(store).get('t1')), true);
    store.dismissNative('t1');
    assert.equal(store.nativeShown(entriesOf(store).get('t1')), false, 'the owner closed the finished view');
    answer = { t1: next }; emit(next[0]); await sleep(400);
    assert.equal(store.nativeShown(entriesOf(store).get('t1')), true, 'a session that starts there shows again');
    const away = entriesOf(store).get('t2');
    assert.deepEqual([store.nativeShown(away), store.terminalSwitch(away).reason], [false, 'rate_limited'], 'the terminal’s reading view takes the cell and the reason stays');
    store.dismissNote('t2');
    assert.equal(store.terminalSwitch(entriesOf(store).get('t2')), null);
    store.noteTerminalSwitch('t3', 'no_key');
    const own = entriesOf(store).get('t3');
    assert.deepEqual([store.nativeShown(own), store.terminalSwitch(own).reason], [false, 'no_key']);
  });
});

test('a replayed event never counts as news for the usage panel; a live one does, and a plain message does not', async () => {
  const ev = stream(), bridge = { onEvent: listener => { bridge.emit = listener; return () => {}; }, snapshot: async () => ({ ok: true, value: null }) };
  await withBridge(bridge, async store => {
    store.ensureNativeSession('t1'); await settle();
    const revision = () => read(store.useUsageRevision);
    bridge.emit(ev('usage.updated', { input: 1 }, { replay: true })); bridge.emit(ev('limits.updated', {}, { replay: true }));
    assert.equal(revision(), 0);
    bridge.emit(ev('usage.updated', { input: 2 })); assert.equal(revision(), 1);
    bridge.emit(ev('item.delta', { channel: 'text', text: 'x' }, { itemId: 'a' })); assert.equal(revision(), 1);
    bridge.emit(ev('turn.completed', { status: 'completed', error: null })); assert.equal(revision(), 2);
  });
});

// ---- how a session starts -----------------------------------------------------------------------------------------------------------
test('the launch route follows the settings: native by default, the terminal when chosen, the reason when a missing key is why, and nothing for API-only without a key', () => {
  const { launchRoute } = load('features/native-session/native-bridge.ts'), set = claudePath => ({ claudePath, monthlyBudgetUsd: null });
  const native = { how: 'native' }, terminal = (reason = null) => ({ how: 'terminal', reason });
  assert.deepEqual([launchRoute('claude', null, null), launchRoute('codex', null, true)], [terminal(), native], 'settings not read: Claude waits on the terminal, Codex has only app-server');
  assert.deepEqual([launchRoute('claude', set('api-then-terminal'), true), launchRoute('claude', set('api-then-terminal'), null), launchRoute('claude', set('api-only'), true)], [native, native, native]);
  assert.deepEqual([launchRoute('claude', set('terminal-only'), true), launchRoute('claude', set('terminal-only'), false)], [terminal(), terminal()]);
  assert.deepEqual([launchRoute('claude', set('api-then-terminal'), false), launchRoute('claude', set('api-only'), false)], [terminal('no_key'), { how: 'blocked', reason: 'no_key' }]);
  assert.deepEqual([launchRoute('codex', set('terminal-only'), false), launchRoute('codex', set('api-only'), true)], [native, native], 'Codex is always on app-server and needs no key');
});

// A stand-in for the main process on `window.agentrix`, for the launcher.
// `kind`: the project's kind; `codexHere`: whether this computer has Codex installed; `startError`: what a start is refused with. `errors`: what the card shows of a refusal.
function launcher(runtime, calls, { kind = 'local', codexHere = true, startError = null, history = { claude: null, codex: null } } = {}) {
  const bridge = {
    getSettings: async () => ({ ok: true, value: runtime.settings }), keyStatus: async () => ({ ok: true, value: { saved: runtime.saved } }),
    start: async (...args) => { calls.push(['start', ...args]); return startError ? { ok: false, error: startError } : { ok: true, value: { runtimeSessionId: 'rs1' } }; },
  };
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { agentrix: {
    getAgents: async () => ({ ok: true, value: { npm: true, installing: null, error: null, codex: { installed: codexHere }, claude: { installed: true } } }), onAgents: () => () => {},
    startTerminal: async id => { calls.push(['terminal', id]); return { ok: true, value: null }; },
    installAgent: async agent => { calls.push(['install', agent]); return { ok: true, value: null }; }, openNode: async () => { calls.push(['node']); return { ok: true, value: null }; },
    agentHistory: async () => ({ ok: true, value: history }),
    getState: async () => ({ ok: true, value: { projects: [{ id: 'p', terminals: [{ id: 't1', sessionId: null, status: 'stopped' }] }] } }),
    agentLaunch: async (...args) => { calls.push(['launch', ...args]); return { ok: true, value: true }; }, nativeSession: bridge,
  } } });
  const bridgeModule = require('../src/features/native-session/native-bridge.ts');
  const harness = hookHarness('src/features/terminal/AgentLauncher.tsx', {
    '@phosphor-icons/react': { CircleNotch() {}, Terminal() {} }, './AgentBrandIcon.ts': { ClaudeLogo() {}, CodexLogo() {} }, './time': { relativeTime: () => '' }, './i18n': { t: fill }, './agent-launcher.css': {},
    './native-store.ts': { noteTerminalSwitch: (...args) => calls.push(['note', ...args]), refreshNativeSession: id => calls.push(['refresh', id]) }, './native-bridge.ts': bridgeModule,
  });
  const errors = [], props = { terminalId: 't1', projectId: 'p', kind, onAction: async promise => { const result = await promise; if (!result.ok) errors.push(result.error); return result.ok ? result.value : undefined; }, onOpenTerminal: id => calls.push(['open', id]) };
  const render = () => harness.render('AgentLauncher', props).result;
  const button = agent => elements(render()).find(node => node.type === 'button' && node.props.className?.startsWith(`agent-launcher-agent is-${agent}`));
  const note = agent => elements(button(agent)).find(node => node.type === 'small').props.children;
  return { render, button, note, errors, text: () => renderToStaticMarkup(render()), done() { harness.dispose(); if (previous) Object.defineProperty(globalThis, 'window', previous); else delete globalThis.window; } };
}

test('the launcher starts a native session or a terminal by the settings, says where the click goes, and a missing key never starts a hidden terminal', async () => {
  const set = claudePath => ({ claudePath, monthlyBudgetUsd: null });
  const cases = [
    ['claude', { settings: set('api-then-terminal'), saved: true }, [['start', 't1', { agent: 'claude', resume: false }], ['refresh', 't1']], '开始新的对话 · API · 原生模式'],
    ['claude', { settings: set('terminal-only'), saved: true }, [['launch', 't1', 'claude', 'new']], '开始新的对话'],
    ['claude', { settings: set('api-then-terminal'), saved: false }, [['launch', 't1', 'claude', 'new'], ['note', 't1', 'no_key']], '开始新的对话 · 没有 API key，改用终端'],
    ['claude', { settings: set('api-only'), saved: false }, [], '开始新的对话 · 需先保存 API key'],
    ['codex', { settings: set('api-then-terminal'), saved: false }, [['start', 't1', { agent: 'codex', resume: false }], ['refresh', 't1']], '开始新的对话 · 原生模式'],
  ];
  for (const [agent, runtime, expected, note] of cases) {
    const calls = [], view = launcher(runtime, calls);
    try {
      view.render(); await settle();
      assert.equal(view.note(agent), note, `${agent} ${JSON.stringify(runtime)}`);
      view.button(agent).props.onClick(); await settle();
      assert.deepEqual(calls, expected, `${agent} ${JSON.stringify(runtime)}`);
      if (!expected.length) assert.match(view.text(), /只用 API 运行，但还没有保存 API key/, 'and it says why nothing started');
    } finally { view.done(); }
  }
});

test('the launcher of an SSH project offers Codex and a plain terminal only; Codex starts at once whether or not this computer has it: no 未安装, no install, no Node.js; a local project is unchanged', async () => {
  const runtime = { settings: { claudePath: 'api-then-terminal', monthlyBudgetUsd: null }, saved: true };
  const calls = [], remote = launcher(runtime, calls, { kind: 'ssh', codexHere: false });
  const agents = view => elements(view.render()).filter(node => node.type === 'button' && node.props.className?.startsWith('agent-launcher-agent')).map(node => node.props.className.split(' ')[1]);
  try {
    remote.render(); await settle();
    assert.deepEqual(agents(remote), ['is-codex'], 'Claude on another computer is the owner’s own, in its terminal');
    assert.equal(remote.note('codex'), '开始新的对话 · 原生模式', 'no "not installed" for a computer that is not the one it runs on');
    remote.button('codex').props.onClick(); await settle();
    assert.deepEqual(calls, [['start', 't1', { agent: 'codex', resume: false }], ['refresh', 't1']], 'the session starts through the bridge, with no install and no Node.js');
    calls.length = 0;
    elements(remote.render()).find(node => node.type === 'button' && node.props.children?.includes?.('只打开终端')).props.onClick(); await settle();
    assert.deepEqual(calls, [['terminal', 't1'], ['open', 't1']], 'the plain terminal starts and the card opens it');
  } finally { remote.done(); }
  const refused = [], failing = launcher(runtime, refused, { kind: 'ssh', codexHere: false, startError: '远端未找到 Codex 程序。' });
  try {
    failing.render(); await settle(); failing.button('codex').props.onClick(); await settle();
    assert.deepEqual([refused, failing.errors], [[['start', 't1', { agent: 'codex', resume: false }], ['refresh', 't1']], []], 'the session that failed is asked for, nothing is installed, and no message goes to the corner of the window');
    assert.match(failing.text(), /<p class="agent-launcher-error" role="alert">远端未找到 Codex 程序。<\/p>/, 'what main says about the other computer is said once, in the card, where no session has taken its place');
  } finally { failing.done(); }
  const local = launcher(runtime, [], { kind: 'local', codexHere: false });
  try { local.render(); await settle(); assert.deepEqual(agents(local), ['is-claude', 'is-codex']); assert.match(local.note('codex'), /未安装/, 'a local project still offers the install'); assert.equal(local.note('claude'), '开始新的对话 · API · 原生模式'); } finally { local.done(); }
});

test('the history of an SSH project can always be chosen: it is asked after the click, which resumes and says main’s reason if there is none', async () => {
  const runtime = { settings: { claudePath: 'api-then-terminal', monthlyBudgetUsd: null }, saved: true };
  const radio = view => elements(view.render()).find(node => node.props?.role === 'radio' && node.props.children === '继承开发历史');
  const calls = [], remote = launcher(runtime, calls, { kind: 'ssh', codexHere: false });
  try {
    remote.render(); await settle();
    assert.deepEqual([radio(remote).props.disabled, radio(remote).props.title], [false, undefined], 'no record is known here, and nothing says there is none');
    radio(remote).props.onClick(); assert.equal(remote.note('codex'), '接着上次的对话 · 原生模式', 'it does not say it starts again: the click asks');
    remote.button('codex').props.onClick(); await settle();
    assert.deepEqual(calls, [['start', 't1', { agent: 'codex', resume: true }], ['refresh', 't1']]);
  } finally { remote.done(); }
  // A history known by its id only has no time to say: neither the time nor the dot before it is written.
  const noted = async history => {
    const view = launcher(runtime, [], { kind: 'ssh', codexHere: false, history });
    try { view.render(); await settle(); radio(view).props.onClick(); return view.note('codex'); } finally { view.done(); }
  };
  assert.equal(await noted({ claude: null, codex: { id: 'thread-1' } }), '接着上次的对话 · 原生模式', 'no time, no dangling dot');
  assert.match(await noted({ claude: null, codex: { id: 'thread-1', at: Date.now() } }), /^接着上次的对话 · .* · 原生模式$/, 'with a time it is the same sentence as a local one');
  const failing = launcher(runtime, [], { kind: 'ssh', codexHere: false, startError: '远端没有可继承的对话。' });
  try {
    failing.render(); await settle(); radio(failing).props.onClick(); failing.button('codex').props.onClick(); await settle();
    assert.match(failing.text(), /<p class="agent-launcher-error" role="alert">远端没有可继承的对话。<\/p>/, 'a remote with none says so, in main’s words');
  } finally { failing.done(); }
  const local = launcher(runtime, [], { kind: 'local' });
  try { local.render(); await settle(); assert.deepEqual([radio(local).props.disabled, radio(local).props.title], [true, '这个文件夹还没有开发记录'], 'a local folder with no record still cannot continue'); } finally { local.done(); }
});

test('the launcher offers no terminal mode for Codex, and Codex starts natively whatever the settings say', async () => {
  const calls = [], view = launcher({ settings: { claudePath: 'api-then-terminal', monthlyBudgetUsd: null }, saved: true }, calls);
  try {
    view.render(); await settle();
    assert.deepEqual(elements(view.render()).filter(node => node.props.role === 'radio').map(node => node.props.children), ['开始新开发', '继承开发历史']);
    view.button('codex').props.onClick(); await settle();
    assert.deepEqual(calls, [['start', 't1', { agent: 'codex', resume: false }], ['refresh', 't1']]);
  } finally { view.done(); }
});

// ---- the view -----------------------------------------------------------------------------------------------------------------------
const richSession = ev => [
  ev('session.state', { state: 'running', reason: null }),
  ev('turn.started', { origin: 'user', clientMessageId: 'c1' }),
  ev('item.upsert', { kind: 'user-message', status: 'completed', content: { text: 'fix the test', clientMessageId: 'c1' } }, { itemId: 'u1' }),
  ev('input.receipt', { clientMessageId: 'c1', status: 'consumed' }),
  ev('item.upsert', { kind: 'reasoning-summary', status: 'completed', content: { text: 'Looking at the failing assertion' } }, { itemId: 'th1' }),
  ev('item.upsert', { kind: 'reasoning-summary', status: 'completed', content: {} }, { itemId: 'th2' }),
  ev('item.upsert', { kind: 'command', status: 'in_progress', content: { command: 'npm test', cwd: '/work' } }, { itemId: 'k1' }),
  ev('item.delta', { channel: 'output', text: 'FAIL a.test.js' }, { itemId: 'k1' }),
  ev('item.upsert', { kind: 'file-change', status: 'completed', content: { changes: [{ path: 'src/a.ts', kind: 'update', diff: '-old\n+new' }] } }, { itemId: 'f1' }),
  ev('item.delta', { channel: 'text', text: 'Done: ' }, { itemId: 'm1' }), ev('item.delta', { channel: 'text', text: 'it passes now.' }, { itemId: 'm1' }),
  ev('plan.updated', { explanation: null, steps: [{ step: 'Run tests', status: 'completed' }, { step: 'Fix', status: 'pending' }] }),
  ev('turn.diff', { diff: '+added line\n-removed line' }),
  ev('request.opened', { requestId: 'r1', kind: 'command', blocking: true, title: 'Run rm -rf build', preview: 'rm -rf build', actions: [], providerData: {} }),
];

// The draft handoff hook is tested on its own below; the views get this stand-in of it.
const handoffStub = () => ({ locked: false, incoming: null, offers: [], taken: 0, offer(draft) { this.offers.push(draft); }, take() { const draft = this.incoming; this.incoming = null; this.taken++; return draft; } });

async function viewHtml(build, base = {}) {
  const ev = stream(base), events = build(ev);
  let html = '';
  await withBridge({ onEvent: () => () => {}, snapshot: async () => ({ ok: true, value: { runtimeSessionId: events[0].runtimeSessionId, lastSequence: events.length, events } }) }, async store => {
    store.ensureNativeSession('t1'); await settle();
    html = renderToStaticMarkup(React.createElement(load('features/native-session/NativeSessionView.tsx').NativeSessionView, { terminalId: 't1', projectId: 'p1', handoff: handoffStub(), onError() {}, onOpenLink() {} }));
  });
  return html;
}

test('events become the reading view’s entries: your message and pictures, the reply, steps with their output and state, the plan and the diff, and nothing made up', () => {
  const { nativeEntries } = load('features/native-session/native-entries.ts'), { applyEvents, emptyModel } = load('features/native-session/native-model.ts'), ev = stream();
  const model = applyEvents(emptyModel(), [
    ...richSession(ev),
    ev('item.upsert', { kind: 'tool', status: 'completed', content: { name: 'Read', input: '{"file_path":"/a/b.ts"}', output: 'file text' } }, { itemId: 't1' }),
    ev('item.upsert', { kind: 'tool', status: 'failed', content: { tool: 'search', server: 'docs', arguments: { q: 1 }, output: 'nope' } }, { itemId: 't2' }),
    ev('item.upsert', { kind: 'command', status: 'completed', content: { command: 'npm test', exitCode: 1, durationMs: 1500, output: 'boom' } }, { itemId: 'k2' }),
    ev('item.upsert', { kind: 'file-change', status: 'completed', content: { name: 'Edit', input: '{"file_path":"src/b.ts"}' } }, { itemId: 'f2' }),
  ]).model;
  const entries = nativeEntries(model, { c1: ['data:image/png;base64,AAAA'] });
  assert.deepEqual(entries.map(entry => [entry.role, entry.id]), [['user', 'u1'], ['tool', 'k1'], ['tool', 'f1'], ['assistant', 'm1'], ['tool', 't1'], ['tool', 't2'], ['tool', 'k2'], ['tool', 'f2'], ['tool', 'native:plan'], ['tool', 'native:diff']],
    'a thinking summary is not part of the reading view’s conversation');
  const by = id => entries.find(entry => entry.id === id);
  assert.deepEqual([by('u1').text, by('u1').images], ['fix the test', ['data:image/png;base64,AAAA']]);
  assert.equal(by('m1').text, 'Done: it passes now.');
  assert.deepEqual([by('k1').tool.kind, by('k1').tool.target, by('k1').tool.done, by('k1').tool.failed, by('k1').tool.output], ['command', 'npm test', false, false, 'FAIL a.test.js'], 'a running command shows its output so far');
  assert.deepEqual([by('f1').tool.kind, by('f1').tool.target, by('f1').tool.written, by('f1').tool.done, by('f1').tool.output], ['edit', 'src/a.ts', ['src/a.ts'], true, '-old\n+new']);
  assert.deepEqual([by('t1').tool.kind, by('t1').tool.target, by('t1').tool.output], ['read', '/a/b.ts', 'file text'], 'a tool shows its result, never its input as JSON');
  assert.deepEqual([by('t2').tool.kind, by('t2').tool.target, by('t2').tool.failed, by('t2').tool.done], ['mcp', 'docs · search', true, true]);
  assert.deepEqual([by('k2').tool.failed, by('k2').tool.detail], [true, '退出码 1 · 用时 1.5 秒'], 'a failed exit code fails the step; a folder nobody gave is not written');
  assert.deepEqual([by('f2').tool.target, by('f2').tool.written], ['src/b.ts', ['src/b.ts']], 'Claude names its edited file only in the input');
  assert.deepEqual([by('native:plan').tool.detail, by('native:plan').tool.output], ['1 / 2 步', '[x] Run tests\n[ ] Fix']);
  assert.equal(by('native:diff').tool.output, '+added line\n-removed line');
  const bare = nativeEntries(applyEvents(emptyModel(), [ev('item.upsert', { kind: 'agent-message', status: 'completed', content: { text: 'hi' } }, { itemId: 'a1', occurredAtMs: null, receivedAtMs: 5 }), ev('item.upsert', { kind: 'agent-message', status: 'completed', content: {} }, { itemId: 'a2' })]).model);
  assert.deepEqual(bare.map(entry => [entry.id, entry.at]), [['a1', 5]], 'an empty message is no entry');
  const stopped = nativeEntries(applyEvents(emptyModel(), [ev('item.upsert', { kind: 'command', status: 'in_progress', content: { command: 'sleep 9' } }, { itemId: 'k' }), ev('session.state', { state: 'stopped', reason: 'user' })]).model);
  assert.deepEqual([stopped[0].tool.done, stopped[0].tool.failed], [true, true], 'a step of a finished session does not run for ever, and is not drawn as done');
});

test('D6 an unknown command result is settled without a failed count, while a real interruption remains failed', () => {
  const { nativeEntries } = load('features/native-session/native-entries.ts'), { applyEvents, emptyModel } = load('features/native-session/native-model.ts');
  for (const status of ['unknown', 'interrupted']) {
    const ev = stream(), model = applyEvents(emptyModel(), [
      ev('item.upsert', { kind: 'command', status, content: { command: 'echo result', exitCode: null } }, { itemId: 'command' }),
      ev('turn.completed', { status: status === 'unknown' ? 'completed' : 'interrupted', error: null }),
      ev('session.state', { state: 'idle' }),
    ]).model;
    const step = nativeEntries(model)[0].tool;
    assert.equal(step.done, true); assert.equal(step.failed, status === 'interrupted');
    assert.equal(step.detail.includes('已中断'), status === 'interrupted');
  }
});

test('tool steps read the structured fields first: the output, path, command and phrase, and a change’s diff; JSON and pictures are never shown, and TodoWrite is no file change', () => {
  const { nativeEntries } = load('features/native-session/native-entries.ts'), { applyEvents, emptyModel } = load('features/native-session/native-model.ts'), ev = stream();
  const upsert = (itemId, kind, content, status = 'completed') => ev('item.upsert', { kind, status, content }, { itemId });
  const big = '{"file_path":"' + 'x'.repeat(70000);
  const model = applyEvents(emptyModel(), [
    upsert('r', 'tool', { name: 'Read', path: '/a/b.ts', input: big, output: 'one\ntwo' }),
    upsert('g', 'tool', { name: 'Agent', input: '{"description":"find the bug","subagent_type":"x"}', output: [{ type: 'text', text: 'found it' }, { type: 'image', source: { data: 'QUJD' } }] }),
    upsert('m', 'tool', { name: 'lookup', server: 'docs', arguments: { q: 1 }, result: { content: [{ type: 'text', text: 'three hits' }], structuredContent: { hits: 3 } } }),
    upsert('i', 'tool', { name: 'Screenshot', output: '[Image result]' }),
    upsert('t', 'tool', { name: 'TodoWrite', input: '{"todos":[]}', output: 'Todos have been modified' }),
    upsert('w', 'file-change', { name: 'Write', path: 'src/big.ts', input: big, changes: [{ path: 'src/big.ts', kind: 'write', diff: 'line 1\nline 2' }], output: 'File created' }),
    upsert('e', 'file-change', { name: 'Edit', path: 'src/a.ts', changes: [{ path: 'src/a.ts', kind: 'edit', diff: 'old\n->\nnew' }] }),
    upsert('b', 'command', { name: 'Bash', command: 'npm test', phrase: '运行测试', input: big, output: 'ok' }),
  ]).model;
  const entries = nativeEntries(model), by = id => entries.find(entry => entry.id === id).tool;
  assert.deepEqual([by('r').kind, by('r').target, by('r').output], ['read', '/a/b.ts', 'one\ntwo'], 'the path is its own field, not read out of a cut-off JSON input');
  assert.deepEqual([by('g').kind, by('g').target, by('g').output], ['agent', 'find the bug', 'found it'], 'blocks give their text; a picture block gives nothing');
  assert.deepEqual([by('m').target, by('m').output], ['docs · lookup', 'three hits']);
  assert.equal(by('i').output, '[Image result]');
  for (const id of ['r', 'g', 'm', 'i', 't', 'w', 'e', 'b']) assert.doesNotMatch(by(id).output ?? '', /[{]["\s]|base64|QUJD/, `${id} shows no JSON or picture data`);
  assert.deepEqual([by('t').kind, by('t').written, by('t').output], ['other', undefined, 'Todos have been modified'], 'TodoWrite is a tool, not a change to a file');
  assert.deepEqual([by('w').kind, by('w').target, by('w').written, by('w').output], ['edit', 'src/big.ts', ['src/big.ts'], 'line 1\nline 2'], 'a large Write keeps its path and shows its content as the diff');
  assert.deepEqual([by('e').target, by('e').output], ['src/a.ts', 'old\n->\nnew']);
  assert.deepEqual([by('b').target, by('b').phrase, by('b').output], ['npm test', '运行测试', 'ok']);
});

test('a step with no result once its turn is over is interrupted, never running and never done: on an idle session, a stopped one, or by its own status', () => {
  const { nativeEntries, runningStep } = load('features/native-session/native-entries.ts'), { applyEvents, emptyModel } = load('features/native-session/native-model.ts'), ev = stream();
  const steps = [
    ev('session.state', { state: 'running' }),
    ev('turn.started', { origin: 'user', clientMessageId: 'c' }),
    ev('item.upsert', { kind: 'command', status: 'in_progress', content: { command: 'sleep 9' } }, { itemId: 'k' }),
    ev('item.upsert', { kind: 'tool', status: 'completed', content: { name: 'Read', path: '/a' } }, { itemId: 'r' }),
    ev('item.upsert', { kind: 'tool', status: 'interrupted', content: { name: 'Glob' } }, { itemId: 'q' }),
  ];
  const marks = model => Object.fromEntries(nativeEntries(model).map(entry => [entry.id, [entry.tool.done, entry.tool.failed, entry.tool.detail]]));
  const running = applyEvents(emptyModel(), steps).model;
  assert.deepEqual(marks(running), { k: [false, false, ''], r: [true, false, ''], q: [true, true, '已中断'] }, 'while the turn runs a step runs; a step the provider interrupted is a cross');
  assert.equal(runningStep(nativeEntries(running)).target, 'sleep 9');
  const idleButTurn = applyEvents(running, [ev('session.state', { state: 'idle' })]).model;
  assert.deepEqual([idleButTurn.session.state, marks(idleButTurn).k[0]], ['idle', false], 'an idle state while a turn still runs does not end its steps');
  const idle = applyEvents(idleButTurn, [ev('turn.completed', { status: 'interrupted', error: null })]).model;
  const stopped = applyEvents(idle, [ev('session.state', { state: 'stopped', reason: 'user' })]).model;
  for (const [name, over] of [['idle', idle], ['stopped', stopped]]) {
    assert.deepEqual(marks(over), { k: [true, true, '已中断'], r: [true, false, ''], q: [true, true, '已中断'] }, name);
    assert.equal(runningStep(nativeEntries(over)), null, 'nothing is shown running once the turn is over');
  }
});

test('a drawn picture, the owner’s pictures and the note for omitted ones become entries of the reading view, and every item shows the time its record gives', () => {
  const { nativeEntries } = load('features/native-session/native-entries.ts'), { applyEvents, emptyModel } = load('features/native-session/native-model.ts'), ev = stream();
  const model = applyEvents(emptyModel(), [
    ev('item.upsert', { kind: 'user-message', status: 'completed', content: { text: 'look', clientMessageId: 'u1', images: ['data:image/png;base64,AAAA'] } }, { itemId: 'u1', occurredAtMs: 111 }),
    ev('item.upsert', { kind: 'user-message', status: 'completed', content: { text: 'and this one', clientMessageId: 'u2', images: [], imagesOmitted: true } }, { itemId: 'u2', occurredAtMs: 222 }),
    ev('item.upsert', { kind: 'user-message', status: 'completed', content: { text: '', clientMessageId: 'u3', images: [], imagesOmitted: true } }, { itemId: 'u3', occurredAtMs: null, receivedAtMs: 333 }),
    ev('item.upsert', { kind: 'agent-message', status: 'completed', content: { text: '', generated: { path: '/p/generated_images/a.png', prompt: 'a red fox' }, images: ['data:image/jpeg;base64,BBBB'] } }, { itemId: 'g1', occurredAtMs: 444 }),
    ev('item.upsert', { kind: 'agent-message', status: 'completed', content: { text: '', generated: { path: '/p/generated_images/b.png', prompt: 'no thumbnail' }, images: [] } }, { itemId: 'g2' }),
  ]).model;
  const entries = nativeEntries(model, { u2: ['data:image/png;base64,CCCC'] }), by = id => entries.find(entry => entry.id === id);
  assert.deepEqual(entries.map(entry => [entry.id, entry.at]), [['u1', 111], ['u2', 222], ['u3', 333], ['g1', 444]], 'the record’s own time, the time heard when it gave none; a drawing with no picture to show is no entry');
  assert.deepEqual([by('u1').images, by('u1').imagesOmitted], [['data:image/png;base64,AAAA'], undefined]);
  assert.deepEqual([by('u2').images, by('u2').imagesOmitted], [['data:image/png;base64,CCCC'], undefined], 'the pictures this window still holds are shown, and then nothing was omitted');
  assert.deepEqual([by('u3').text, by('u3').images, by('u3').imagesOmitted], ['', undefined, true], 'omitted pictures leave the note, even with no words');
  assert.deepEqual([by('g1').role, by('g1').generated, by('g1').images], ['assistant', { path: '/p/generated_images/a.png', prompt: 'a red fox' }, ['data:image/jpeg;base64,BBBB']]);
  const replayed = applyEvents(emptyModel(), [ev('item.delta', { channel: 'text', text: 'Hel' }, { itemId: 'a', occurredAtMs: null, receivedAtMs: 900 }), ev('item.upsert', { kind: 'agent-message', status: 'completed', content: { text: 'Hello' } }, { itemId: 'a', occurredAtMs: 500 })]).model;
  assert.equal(replayed.items.a.at, 500, 'a replayed record’s own time replaces the time it was first heard');
});

test('Codex: a command reads its phrase from main, and the plan and diff of an earlier turn are gone when a new one starts', () => {
  const { nativeEntries } = load('features/native-session/native-entries.ts'), { applyEvents, emptyModel } = load('features/native-session/native-model.ts'), ev = stream({ provider: 'codex', transport: 'codex-app-server' });
  const first = applyEvents(emptyModel(), [
    ev('turn.started', { origin: 'user', clientMessageId: 'c1' }),
    ev('item.upsert', { kind: 'command', status: 'completed', content: { command: ['npm', 'test'], phrase: '运行测试', exitCode: 0 } }, { itemId: 'k' }),
    ev('plan.updated', { explanation: null, steps: [{ step: 'A', status: 'completed' }] }), ev('turn.diff', { diff: '+x' }), ev('session.state', { state: 'idle' }),
  ]).model;
  assert.deepEqual(nativeEntries(first).map(entry => entry.id), ['k', 'native:plan', 'native:diff']);
  assert.equal(nativeEntries(first)[0].tool.phrase, '运行测试');
  const second = applyEvents(first, [ev('turn.started', { origin: 'user', clientMessageId: 'c2' })]).model;
  assert.deepEqual(nativeEntries(second).map(entry => entry.id), ['k'], 'the second turn does not end with the first one’s plan and changes');
});

test('what the owner sent and the conversation does not show is pending: sending, queued, or refused and lost; an echoed one is a message, and unknown delivery is never offered again', () => {
  const { nativeEntries, nativePending } = load('features/native-session/native-entries.ts'), { applyEvents, emptyModel } = load('features/native-session/native-model.ts'), ev = stream();
  const user = (id, text, content = {}) => ev('item.upsert', { kind: 'user-message', status: 'completed', content: { text, clientMessageId: id, ...content } }, { itemId: id });
  const receipt = (id, status) => ev('input.receipt', { clientMessageId: id, status });
  const model = applyEvents(emptyModel(), [
    user('c2', 'refused while switching', { unsent: true, images: ['data:image/png;base64,BBBB'] }), user('c3', 'held in the queue'), receipt('c3', 'queued'), user('c4', 'delivered'), receipt('c4', 'consumed'),
    receipt('c6', 'rejected'), receipt('c7', 'unknown'), receipt('c8', 'delivered'),
  ]).model;
  const sent = [{ id: 'c4', text: 'delivered', at: 4 }, { id: 'c5', text: 'in flight', at: 5 }, { id: 'c6', text: 'turned away', at: 6 }, { id: 'c7', text: 'who knows', at: 7 }, { id: 'c8', text: 'read, not echoed', at: 8 }];
  assert.deepEqual(nativeEntries(model).map(entry => entry.id), ['c4'], 'only an ordinary message is in the conversation');
  const { prompts, queued, lost } = nativePending(model, sent);
  const sending = Object.fromEntries(prompts.map(prompt => [prompt.id, prompt.sending]));
  assert.deepEqual(sending, { c2: false, c3: false, c5: true, c6: false, c7: true, c8: false }, 'no receipt or an unknown one reads as sending: it is neither lost nor offered again');
  assert.deepEqual([[...queued], [...lost].sort()], [['c3'], ['c2', 'c6']]);
  assert.deepEqual(prompts.find(prompt => prompt.id === 'c2').images, ['data:image/png;base64,BBBB']);
  assert.deepEqual(nativePending(model, sent, new Set(['c2', 'c5'])).prompts.map(prompt => prompt.id).sort(), ['c3', 'c6', 'c7', 'c8']);
  assert.equal(nativePending(model, sent, new Set(['c2'])).lost.has('c2'), false, 'a dismissed card is gone with its mark');
});

test('the view is the reading view’s: its markup is the feed’s, the working line and the stop are the reading view’s, and nothing is native-only but the requests', async () => {
  const html = await viewHtml(richSession);
  assert.match(html, /<div class="reading-view" data-agent="claude" data-native-session="rs1">/);
  assert.match(html, /class="reading-step is-user/); assert.match(html, /<p class="is-folded">fix the test<\/p>/); assert.match(html, /class="reading-step is-agent is-claude/);
  assert.match(html, /<div class="md">Done: it passes now\.<\/div>/);
  assert.match(html, /class="reading-tools[^"]*is-running/); assert.match(html, /运行 1 条命令/);
  const running = await viewHtml(ev => [ev('session.state', { state: 'running' }), ev('item.upsert', { kind: 'command', status: 'in_progress', content: { command: 'npm test' } }, { itemId: 'k1' }), ev('item.delta', { channel: 'output', text: 'FAIL a.test.js' }, { itemId: 'k1' })]);
  assert.match(running, /<code title="npm test">/, 'the group at the end that still runs is open, as the reading view opens it, with the step’s row');
  assert.doesNotMatch(running, /reading-tool-output|FAIL a\.test\.js/, 'the native view draws no output box for a step, running or done');
  assert.match(html, /运行 1 条命令 · 编辑 1 个文件/); assert.match(html, /<code class="reading-tools-file">[^>]*a\.ts/); assert.match(html, /调用 1 个工具/, 'the plan and the diff are steps of the last group');
  assert.match(html, /reading-status is-working is-claude/); assert.match(html, /正在运行 npm test/); assert.match(html, /Esc 中断/);
  assert.match(html, /title="中断（Esc）"/, 'the stop button is the reading view’s, in the composer'); assert.doesNotMatch(html, /<textarea[^>]*disabled/, 'and the message box stays usable');
  assert.match(html, /<div class="native-tail">/); assert.match(html, /Run rm -rf build/); assert.match(html, />允许本次</); assert.match(html, />拒绝</);
  assert.doesNotMatch(html, /native-head|native-state|native-runtime|native-stop|native-receipt|native-step|Claude · API|已被读取|会话已就绪|→/, 'no header, no receipt words, no native-only decoration');
  assert.doesNotMatch(html, /思考摘要|Looking at the failing/, 'a thinking summary is not drawn');
  assert.doesNotMatch(html, /Codex/);
});

test('the native view hides tool output: the rows stay, a failed step gives one reason, a "!" card keeps its output', async () => {
  const html = await viewHtml(ev => [ev('session.state', { state: 'running' }),
    ev('item.upsert', { kind: 'command', status: 'completed', content: { command: 'npm run build', exitCode: 2, output: 'error TS1: first problem\nmore lines\nand more' } }, { itemId: 'k1' }),
    ev('item.upsert', { kind: 'tool', status: 'completed', content: { name: 'Read', input: '{"file_path":"/a/b.ts"}', output: 'FILE_TEXT_BODY' } }, { itemId: 't1' }),
    ev('item.upsert', { kind: 'command', status: 'completed', content: { command: 'ls -la', exitCode: 0, output: 'BANG_LISTING' } }, { itemId: 'shell:c1' }),
    ev('item.upsert', { kind: 'command', status: 'in_progress', content: { command: 'sleep 9' } }, { itemId: 'k3' })]); // a running step keeps the last group open
  assert.doesNotMatch(html, /FILE_TEXT_BODY|more lines|and more/, 'no output of a read or a command');
  assert.match(html, /<code title="npm run build">/); assert.match(html, /<code title="\/a\/b\.ts">/, 'the rows keep the command and the path');
  assert.match(html, /<small class="reading-tool-reason" title="error TS1: first problem">error TS1: first problem<\/small>/, 'a failed step says why in one line');
  assert.match(html, /退出码 2/, 'and keeps its failed mark and exit code');
  assert.match(html, /<pre class="reading-tool-output">BANG_LISTING<\/pre>/, 'a "!" card is the owner’s own command: its output shows');
});

test('a finished session says why and offers a new conversation; a Codex session is the reading view’s Codex; an idle one has no stop and no line of its own before there is a reply', async () => {
  const ended = await viewHtml(ev => [ev('session.state', { state: 'failed', reason: 'native_cli_required' })]);
  assert.match(ended, /未找到原生 Claude Code，无法通过 API 运行/); assert.match(ended, /开始新的对话/); assert.match(ended, /<textarea[^>]*disabled/); assert.doesNotMatch(ended, /中断（Esc）/);
  const round = (ev, completed) => [ev('session.state', { state: 'idle', reason: null }), ev('item.upsert', { kind: 'user-message', status: 'completed', content: { text: 'hi', clientMessageId: 'c1' } }, { itemId: 'u1' }),
    ev('item.upsert', { kind: 'agent-message', status: 'completed', content: { text: 'hello' } }, { itemId: 'a1' }), ev('turn.completed', completed)];
  const codex = await viewHtml(ev => round(ev, { status: 'completed', error: null }), { provider: 'codex', transport: 'codex-app-server' });
  assert.match(codex, /data-agent="codex"/); assert.match(codex, /<b class="reading-step-label">Codex<\/b>/); assert.match(codex, /class="result-status"/, 'a finished round has the reading view’s result row'); assert.doesNotMatch(codex, /中断（Esc）/);
  assert.doesNotMatch(codex, /<textarea[^>]*disabled/); assert.doesNotMatch(codex, /本轮已完成|空闲|Codex · 原生/);
  const failed = await viewHtml(ev => round(ev, { status: 'failed', error: 'max_turns reached' }));
  assert.match(failed, /result-status is-failed/); assert.match(failed, /失败/, 'a turn that failed is not 已完成, whatever else the result says');
  const empty = await viewHtml(ev => [ev('session.state', { state: 'idle', reason: null })]);
  assert.doesNotMatch(empty, /会话已就绪|result-status|reading-step/, 'nothing yet: no line of its own');
});

// The session component with real hooks, the heavy neighbours stood in. `show` replaces the model's events; `change` is the terminal's SwitchState.
function sessionView(events, bridge, base = {}) {
  const model = require('../src/features/native-session/native-model.ts'), ev = stream(base), dismissed = [], refreshed = [], handoff = handoffStub(), toBottom = [];
  let change = null, voice = null;
  const VoiceButton = () => null, NativePanel = function NativePanel() {}, NativeToast = function NativeToast() {};
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { agentrix: { nativeSession: bridge } } });
  const build = list => ({ model: model.applyEvents(model.emptyModel(), list).model, dismissed: null, noteDismissed: false, handoff: null });
  const parts = { AgentMark() {}, PendingPromptEntries() {}, QuoteChip() {}, quoteExcerpt: load('features/reading/message-quote.ts').quoteExcerpt, withQuote: load('features/reading/message-quote.ts').withQuote, ResultActions() {}, ResultChecks() {}, ResultStatus() {}, TimelineStep() {}, UserImages() {}, WorkingLine() {}, pastedPicture: load('features/reading/image-input.ts').pastedPicture, latestResult: load('features/reading/result-round.ts').latestResult, useStickToBottom: () => ({ stuck: true, unseen: 0, toBottom: () => toBottom.push(true), ready: true }) };
  // The message box's helpers are the reading view's real ones, run on the same hooks as the view (the harness is made just below).
  const readingFile = file => harness.load(`src/features/reading/${file}`);
  Object.defineProperties(parts, {
    createDictationSend: { value: require('../src/features/reading/dictation-send.ts').createDictationSend },
    splitQuote: { value: load('features/reading/message-quote.ts').splitQuote }, isCommandDraft: { get: () => readingFile('useCommandPalette.ts').isCommandDraft },
    useComposerHistory: { get: () => readingFile('useComposerHistory.ts').useComposerHistory }, useCommandPalette: { get: () => readingFile('useCommandPalette.ts').useCommandPalette },
    useMentions: { get: () => readingFile('useMentions.ts').useMentions }, MentionPalette: { get: () => harness.load('src/features/reading/MentionPalette.tsx').MentionPalette },
    commandList: { get: () => readingFile('CommandList.tsx').commandList }, composerAria: { get: () => readingFile('CommandList.tsx').composerAria },
  });
  const feed = { ConversationDecorations: { Provider() {} }, ConversationFeed() {} };
  const harness = hookHarness('src/features/native-session/NativeSessionView.tsx', {
    '@phosphor-icons/react': new Proxy({}, { get: () => () => null }), './i18n': { t: fill }, './useFittingHint': { fullHintProps: () => ({}), HIDDEN_NOTE: {}, useFittingHint: (box, hints) => hints[0] },
    './action-text': { actionText: tool => `${tool.kind}:${tool.target}` }, './ConversationFeed': feed, './feed-parts': parts,
    './native-entries.ts': load('features/native-session/native-entries.ts'), './native-pictures.ts': load('features/native-session/native-pictures.ts'), './native-bridge.ts': load('features/native-session/native-bridge.ts'), './mention-tokens': load('features/reading/mention-tokens.ts'), './NativeRequestCard': { NativeRequestCard() {} }, './NativePanel': { NativePanel }, './NativeToast': { NativeToast }, './panel-read.ts': load('features/native-session/panel-read.ts'), './native-billing-link.ts': load('features/native-session/native-billing-link.ts'), './native-session.css': {},
    './native-store.ts': { dismissNative: id => dismissed.push(id), refreshNativeSession: id => refreshed.push(id), nativeItem: (terminal, id) => entry.model.items[id], nativeShown: () => true, useNativeEntries: () => new Map(), resolveSwitch: terminal => terminal },
    './native-composer.ts': load('features/native-session/native-composer.ts'),
    './native-notices.ts': load('features/native-session/native-notices.ts'),
    // The hook of the Claude commands runs on the same hooks as the view (the harness is made just below).
    './useComposerActions.ts': { get useComposerActions() { return harness.load('src/features/native-session/useComposerActions.ts').useComposerActions; } },
    './dictation-send': require('../src/features/reading/dictation-send.ts'),
    './voice-input': { dictateInto: (id, insert, sends, options) => { const binding = { id, insert, sends, options }; voice = binding; return () => { if (voice === binding) voice = null; }; } },
    './VoiceButton': { VoiceButton },
    './SwitchNotice': { asksChoice: state => (state?.phase === 'awaiting-choice' || state?.phase === 'waiting-background') && !!state.requestId, SwitchLine() {}, SwitchQuestion() {} }, './native-words': words(),
  });
  let entry = build(events(ev));
  const tree = () => harness.render('NativeSession', { terminalId: 't1', projectId: 'p1', entry, autoFocus: false, switchState: change, handoff, onError() {}, onOpenLink() {} }).result;
  const find = predicate => elements(tree()).find(predicate), box = () => find(node => node.type === 'textarea');
  return {
    ev, find, box, tree, dismissed, refreshed, handoff, parts, toBottom, show(list) { entry = build(list); }, switching(state) { change = state; },
    // The result window the view shows (props: state, onClose, onRefresh) and the note after a setting was changed.
    panel: () => find(node => node.type === NativePanel)?.props, toasts: () => elements(tree()).filter(node => node.type === NativeToast).map(node => node.props.text),
    voice: () => { tree(); return voice; }, voiceButton: () => find(node => node.type === VoiceButton)?.props,
    prompts: () => find(node => node.type === parts.PendingPromptEntries).props, decorations: () => find(node => node.props?.value?.frame).props.value, feed: () => find(node => node.type === feed.ConversationFeed).props,
    type: value => box().props.onChange({ target: { value } }),
    press: (init = {}) => { const prevented = []; box().props.onKeyDown({ key: 'Enter', shiftKey: false, nativeEvent: { isComposing: false }, preventDefault: () => prevented.push(true), stopPropagation() {}, ...init }); return prevented.length; },
    done() { harness.dispose(); if (previous) Object.defineProperty(globalThis, 'window', previous); else delete globalThis.window; },
  };
}
const idle = ev => [ev('session.state', { state: 'idle', reason: null })];
const stopButton = view => view.find(node => node.type === 'button' && node.props.title === '中断（Esc）');

function voiceBox(view, value = '', at = value.length, end = at) {
  const node = { value, selectionStart: at, selectionEnd: end, focus() { document.activeElement = node; }, setSelectionRange(start, finish) { node.selectionStart = start; node.selectionEnd = finish; } };
  view.box().props.ref.current = node; document.activeElement = node;
  view.type(value); return node;
}

for (const provider of ['claude', 'codex']) test(`${provider}: native dictation inserts at the caret, and only an explicit voice submit uses the shared half-second grace`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sends = [], view = sessionView(idle, { send: async (...args) => { sends.push(args); return { ok: true, value: {} }; } }, { provider });
  try {
    const node = voiceBox(view, 'before after', 7);
    assert.ok(view.voice(), 'native composer registers with the existing dictation controller');
    assert.deepEqual([view.voice().id, view.voice().sends, view.voiceButton().disabled], ['t1', true, false]);
    view.voice().insert('spoken ', false); view.tree();
    assert.equal(view.box().props.value, 'before spoken after');
    assert.equal(node.selectionStart, 14); t.mock.timers.tick(500); await settle(); assert.deepEqual(sends, []);
    node.value = view.box().props.value; node.selectionStart = node.selectionEnd = node.value.length;
    view.voice().insert(' next', true); view.tree();
    t.mock.timers.tick(499); await settle(); assert.deepEqual(sends, []);
    t.mock.timers.tick(1); await settle();
    assert.equal(sends.length, 1); assert.equal(sends[0][3], 'before spoken after next');
    view.voiceButton().onError('麦克风访问被拒绝，请在 Windows 设置中允许桌面应用使用麦克风。');
    assert.match(view.find(node => node.props.role === 'alert').props.children, /麦克风访问被拒绝/);
  } finally { document.activeElement = null; view.done(); }
});

test('native dictation follows composer availability and discards stale recordings and delayed sends across switches and session replacement', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sends = [], view = sessionView(idle, { send: async (...args) => { sends.push(args); return { ok: true, value: {} }; } });
  try {
    voiceBox(view);
    view.show([view.ev('session.state', { state: 'running' })]);
    assert.equal(view.voiceButton().disabled, false, 'work still takes owner input');
    const previous = view.voice(); previous.insert('held', true); view.tree();
    view.handoff.locked = true; view.tree();
    assert.equal(view.voiceButton().disabled, true); assert.equal(view.voice().options.available(), false);
    view.handoff.locked = false; view.tree();
    previous.insert('STALE', true); view.tree(); t.mock.timers.tick(500); await settle();
    assert.equal(view.box().props.value, 'held'); assert.deepEqual(sends, []);
    const oldSession = view.voice(), other = stream({ runtimeSessionId: 'replacement' });
    view.show([other('session.state', { state: 'idle' })]); view.tree();
    oldSession.insert('OLD_SESSION', true); view.tree();
    assert.doesNotMatch(view.box().props.value, /OLD_SESSION/);
    view.show([other('session.state', { state: 'closed' })]); view.tree();
    assert.equal(view.voiceButton().disabled, true); assert.equal(view.voice().options.available(), false);
    t.mock.timers.tick(500); await settle(); assert.deepEqual(sends, []);
  } finally { document.activeElement = null; view.done(); }
});

test('native dictation grace cancels on editing, IME, Escape, unmount and direct Enter sends once', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const action of ['edit', 'ime', 'escape', 'unmount', 'enter']) {
    const sends = [], view = sessionView(idle, { send: async (...args) => { sends.push(args); return { ok: true, value: {} }; } });
    let disposed = false;
    try {
      voiceBox(view); view.voice().insert('spoken', true); view.tree();
      if (action === 'edit') view.type('edited');
      if (action === 'ime') view.box().props.onCompositionStart();
      if (action === 'escape') view.press({ key: 'Escape' });
      if (action === 'unmount') { view.done(); disposed = true; }
      if (action === 'enter') view.press();
      if (!disposed) view.tree(); t.mock.timers.tick(500); await settle();
      assert.equal(sends.length, action === 'enter' ? 1 : 0, action);
    } finally { document.activeElement = null; if (!disposed) view.done(); }
  }
});

test('Enter sends the trimmed message at once and shows it as sending until the runtime echoes it; Shift+Enter, IME and an empty box send nothing', async () => {
  const sends = [], view = sessionView(idle, { send: async (...args) => { sends.push(args); return { ok: true, value: {} }; } });
  try {
    view.press(); view.type('   '); view.press(); view.type('hello'); view.press({ shiftKey: true }); view.press({ nativeEvent: { isComposing: true } });
    assert.deepEqual(sends, []);
    view.type('  hello  ');
    assert.equal(view.press(), 1, 'Enter is taken so it adds no line'); await settle();
    assert.equal(sends.length, 1); const [terminal, session, id, text] = sends[0];
    assert.deepEqual([terminal, session, typeof id, text], ['t1', 'rs1', 'string', 'hello']);
    assert.equal(view.box().props.value, '', 'the box emptied');
    assert.deepEqual(view.prompts().prompts.map(prompt => [prompt.text, prompt.sending]), [['hello', true]], 'until a receipt arrives it reads as being sent, as the reading view’s pending message');
    const echo = status => [...idle(view.ev), view.ev('item.upsert', { kind: 'user-message', status: 'completed', content: { text: 'hello', clientMessageId: id } }, { itemId: id }), view.ev('input.receipt', { clientMessageId: id, status })];
    view.show(echo('consumed'));
    assert.deepEqual(view.prompts().prompts, [], 'the echoed message is in the conversation, not also pending');
    assert.deepEqual(view.feed().entries.map(entry => [entry.role, entry.text]), [['user', 'hello']]);
    view.show(echo('queued'));
    assert.deepEqual([view.prompts().prompts.length, view.prompts().queued(view.prompts().prompts[0]), view.feed().entries.length], [1, true, 0], 'held in the runtime’s queue it waits, as a queued message does in the reading view');
  } finally { view.done(); }
});

test('a picture pasted or dropped joins the next message, and pictures alone can be sent; what the runtime would refuse is refused first, with the reason', async () => {
  const sends = [], view = sessionView(idle, { send: async (...args) => { sends.push(args); return { ok: true, value: {} }; } });
  const reader = globalThis.FileReader;
  globalThis.FileReader = class { readAsDataURL(file) { setImmediate(() => { this.result = `data:${file.type};base64,${file.body}`; this.onload(); }); } };
  const file = (type, body = 'AAAA', size = 4) => ({ type, body, size });
  const attached = () => elements(view.tree()).find(node => node.type === view.parts.UserImages)?.props.images;
  const sendButton = () => elements(view.tree()).find(node => node.type === 'button' && /reading-send/.test(node.props.className ?? ''));
  const paste = (items, text = '') => { const prevented = []; view.box().props.onPaste({ clipboardData: { getData: () => text, items }, preventDefault: () => prevented.push(true) }); return prevented.length; };
  const item = (picture, type = picture.type) => ({ kind: 'file', type, getAsFile: () => picture });
  const root = () => elements(view.tree()).find(node => node.props?.['data-native-session']).props;
  const drop = (files, types = ['Files']) => { const prevented = [], dataTransfer = { types, files }; root().onDrop({ dataTransfer, preventDefault: () => prevented.push(true) }); return prevented.length; };
  const error = () => elements(view.tree()).find(node => node.props?.role === 'alert')?.props.children;
  try {
    assert.equal(sendButton().props.disabled, true, 'nothing to send yet');
    assert.equal(paste([item(file('image/png'))], 'copied words'), 0, 'a paste with words is the box’s own');
    assert.equal(paste([{ kind: 'string', type: 'text/plain' }]), 0);
    assert.equal(paste([item(file('image/png', 'AAAA'))]), 1, 'a pasted picture is taken from the box');
    await settle(); view.tree();
    assert.deepEqual(attached(), ['data:image/png;base64,AAAA']);
    assert.equal(sendButton().props.disabled, false, 'a picture alone can be sent');
    paste([item(file('image/gif'))]); await settle();
    assert.deepEqual([attached().length, error()], [1, '只能附加 PNG、JPEG 或 WebP 图片。'], 'a format the runtime refuses is refused before it is attached');
    paste([item(file('image/webp', 'W', 6 * 1024 * 1024))]); await settle();
    assert.deepEqual([attached().length, error()], [1, '图片太大（超过 5 MB），请压缩后再附加。']);
    assert.equal(drop([file('image/jpeg', 'BBBB')]), 1, 'the drop is taken so the window does not open the file'); await settle(); view.tree();
    assert.deepEqual([attached(), error()], [['data:image/png;base64,AAAA', 'data:image/jpeg;base64,BBBB'], undefined], 'a drop adds to the pictures and clears the earlier error');
    assert.equal(drop([], ['text/plain']), 0, 'a drag that carries no file is left alone');
    drop([file('image/png', 'C'), file('image/png', 'D'), file('image/png', 'E')]); await settle(); view.tree();
    assert.deepEqual([attached().length, error()], [4, '最多附加 4 张图片，请先移除一张。'], 'four pictures at most');
    view.press(); await settle(); view.tree();
    assert.equal(sends.length, 1, 'Enter with only pictures sends them');
    assert.deepEqual([sends[0][3], sends[0][4].length], ['', 4], 'pictures alone need no words');
    assert.equal(attached(), undefined, 'the pictures left with the message');
    view.type('look at this'); paste([item(file('image/png', 'F'))]); await settle(); view.tree(); view.press(); await settle();
    assert.deepEqual([sends[1][3], sends[1][4]], ['look at this', ['data:image/png;base64,F']], 'words and a picture go together');
  } finally { globalThis.FileReader = reader; view.done(); }
});

test('while the box is shut a drop is taken and nothing is attached', async () => {
  const view = sessionView(ended => [...idle(ended), ended('session.state', { state: 'stopped', reason: 'user' })], {});
  try {
    const prevented = [];
    elements(view.tree()).find(node => node.props?.['data-native-session']).props.onDrop({ dataTransfer: { types: ['Files'], files: [{ type: 'image/png', size: 1 }] }, preventDefault: () => prevented.push(true) });
    await settle();
    assert.deepEqual([prevented.length, elements(view.tree()).some(node => node.type === view.parts.UserImages)], [1, false]);
  } finally { view.done(); }
});

test('a message the main process refuses comes back into the box with the reason, unless something new was typed meanwhile', async () => {
  const answers = [{ ok: false, error: 'no such session' }, { ok: false, error: 'busy' }], view = sessionView(idle, { send: async () => answers.shift() });
  try {
    view.type('please retry'); view.press(); await settle();
    assert.deepEqual([view.box().props.value, view.find(node => node.props?.role === 'alert').props.children], ['please retry', 'no such session']);
    assert.deepEqual(view.prompts().prompts, [], 'nothing is shown as sent');
    view.press(); view.type('something else'); await settle();
    assert.equal(view.box().props.value, 'something else');
  } finally { view.done(); }
});

test('a message sent while the switch freezes the input is shown as unsent, never as sent; sending it again is the owner’s click, and a refusal brings the card back', async () => {
  const sends = [], answers = [{ ok: true, value: {} }, { ok: false, error: 'frozen' }];
  const view = sessionView(idle, { send: async (...args) => { sends.push(args); return answers.shift(); } });
  try {
    view.type('while frozen'); view.press(); await settle();
    const id = sends[0][2];
    // Main took the call and refused the message: an unsent item with the same id, and no receipt of delivery.
    view.show([...idle(view.ev), view.ev('item.upsert', { kind: 'user-message', status: 'interrupted', content: { text: 'while frozen', clientMessageId: id, unsent: true } }, { itemId: id })]);
    const shown = view.prompts();
    assert.deepEqual(shown.prompts.map(prompt => prompt.text), ['while frozen']); assert.equal(shown.undelivered(shown.prompts[0]), true, 'drawn as not delivered');
    assert.equal(shown.queued(shown.prompts[0]), false); assert.deepEqual(view.feed().entries, [], 'and not as a message of the conversation');
    view.tree(); assert.deepEqual(view.handoff.offers.at(-1).undelivered, [{ clientMessageId: id, text: 'while frozen', images: undefined }], 'a switch carries it as unsent');
    shown.onResend(shown.prompts[0]); await settle();
    assert.deepEqual([sends.length, sends[1][3], sends[1][2] === id], [2, 'while frozen', false], 'sent again as a new message, by the click');
    assert.equal(view.prompts().prompts.some(prompt => prompt.id === id), true, 'the refused send brings the first card back');
    view.prompts().onDiscard(view.prompts().prompts.find(prompt => prompt.id === id));
    assert.equal(view.prompts().prompts.some(prompt => prompt.id === id), false, 'and the owner can drop it');
  } finally { view.done(); }
});

test('a quoted message waits above the box and goes before the words of the next message only, as in the reading view; a refused send gives it back', async () => {
  const sends = [], answers = [{ ok: false, error: 'busy' }, { ok: true, value: {} }];
  const view = sessionView(idle, { send: async (...args) => { sends.push(args); return answers.shift(); } });
  try {
    const quote = () => view.find(node => node.type === view.parts.QuoteChip)?.props.quote;
    assert.equal(view.decorations().quote.disabled, null);
    const words = ['the plan', 'is this'].join('\n'), sent = ['> the plan', '> is this', '', 'ok'].join('\n');
    view.decorations().quote.pick('Claude Code', words); view.tree();
    assert.deepEqual(quote(), { who: 'Claude Code', excerpt: words });
    view.type('ok'); view.press(); await settle();
    assert.equal(sends[0][3], sent); assert.equal(quote().who, 'Claude Code', 'the refused send gives the quote back');
    view.type('ok'); view.press(); await settle();
    assert.equal(sends[1][3], sent); assert.equal(quote(), undefined, 'a quote goes with one message');
  } finally { view.done(); }
});

test('Stop is the composer’s button while it works, Esc does the same, neither is offered when idle; a finished session takes no message and can be closed', async () => {
  const interrupts = [], bridge = { interrupt: async (...args) => { interrupts.push(args); return { ok: true, value: {} }; }, send: async () => assert.fail('nothing to send') };
  const working = sessionView(ev => [...idle(ev), ev('turn.started', { origin: 'user', clientMessageId: null })], bridge);
  try {
    stopButton(working).props.onClick(); await settle();
    working.box().props.onKeyDown({ key: 'Escape', nativeEvent: { isComposing: false }, preventDefault() {} }); await settle();
    assert.deepEqual(interrupts, [['t1', 'rs1'], ['t1', 'rs1']]);
    working.show(idle(working.ev));
    assert.equal(stopButton(working), undefined, 'idle: no Stop');
    working.box().props.onKeyDown({ key: 'Escape', nativeEvent: { isComposing: false }, preventDefault() {} }); await settle();
    assert.equal(interrupts.length, 2, 'and Esc interrupts nothing');
  } finally { working.done(); }
  const ended = sessionView(ev => [ev('session.state', { state: 'stopped', reason: 'user' })], bridge);
  try {
    assert.equal(ended.box().props.disabled, true);
    ended.type('too late'); ended.press(); await settle();
    ended.find(node => node.type === 'button' && node.props.children === '开始新的对话').props.onClick();
    assert.deepEqual(ended.dismissed, ['t1']);
  } finally { ended.done(); }
});

// ---- the message box: the reading view's ↑↓ history, "/" command list and "@" files, on the same code -------------------------------------
// A stand-in for the textarea the key is pressed in: the caret and the selection, as the reading view's history reads them.
const caretAt = (start, end = start) => ({ selectionStart: start, selectionEnd: end, parentElement: null, focus() {}, setSelectionRange(from, to) { this.selectionStart = from; this.selectionEnd = to; } });
const keyIn = (view, key, init = {}) => {
  const prevented = [];
  view.box().props.onKeyDown({ key, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, currentTarget: caretAt(0), nativeEvent: { isComposing: false }, preventDefault: () => prevented.push(true), ...init });
  return prevented.length;
};
// Typing as the owner does: the box takes the words, the view draws them, and what it asked for meanwhile has been answered.
const typeIn = async (view, value) => { view.type(value); view.tree(); await settle(); view.tree(); };
const userMessage = (ev, id, text, extra = {}) => ev('item.upsert', { kind: 'user-message', status: 'completed', content: { text, clientMessageId: id } }, { itemId: id, ...extra });
const listbox = view => elements(view.tree()).find(node => node.props?.role === 'listbox');
const options = view => elements(listbox(view)).filter(node => node.props?.role === 'option');
const optionNames = view => options(view).map(node => elements(node).find(child => child.type === 'code').props.children);

test('↑ at the start of the box takes the message sent before, ↓ at the end the one after, and past the newest the draft that was not sent; the history replayed after a switch is in it', () => {
  const view = sessionView(ev => [...idle(ev), userMessage(ev, 'c1', 'first', { replay: true }), userMessage(ev, 'c2', '> quoted\n\nsecond', { replay: true }), userMessage(ev, 'c3', 'third')], {});
  try {
    view.type('my draft');
    const body = () => view.box().props.value, caret = caretAt(0), press = (key, init) => keyIn(view, key, { currentTarget: caret, ...init });
    assert.equal(press('ArrowUp', { shiftKey: true }) + press('ArrowUp', { ctrlKey: true }) + press('ArrowUp', { altKey: true }) + press('ArrowUp', { metaKey: true }), 0, 'with a modifier the arrow is the box’s own');
    caret.selectionEnd = 5; assert.equal(press('ArrowUp'), 0, 'with words selected it is the box’s own'); caret.selectionEnd = 0;
    caret.selectionStart = caret.selectionEnd = 3; assert.equal(press('ArrowUp'), 0, 'not at the start: the caret moves up a line'); caret.selectionStart = caret.selectionEnd = 0;
    assert.equal(press('ArrowDown'), 0, 'before any ↑, ↓ is the box’s own');
    assert.equal(press('ArrowUp'), 1); assert.equal(body(), 'third'); assert.equal(caret.selectionStart, 0, 'the caret waits at the start so ↑ goes on');
    assert.equal(press('ArrowUp'), 1); assert.equal(body(), 'second', 'a quote it carried is not part of what is brought back');
    press('ArrowUp'); assert.equal(body(), 'first', 'the replayed history is reachable');
    press('ArrowUp'); assert.equal(body(), 'first', 'the oldest stays');
    assert.equal(press('ArrowDown', { currentTarget: caretAt(0) }), 0, 'in the middle of the words ↓ is the box’s own');
    press('ArrowDown', { currentTarget: caretAt(5) }); assert.equal(body(), 'second'); press('ArrowDown', { currentTarget: caretAt(6) }); assert.equal(body(), 'third');
    press('ArrowDown', { currentTarget: caretAt(5) }); assert.equal(body(), 'my draft', 'past the newest: the draft that was not sent');
    assert.equal(press('ArrowDown', { currentTarget: caretAt(8) }), 0, 'and the walk is over');
    view.type('other'); press('ArrowUp', { currentTarget: caretAt(0) }); press('ArrowUp', { currentTarget: caretAt(0) }); view.type('edited'); press('ArrowUp', { currentTarget: caretAt(0) }); press('ArrowDown', { currentTarget: caretAt(5) });
    assert.equal(body(), 'edited', 'typing leaves the walk: the arrows start from the newest again, and the draft is what was typed');
    assert.equal(keyIn(view, 'ArrowUp', { currentTarget: caretAt(0), nativeEvent: { isComposing: true } }), 0, 'a composing input method gets its own keys');
  } finally { view.done(); }
});

test('what was sent here but is not echoed yet, and only the last 50, are in the history; with nothing sent ↑ stays the box’s own', async () => {
  const none = sessionView(idle, {});
  try { assert.equal(keyIn(none, 'ArrowUp'), 0, 'nothing sent'); } finally { none.done(); }
  const { sentTexts } = load('features/native-session/native-entries.ts'), many = Array.from({ length: 60 }, (_, index) => ({ role: 'user', text: `m${index}` }));
  assert.deepEqual(sentTexts(many, [{ text: 'pending' }]).slice(-2), ['m59', 'pending']); assert.equal(sentTexts(many, []).length, 50);
  assert.deepEqual(sentTexts([{ role: 'user', text: '' }, { role: 'assistant', text: 'reply' }, { role: 'user', text: ' hi ' }], []), ['hi'], 'pictures alone and replies are no words to bring back');
  const view = sessionView(idle, { send: async () => ({ ok: true, value: {} }) });
  try {
    view.type('sent now'); view.press(); await settle(); view.type('');
    assert.equal(keyIn(view, 'ArrowUp'), 1); assert.equal(view.box().props.value, 'sent now', 'a message still being sent is in the history');
  } finally { view.done(); }
});

test('the box is the reading view’s: its aria says what is open over it, the caret is followed for @, and the file panel stands in the composer', () => {
  const view = sessionView(idle, {});
  try {
    const box = view.box().props;
    assert.deepEqual([box['aria-expanded'], box['aria-controls'], box['aria-activedescendant']], [false, undefined, undefined]);
    assert.equal(typeof box.onSelect, 'function');
    assert.ok(elements(view.tree()).some(node => node.type === view.parts.MentionPalette));
  } finally { view.done(); }
});

const COMMANDS = [{ name: '/compact', description: 'Compact the conversation', source: 'builtin', view: 'reading' }, { name: '/review', description: 'Review', source: 'builtin', view: 'reading' },
  { name: '/security-review', description: 'Security review', source: 'skill', view: 'reading' }, { name: '/resume', description: 'Resume', source: 'builtin', view: 'reading' }, { name: '/fix-issue', description: 'Fix', source: 'project', view: 'reading' }];

test('"/" lists the session’s commands as the reading view does: the one named first, then those it begins, then those that contain it; ↑↓ choose and wrap, Tab completes, Esc closes', async () => {
  const reads = [], view = sessionView(idle, { commands: async (...args) => { reads.push(args); return { ok: true, value: COMMANDS }; } });
  try {
    await typeIn(view, 'hello'); assert.deepEqual([reads.length, listbox(view)], [0, undefined], 'nothing is read until a command is started');
    await typeIn(view, '/');
    assert.deepEqual(reads, [['t1', 'rs1']]); assert.deepEqual(optionNames(view), COMMANDS.map(command => command.name), 'the whole list for a bare /');
    const box = () => view.box().props;
    assert.deepEqual([box()['aria-expanded'], box()['aria-controls'], box()['aria-activedescendant']], [true, listbox(view).props.id, options(view)[0].props.id]);
    await typeIn(view, '/re');
    assert.deepEqual(optionNames(view), ['/review', '/resume', '/security-review'], 'prefix matches precede contained matches, case ignored');
    await typeIn(view, '/REVIEW'); assert.deepEqual(optionNames(view), ['/review', '/security-review'], 'the command named exactly comes first');
    await typeIn(view, '/re');
    const selected = () => options(view).findIndex(node => node.props['aria-selected']);
    assert.equal(selected(), 0); assert.equal(keyIn(view, 'ArrowDown'), 1); assert.equal(selected(), 1);
    keyIn(view, 'ArrowDown'); keyIn(view, 'ArrowDown'); assert.equal(selected(), 0, 'it wraps round'); keyIn(view, 'ArrowUp'); assert.equal(selected(), 2);
    assert.equal(box()['aria-activedescendant'], options(view)[2].props.id);
    assert.equal(keyIn(view, 'Tab'), 1); assert.equal(box().value, '/security-review ', 'Tab puts the chosen command in the box');
    assert.equal(listbox(view), undefined, 'and the list closes once a word follows');
    await typeIn(view, '/re'); options(view)[1].props.onClick(); assert.equal(view.box().props.value, '/resume ', 'a click chooses too');
    await typeIn(view, '/c'); assert.equal(keyIn(view, 'Escape'), 1); assert.equal(listbox(view), undefined, 'Esc closes the list and leaves the words');
    assert.equal(view.box().props.value, '/c'); await typeIn(view, '/co'); assert.ok(listbox(view), 'typing opens it again');
  } finally { view.done(); }
});

test('Enter completes a partial command and sends a whole one as a message; a command the list does not have is sent as a message too; Esc closes the list before it stops the agent', async () => {
  const sends = [], interrupts = [], view = sessionView(ev => [...idle(ev), ev('turn.started', { origin: 'user', clientMessageId: null })], {
    commands: async () => ({ ok: true, value: COMMANDS }), send: async (...args) => { sends.push(args); return { ok: true, value: {} }; }, interrupt: async (...args) => { interrupts.push(args); return { ok: true, value: {} }; } });
  try {
    await typeIn(view, '/rev'); assert.equal(keyIn(view, 'Enter'), 1);
    assert.deepEqual([view.box().props.value, sends.length], ['/review ', 0], 'Enter on a partial command only completes it');
    await typeIn(view, '/review'); assert.equal(keyIn(view, 'Enter'), 1); await settle();
    assert.deepEqual(sends.map(send => send[3]), ['/review'], 'a command written in full is sent, as text and to no terminal'); assert.equal(view.box().props.value, '');
    await typeIn(view, '/unknown-thing'); assert.equal(listbox(view), undefined, 'no match: no empty panel');
    keyIn(view, 'Enter'); await settle(); assert.deepEqual(sends.map(send => send[3]), ['/review', '/unknown-thing']);
    await typeIn(view, '/fix-issue 42'); assert.equal(listbox(view), undefined, 'a command with arguments has no list'); keyIn(view, 'Enter'); await settle();
    assert.equal(sends.at(-1)[3], '/fix-issue 42');
    await typeIn(view, '/c'); keyIn(view, 'Escape'); assert.deepEqual(interrupts, [], 'the first Esc closes the list');
    keyIn(view, 'Escape'); await settle(); assert.deepEqual(interrupts, [['t1', 'rs1']], 'the next stops the agent');
    view.type(''); const before = sends.length; keyIn(view, 'Enter'); await settle(); assert.equal(sends.length, before, 'an empty box sends nothing');
  } finally { view.done(); }
});

test('a command taken back from the history with ↑ opens no list and is sent as it is; typing it again does', async () => {
  const sends = [], view = sessionView(ev => [...idle(ev), userMessage(ev, 'c1', '/review')], { commands: async () => ({ ok: true, value: COMMANDS }), send: async (...args) => { sends.push(args); return { ok: true, value: {} }; } });
  try {
    keyIn(view, 'ArrowUp'); await settle(); assert.equal(view.box().props.value, '/review'); assert.equal(listbox(view), undefined, 'no list over a recalled command');
    assert.equal(keyIn(view, 'ArrowUp', { currentTarget: caretAt(0) }), 1, '↑ goes on through the history, not the list');
    keyIn(view, 'Enter'); await settle(); assert.deepEqual(sends.map(send => send[3]), ['/review']);
    await typeIn(view, '/review'); assert.ok(listbox(view), 'typed by hand it lists');
  } finally { view.done(); }
});

test('the command list is read when a command is started and again when the session state changes; a read that fails, a main without the call or no bridge leaves the box alone', async () => {
  let mode = 'ok', reads = 0;
  const view = sessionView(idle, { commands: async () => { reads++; if (mode === 'throw') throw new Error('boom'); return mode === 'ok' ? { ok: true, value: COMMANDS } : { ok: false, error: 'no' }; } });
  const running = () => [view.ev('session.state', { state: 'running', reason: null })];
  try {
    await typeIn(view, '/'); assert.deepEqual([reads, optionNames(view).length], [1, 5]);
    await typeIn(view, '/c'); assert.equal(reads, 1, 'typing on does not read again');
    view.show(running()); view.tree(); await settle(); assert.equal(reads, 2, 'a new state asks again');
    mode = 'throw'; view.show(idle(view.ev)); view.tree(); await settle(); assert.equal(reads, 3);
    assert.deepEqual(optionNames(view), ['/compact', '/security-review'], 'a failed read keeps what was known'); assert.equal(view.find(node => node.props?.role === 'alert'), undefined, 'and says nothing');
    mode = 'refused'; view.show(running()); view.tree(); await settle(); assert.equal(reads, 4); assert.equal(view.find(node => node.props?.role === 'alert'), undefined);
  } finally { view.done(); }
  const old = sessionView(idle, { send: async () => ({ ok: true, value: {} }) });
  try {
    await typeIn(old, '/'); assert.equal(listbox(old), undefined, 'a main without the call is an empty list: no panel'); assert.equal(old.box().props['aria-expanded'], false);
    await typeIn(old, '/help'); assert.equal(keyIn(old, 'Enter'), 1, 'and the command is a plain message');
  } finally { old.done(); }
  const rejected = sessionView(idle, { commands: async () => { throw new Error('ipc closed'); } });
  try { await typeIn(rejected, '/'); assert.equal(listbox(rejected), undefined); assert.equal(rejected.find(node => node.props?.role === 'alert'), undefined); } finally { rejected.done(); }
  const bare = sessionView(idle, null);
  try { await typeIn(bare, '/'); assert.equal(listbox(bare), undefined); } finally { bare.done(); }
});

test('while the box is shut (an ended session, a switch under way) no list and no file panel opens and nothing is read', async () => {
  let reads = 0, searched = 0;
  const ended = sessionView(ev => [ev('session.state', { state: 'stopped', reason: 'user' })], { commands: async () => { reads++; return { ok: true, value: COMMANDS }; } });
  globalThis.window.agentrix.findFiles = async () => { searched++; return { ok: true, value: [] }; };
  try {
    await typeIn(ended, '/'); ended.type('@s'); await sleep(120); await settle(); assert.deepEqual([reads, searched, listbox(ended)], [0, 0, undefined]);
  } finally { ended.done(); }
  const view = sessionView(idle, { commands: async () => { reads++; return { ok: true, value: COMMANDS }; } });
  try {
    await typeIn(view, '/'); assert.ok(listbox(view)); view.handoff.locked = true;
    assert.equal(listbox(view), undefined, 'a switch shuts the box and the list with it'); assert.equal(view.box().props.disabled, true);
  } finally { view.done(); }
});

test('"@" lists the project’s files as in the reading view: the panel follows the caret, Tab completes the file, Esc closes it, and a "/" command has none', async () => {
  const searches = [], view = sessionView(idle, {});
  globalThis.window.agentrix.findFiles = async (project, query) => { searches.push([project, query]); return { ok: true, value: [{ path: 'src/a.ts', kind: 'file' }, { path: 'src/lib', kind: 'dir' }] }; };
  try {
    const node = caretAt(3); view.tree(); view.box().props.ref.current = node;
    const mention = () => elements(view.tree()).find(element => element.type === view.parts.MentionPalette).props.mentions;
    view.type('@sr'); view.tree(); await sleep(150); view.tree();
    assert.deepEqual(searches, [['p1', 'sr']]); assert.deepEqual(mention().files.map(file => file.path), ['src/a.ts', 'src/lib']); assert.equal(mention().open, true);
    const box = () => view.box().props;
    assert.equal(box()['aria-expanded'], true); assert.equal(box()['aria-controls'], mention().listId);
    assert.equal(keyIn(view, 'ArrowDown'), 1); assert.equal(mention().selection, 1);
    assert.equal(keyIn(view, 'Escape'), 1); assert.equal(mention().open, false, 'Esc closes the file panel');
    node.selectionStart = node.selectionEnd = 4; await typeIn(view, '@src'); await sleep(150); view.tree();
    assert.equal(mention().open, true, 'a changed word opens it again'); keyIn(view, 'ArrowDown');
    assert.equal(keyIn(view, 'Tab'), 1); view.tree(); assert.equal(box().value, '@src/lib/', 'a folder keeps the token open to go on into it');
    view.type('/x'); node.selectionStart = node.selectionEnd = 2; view.tree(); await sleep(150); view.tree(); assert.equal(mention().open, false, 'a command has no file panel');
  } finally { view.done(); }
});

test('the working line says the step in hand, the result belongs to a round that has ended, and a waiting session says it waits', () => {
  const user = ev => ev('item.upsert', { kind: 'user-message', status: 'completed', content: { text: 'go', clientMessageId: 'c1' } }, { itemId: 'u1' });
  const view = sessionView(ev => [...idle(ev), ev('turn.started', { origin: 'user', clientMessageId: 'c1' }), user(ev), ev('item.upsert', { kind: 'command', status: 'in_progress', content: { command: 'npm test' } }, { itemId: 'k1' })], {});
  try {
    const working = view.decorations().status;
    assert.equal(working.type, view.parts.WorkingLine); assert.deepEqual([working.props.agent, working.props.label], ['claude', '正在command:npm test']);
    assert.equal(view.decorations().running, true); assert.equal(view.decorations().anchor, undefined, 'no result while it works');
    view.show([...idle(view.ev), view.ev('turn.started', { origin: 'user', clientMessageId: 'c1' }), user(view.ev)]);
    assert.equal(view.find(node => node.type === view.parts.WorkingLine).props.label, 'Claude Code 正在思考', 'no step: it is thinking, on a step of its own after your message');
    view.show([...idle(view.ev), user(view.ev), view.ev('item.upsert', { kind: 'agent-message', status: 'completed', content: { text: 'done' } }, { itemId: 'a1' }), view.ev('turn.completed', { status: 'completed', error: null })]);
    assert.deepEqual([view.decorations().status, view.decorations().anchor, view.feed().live], [null, 'a1', false], 'the round ended: the result stands on its reply');
    view.show([...idle(view.ev), view.ev('session.state', { state: 'waiting', reason: null })]);
    assert.equal(view.find(node => node.props?.className === 'reading-status is-waiting').props.role, 'status');
  } finally { view.done(); }
});

test('each pending request gets its card, for this session; a stopped session has none', () => {
  const view = sessionView(ev => [...idle(ev), ev('request.opened', { requestId: 'r1', kind: 'command', title: 'one' }), ev('request.opened', { requestId: 'r2', kind: 'file-change', title: 'two' })], {});
  try {
    const cards = elements(view.tree()).filter(node => node.props?.request);
    assert.deepEqual(cards.map(node => [node.props.request.id, node.props.terminalId, node.props.sessionId]), [['r1', 't1', 'rs1'], ['r2', 't1', 'rs1']]);
    view.show([...idle(view.ev), view.ev('request.opened', { requestId: 'r3', kind: 'command', title: 'x' }), view.ev('session.state', { state: 'stopped', reason: 'user' })]);
    assert.equal(elements(view.tree()).filter(node => node.props?.request).length, 0);
  } finally { view.done(); }
});

// ---- the request cards --------------------------------------------------------------------------------------------------------------
function cardView(request, bridge) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { agentrix: { nativeSession: bridge } } });
  const harness = hookHarness('src/features/native-session/NativeRequestCard.tsx', { '@phosphor-icons/react': new Proxy({}, { get: () => () => null }), './i18n': { t: fill } });
  const tree = () => deep(harness.render('NativeRequestCard', { request, terminalId: 't1', sessionId: 'rs1' }).result);
  const button = label => tree().find(node => node.type === 'button' && node.props.children === label), input = index => tree().filter(node => node.type === 'input')[index];
  return { tree, button, input, done() { harness.dispose(); if (previous) Object.defineProperty(globalThis, 'window', previous); else delete globalThis.window; } };
}
const request = (patch = {}) => ({ id: 'r1', kind: 'command', blocking: true, title: 'Run npm test', preview: 'npm test', questions: [], at: 1, ...patch });

test('a request is allowed once or denied by the owner’s click only, shut while the answer goes and open again with the reason when refused', async () => {
  const answers = [], results = [{ ok: true, value: {} }, { ok: false, error: 'already answered' }];
  const view = cardView(request(), { answer: async (...args) => { answers.push(args); return results.shift(); } });
  try {
    assert.equal(view.tree().find(node => node.type === 'pre').props.children, 'npm test');
    assert.equal(answers.length, 0, 'it waits: nothing is answered by itself');
    view.button('允许本次').props.onClick(); view.button('允许本次').props.onClick(); await settle();
    assert.deepEqual(answers, [['t1', 'rs1', 'r1', { decision: 'allow' }]], 'one click, one answer');
    assert.equal(view.button('拒绝').props.disabled, true, 'shut until the main process resolves it');
  } finally { view.done(); }
  const again = cardView(request(), { answer: async (...args) => { answers.push(args); return { ok: false, error: 'already answered' }; } });
  try {
    again.button('拒绝').props.onClick(); await settle();
    assert.deepEqual(answers.at(-1), ['t1', 'rs1', 'r1', { decision: 'deny' }]);
    assert.equal(again.tree().find(node => node.props?.role === 'alert').props.children, 'already answered');
    assert.equal(again.button('拒绝').props.disabled, false, 'and it can be answered again');
  } finally { again.done(); }
});

test('a question card says it has a question and shows only the question and its options: never the tool’s name or its raw input; the tool has no step of its own', () => {
  const questions = [{ id: 'q1', question: 'Which database?', options: [{ label: 'SQLite' }] }];
  const view = cardView(request({ id: 'r3', kind: 'question', title: 'AskUserQuestion', preview: '{"questions":[{"question":"Which database?"}]}', questions }), {});
  try {
    assert.equal(view.tree().find(node => node.type === 'strong').props.children, '它有问题要问你');
    assert.equal(view.tree().some(node => node.type === 'pre'), false, 'no raw input under the question');
  } finally { view.done(); }
  const { nativeEntries } = load('features/native-session/native-entries.ts'), { applyEvents, emptyModel } = load('features/native-session/native-model.ts'), ev = stream();
  const model = applyEvents(emptyModel(), [ev('item.upsert', { kind: 'tool', status: 'completed', content: { name: 'AskUserQuestion', input: '{"questions":[]}' } }, { itemId: 'q' }), ev('item.upsert', { kind: 'tool', status: 'completed', content: { name: 'Read', path: '/a' } }, { itemId: 'r' })]).model;
  assert.deepEqual(nativeEntries(model).map(entry => entry.id), ['r']);
});

test('questions are answered one by one with options, your own words or a secret, and the answer goes only once every question has one', async () => {
  const sent = [], questions = [
    { id: 'q1', question: 'Which database?', options: [{ label: 'SQLite', description: 'file based' }, { label: 'Postgres' }] },
    { id: 'q2', question: 'Which features?', multiSelect: true, options: [{ label: 'auth' }, { label: 'search' }] },
    { id: 'q3', question: 'API token?', isSecret: true },
  ];
  const view = cardView(request({ id: 'r2', kind: 'question', title: 'Questions', preview: '', questions }), { answer: async (...args) => { sent.push(args); return { ok: true, value: {} }; } });
  try {
    const radios = () => view.tree().filter(node => node.props?.role === 'radio'), boxes = () => view.tree().filter(node => node.props?.role === 'checkbox');
    assert.equal(view.button('提交回答').props.disabled, true, 'nothing answered yet');
    assert.equal(view.input(2).props.type, 'password', 'a secret is a password field');
    assert.equal(view.input(0).props.type, 'text');
    radios()[1].props.onClick(); boxes()[0].props.onClick(); boxes()[1].props.onClick(); boxes()[0].props.onClick();
    assert.deepEqual([radios()[1].props['aria-checked'], boxes().map(node => node.props['aria-checked'])], [true, [false, true]], 'a pick, and a multiple pick that can be undone');
    assert.equal(view.button('提交回答').props.disabled, true, 'the secret is still empty');
    view.input(2).props.onChange({ target: { value: 'tok-123' } });
    view.input(0).props.onChange({ target: { value: ' MySQL ' } });
    assert.equal(view.button('提交回答').props.disabled, false);
    view.button('提交回答').props.onClick(); await settle();
    assert.deepEqual(sent, [['t1', 'rs1', 'r2', { answers: { q1: 'MySQL', q2: ['search'], q3: 'tok-123' } }]], 'your own words win over a pick of a single question');
    sent.length = 0;
    const skip = cardView(request({ id: 'r3', kind: 'question', questions }), { answer: async (...args) => { sent.push(args); return { ok: true, value: {} }; } });
    try { skip.button('不回答').props.onClick(); await settle(); assert.deepEqual(sent, [['t1', 'rs1', 'r3', { decision: 'deny' }]], 'the owner can decline to answer'); } finally { skip.done(); }
  } finally { view.done(); }
});

// ---- the grid cell ------------------------------------------------------------------------------------------------------------------
function gridMarkup(terminals, { focused = false, native = [], moved = [], handoffs = [] } = {}) {
  const marker = (name, props) => React.createElement('div', { className: name, 'data-terminal': props.terminalId ?? props.id, 'data-phase': props.switchState?.phase ?? '', 'data-active': String(props.terminalActive ?? '') });
  const load = makeLoader({
    '../agents/SubagentPane': { SubagentPane: () => null }, '../agents/subagent-splits.ts': { closeSplit() {}, splitsOf: () => [], useSplits: () => [] },
    './AgentLauncher': { AgentLauncher: props => marker('launcher-stub', props) }, './TerminalPane': { TerminalPane: props => marker('pane-stub', props) }, '../reading/ReadingView': { ReadingView: () => null },
    '../reading/reading-mode': { readingShown: () => false, setReading() {}, syncReading() {}, useTerminalChoice: () => [] }, '../workspace/useProjectReorder': { TERMINAL_SPLITS: {}, useReorder: () => ({}) },
    '../native-session/NativeSessionView': { NativeSessionView: props => marker('native-stub', props) }, '../native-session/NativePathNote': { NativePathNote: props => marker('note-stub', props) },
    '../native-session/draft-handoff.ts': { useHandoff: (id, session, state) => { handoffs.push([id, session, state?.phase ?? null]); return {}; } },
    '../native-session/native-store.ts': { useNativeEntries: () => new Map(native.map(id => [id, { shown: true }])), nativeShown: entry => !!entry?.shown, ensureNativeSession() {} },
  });
  return renderToStaticMarkup(React.createElement(load('features/terminal/ProjectTerminals.tsx').ProjectTerminals, { project: { id: 'p', name: 'P', kind: 'local', terminals }, focused, fontSize: 13, activeId: null, setActiveId() {}, onExpand() { throw new Error('expanded'); }, onAction: async () => {}, onError() {}, onOpenLink() {} }));
}
const terminal = (id, patch = {}) => ({ id, title: id, sessionId: null, status: 'stopped', codexActive: false, readingHistory: null, agentStarting: false, needsInput: null, ...patch });

test('a native session takes the card’s cell where a terminal would, with no launcher; the terminal’s own view takes it back with the reason', () => {
  const small = gridMarkup([terminal('t1')], { native: ['t1'] });
  assert.match(small, /class="native-stub" data-terminal="t1"/); assert.doesNotMatch(small, /launcher-stub|pane-stub/); assert.match(small, /data-reading="true"/);
  assert.match(gridMarkup([terminal('t1')]), /launcher-stub/, 'without a session the launcher stays');
  const back = gridMarkup([terminal('t1', { sessionId: 's1', codexActive: true })], { native: ['t1'] });
  assert.match(back, /pane-stub/); assert.match(back, /class="note-stub" data-terminal="t1"/); assert.doesNotMatch(back, /native-stub/, 'a terminal that runs shows the terminal, not the old native view');
  const both = gridMarkup([terminal('t1'), terminal('t2')], { focused: true, native: ['t2'] });
  assert.deepEqual([(both.match(/native-stub/g) ?? []).length, (both.match(/launcher-stub/g) ?? []).length], [1, 1], 'an expanded project: the native split beside the one still to be started');
});

// ---- guards -------------------------------------------------------------------------------------------------------------------------
test('the native view writes to no terminal, never expands a project, and reaches the main process only through the bridge file', () => {
  const dir = path.join(src, 'features/native-session'), files = fs.readdirSync(dir).filter(file => /\.tsx?$/.test(file));
  const code = file => fs.readFileSync(path.join(dir, file), 'utf8').replace(/\/\/.*$/gm, '');
  const all = files.map(code).join('\n');
  assert.doesNotMatch(all, /writeTerminal|writeApproval|answerTerminal|startTerminal|closeTerminal|sendToAgent|readClipboard|onExpand|expandProject/, 'typing in a small card cannot expand it, and nothing types into a pty');
  assert.deepEqual(files.filter(file => /window\.agentrix/.test(code(file))), ['native-bridge.ts'], 'one file reads the bridge off window');
  assert.doesNotMatch(all, /console\.|localStorage|sessionStorage/, 'a secret answer is kept nowhere');
});

test('interventions have no planner relay sender or mounted renderer listener', () => {
  assert.equal(fs.existsSync(path.join(src, 'features/agents/parent-relay.ts')), false);
  const main = fs.readFileSync(path.join(src, '../electron/main.cjs'), 'utf8');
  assert.doesNotMatch(main, /sendParentPrompt|webContents\.send\('agents:relay'/);
  assert.doesNotMatch(fs.readFileSync(path.join(src, 'App.tsx'), 'utf8'), /startParentRelay/);
});

test('terminal fallback exposes unsent text for copying without submitting it or claiming delivery', async () => {
  const { applyEvents, emptyModel } = load('features/native-session/native-model.ts'), ev = stream();
  const text = 'keep this draft\n保留原文', copied = [], dismissed = [];
  const model = applyEvents(emptyModel(), [
    ev('item.upsert', { kind: 'user-message', status: 'completed', content: { text: 'already sent' } }, { itemId: 'old' }),
    ev('item.upsert', { kind: 'user-message', status: 'interrupted', content: { text, clientMessageId: 'draft', unsent: true } }, { itemId: 'draft' }),
    ev('input.receipt', { clientMessageId: 'draft', status: 'rejected' }),
    ev('path.changed', { previous: 'api', selected: 'terminal', reason: 'budget_exhausted' }),
  ]).model;
  const entry = { model, dismissed: null, noteDismissed: false, handoff: null };
  const harness = hookHarness('src/features/native-session/NativePathNote.tsx', {
    '@phosphor-icons/react': new Proxy({}, { get: () => () => null }), './i18n': { t: fill }, './native-session.css': {},
    './native-store.ts': { useNativeEntries: () => new Map([['t1', entry]]), terminalSwitch: load('features/native-session/native-store.ts').terminalSwitch, dismissNote: id => dismissed.push(id),
      resolveSwitch: load('features/native-session/native-store.ts').resolveSwitch, useSwitchNoteShown: () => true, dismissSwitchNote() {} },
    './native-words': words(), './native-bridge.ts': { copyNativeText: async value => { copied.push(value); return { ok: true }; } }, './SwitchNotice': load('features/native-session/SwitchNotice.tsx'),
  });
  try {
    const nodes = () => elements(harness.render('NativePathNote', { terminalId: 't1' }).result);
    const box = nodes().find(node => node.type === 'textarea');
    assert.equal(box.props.readOnly, true); assert.equal(box.props.value, text);
    assert.equal(nodes().filter(node => node.type === 'textarea').length, 1, 'sent messages are not recovery drafts');
    assert.equal(model.receipts.draft, 'rejected');
    nodes().find(node => node.type === 'button' && node.props.children === '复制未发送的消息').props.onClick(); await settle();
    assert.deepEqual(copied, [text]); assert.equal(model.receipts.draft, 'rejected', 'copying never changes delivery');
    nodes().find(node => node.type === 'button' && node.props.title === '知道了').props.onClick();
    assert.deepEqual(dismissed, ['t1']);
    entry.noteDismissed = true; assert.equal(harness.render('NativePathNote', { terminalId: 't1' }).result, null);
  } finally { harness.dispose(); }
});

// ---- the acceptance fixes -----------------------------------------------------------------------------------------------------------
test('the requests and the switch question stand at the end of the timeline on the agent’s own content edge, and a request grows in the conversation instead of scrolling inside its card', async () => {
  const html = await viewHtml(richSession), content = html.slice(html.indexOf('reading-content'), html.indexOf('class="reading-composer"'));
  assert.match(content, /<div class="native-tail">/); assert.ok(content.indexOf('reading-step is-agent') < content.indexOf('native-tail'), 'the request waits at the end of the conversation');
  assert.doesNotMatch(html, /reading-choice-host|native-summary|native-requests/, 'no host below the conversation whose card would scroll inside it');
  const css = fs.readFileSync(path.join(src, 'features/native-session/native-session.css'), 'utf8');
  assert.match(css, /\.native-tail \{[^}]*margin-left: var\(--reading-inset\);/, 'the same left edge as the reply text and the tool pills');
  assert.match(css, /\.native-tail \.native-request \{ max-height: none; overflow: visible; \}/, 'the base card’s 45vh cap and scrollbar are off');
  assert.doesNotMatch(await viewHtml(ev => [ev('session.state', { state: 'idle', reason: null })]), /native-tail/, 'nothing to show, no empty wrapper');
});

test('only what the reading view does not have stays in native-session.css', () => {
  const css = fs.readFileSync(path.join(src, 'features/native-session/native-session.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const classes = new Set(css.match(/\.native-[a-z-]+/g));
  assert.deepEqual([...classes].sort(), ['.native-ask', '.native-ended', '.native-error', '.native-path-note', '.native-path-summary', '.native-preview', '.native-request', '.native-switch', '.native-switch-question', '.native-switch-text', '.native-tail', '.native-unsent'].sort(),
    'no header, step, receipt, diff or plan style of its own');
});

test('a new request pulls the view to it even when the owner had scrolled up; an ordinary step does not', () => {
  const view = sessionView(idle, {});
  try {
    view.tree(); assert.equal(view.toBottom.length, 0);
    view.show([...idle(view.ev), view.ev('item.delta', { channel: 'text', text: 'one' }, { itemId: 'a1' })]); view.tree();
    assert.equal(view.toBottom.length, 0, 'an ordinary step is followed only by the reading view’s own stick-to-bottom');
    view.show([...idle(view.ev), view.ev('request.opened', { requestId: 'r1', kind: 'command', title: 'Run it' })]); view.tree();
    assert.equal(view.toBottom.length, 1, 'a request waiting for the owner is brought into view');
  } finally { view.done(); }
});

test('a command’s folder reads as its last two parts on one line with the whole path as the tooltip of the step’s line', async () => {
  const { shortPath } = words(), cwd = '/home/someone/work/very/long/path/to/the/project';
  assert.deepEqual([shortPath('/work'), shortPath('C:\\Users\\someone\\work\\very\\long\\path\\project\\sub'), shortPath(cwd)], ['/work', '…\\project\\sub', '…/the/project']);
  const html = await viewHtml(ev => [ev('session.state', { state: 'running', reason: null }), ev('item.upsert', { kind: 'command', status: 'in_progress', content: { command: 'npm test', cwd } }, { itemId: 'k' })]);
  assert.ok(html.includes('…/the/project')); assert.doesNotMatch(html.replace(/ title="[^"]*"/g, ''), /\/home\/someone/, 'the folder’s head is not drawn');
});

test('the message box always has a hint: the longest that fits, and the shortest when none does', async () => {
  try {
    fit.index = 0; assert.match(await viewHtml(ev => idle(ev)), /placeholder="给它发消息 · Enter 发送，Shift\+Enter 换行"/);
    fit.index = 9; assert.match(await viewHtml(ev => idle(ev)), /placeholder="发消息"/, 'a width that fits none of them still names the box');
  } finally { fit.index = 0; }
});

test('Codex falling back to the terminal leaves its reason where the native view stood, in words; the owner’s own choice of the terminal gives no reason to tell', async () => {
  const cases = [['codex_cli_required', '已改用终端 · 未找到 Codex 命令行，无法使用原生模式'], ['unsupported_codex_version', '已改用终端 · 这个 Codex 版本不支持原生模式'], ['some_new_code', '已改用终端'], [null, '已改用终端']];
  for (const [reason, words] of cases) {
    const ev = stream({ provider: 'codex', transport: 'codex-app-server' }), events = [ev('path.changed', { previous: null, selected: 'terminal', reason })];
    let html = '', shown = null;
    await withBridge({ onEvent: () => () => {}, snapshot: async () => ({ ok: true, value: { runtimeSessionId: 'rs1', lastSequence: 1, events } }) }, async store => {
      store.ensureNativeSession('t1'); await settle();
      shown = store.nativeShown(entriesOf(store).get('t1'));
      html = renderToStaticMarkup(React.createElement(load('features/native-session/NativePathNote.tsx').NativePathNote, { terminalId: 't1' }));
    });
    assert.equal(shown, false, 'the terminal’s own view takes the cell');
    assert.ok(html.includes(`<span>${words}</span>`), String(reason)); assert.doesNotMatch(html, /暂时不可用|some_new_code/, 'a reason nobody gave is not made up, and a code is not shown');
  }
});

// ---- the API usage card -------------------------------------------------------------------------------------------------------------
const words = () => load('features/native-session/native-words.ts');
const usageOf = (patch = {}) => ({
  month: '2026-11', apiRecords: true, todayUsdMicros: 1_230_000, monthUsdMicros: 12_400_000, estimated: true, budgetUsd: 50,
  agents: {
    claude: { path: 'api', reason: null, next: { path: 'api', reason: null }, connection: { kind: 'api', source: 'session init: ANTHROPIC_API_KEY', observedAt: 1 }, limits: { state: 'ready', limitsById: {}, ordinaryUsageAllowed: true } },
    codex: { path: 'native', reason: null, next: { path: 'native', reason: null }, connection: { kind: 'subscription', source: 'account/read: ChatGPT login', observedAt: 1 }, limits: { state: 'ready', ordinaryUsageAllowed: true, limitsById: { codex: { limitName: 'Codex', primary: { usedPercent: 40, windowDurationMins: 300, resetsAtMs: Date.now() + 3600_000 }, secondary: { usedPercent: 10, windowDurationMins: 10080, resetsAtMs: null } } } } },
  }, ...patch,
});

// The terminal in view when none runs an agent: no current agent, so no section has a context length or a round.
const quietTerminal = { id: 't1', agent: 'claude', codexActive: false, sessionId: null, agentUsage: null };
async function usageHtml(bridge, terminal = quietTerminal, projectId = 'p1') {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { agentrix: bridge ? { nativeSession: bridge } : {} } });
  const harness = hookHarness('src/features/agents/ApiUsage.tsx', { './i18n': { t: fill }, './native-store.ts': { useUsageRevision: () => 0 }, './native-words': words(), './Metric': load('features/agents/Metric.tsx'), './ResetQuota': { ResetQuota: () => null }, './native-billing-link.ts': load('features/native-session/native-billing-link.ts'), './activity-pane.css': {} });
  try {
    harness.render('ApiUsage', { terminal, projectId }); await sleep(30);
    return renderToStaticMarkup(harness.render('ApiUsage', { terminal, projectId }).result);
  } finally { harness.dispose(); if (previous) Object.defineProperty(globalThis, 'window', previous); else delete globalThis.window; }
}

// The connection row of a connection observed at 1 (usageOf and the tests' own): what it says, with its source and when it was observed in the tooltip.
const connectionRow = (source, text) => `<dt>连接</dt><dd><span title="${source} · ${load('features/agents/Metric.tsx').resetTime(1)} 更新">${text}</span></dd>`;
const usageSection = (html, agent) => {
  const section = html.match(new RegExp(`<section class="api-agent" aria-label="${agent}">([\\s\\S]*?)</section>`));
  assert.ok(section, `${agent} has its own named section`);
  return section[1];
};

test('Codex billing keeps ChatGPT subscriptions while legacy terminal snapshots require app-server restoration', async () => {
  const usage = async () => ({ ok: true, value: usageOf() });
  for (const sessionId of ['legacy-pty', null]) {
    const html = await usageHtml({ usage }, terminal('codex-billing', { agent: 'codex', codexActive: true, sessionId }));
    const codex = usageSection(html, 'Codex');
    assert.match(codex, /ChatGPT 订阅/);
    assert.doesNotMatch(codex, /<span>终端<\/span>/);
    assert.match(codex, sessionId ? /需用原生模式恢复/ : /<span>原生模式<\/span>/);
    assert.doesNotMatch(codex, /app-server|SDK/);
  }
});

test('the usage block groups Claude and Codex separately: only a connection row, spend and a set budget as a bar under an API connection, the subscription bars under a subscription, the last switch under its agent', async () => {
  const asked = [];
  const html = await usageHtml({ usage: async projectId => { asked.push(projectId); return { ok: true, value: usageOf() }; } });
  const claude = usageSection(html, 'Claude'), codex = usageSection(html, 'Codex');
  const labels = section => [...section.matchAll(/<dt>([^<]+)<\/dt>/g)].map(match => match[1]);
  assert.deepEqual(asked, ['p1'], 'the read is scoped to the project in view');
  assert.match(html, /<h3 class="activity-card-title">运行方式与额度<\/h3>/);
  assert.match(claude, /<h4[^>]*>Claude<\/h4>/); assert.match(codex, /<h4[^>]*>Codex<\/h4>/);
  assert.deepEqual(labels(claude), ['通道', '连接']); assert.deepEqual(labels(codex), ['通道', '连接']);
  assert.ok(claude.indexOf('<dt>通道</dt>') < claude.indexOf('<dt>连接</dt>'), '通道 precedes 连接');
  assert.ok(codex.includes('<dt>通道</dt><dd><span>原生模式</span></dd>'), 'who pays and which way it runs are told apart');
  assert.ok(claude.includes('<dt>通道</dt><dd><span>原生模式</span></dd>'));
  assert.doesNotMatch(html, /最近切换/, 'the owner asked for no last-switch row, even after a switch');
  assert.doesNotMatch(html, /新会话/, 'the new-session row is gone, and so is the route it showed');
  assert.ok(claude.includes(connectionRow('session init: ANTHROPIC_API_KEY', '已连接 API')), 'the connection source stays in its tooltip, with when it was observed');
  assert.ok(codex.includes(connectionRow('account/read: ChatGPT login', 'ChatGPT 订阅')));
  // An API connection: the budget as a bar (a share of the month's spend) and the spend, never the subscription windows.
  assert.match(claude, /<span class="activity-metric-label">月预算<\/span><span class="activity-meter[^"]*" role="meter"[^>]*aria-valuenow="25"[^>]*>[\s\S]*?<b>25%<\/b><small>本月 \$12\.40 \/ \$50\.00<\/small>/);
  assert.doesNotMatch(claude, /API 花费|今日|估算|在控制台核对/, 'the spend row and the standalone console button are not shown');
  assert.doesNotMatch(claude, /5 小时额度|每周额度|额度来自/);
  // A subscription: the two windows as the same bars, never spend or a budget.
  assert.match(codex, /<span class="activity-metric-label">5 小时额度<\/span>[\s\S]*?aria-valuenow="40"[\s\S]*?<b[^>]*>40%<\/b><small>[^<]+ 重置<\/small>/);
  assert.match(codex, /<span class="activity-metric-label">每周额度<\/span>[\s\S]*?aria-valuenow="10"[\s\S]*?<b[^>]*>10%<\/b>/);
  assert.doesNotMatch(codex, /API 花费|月预算|最近切换/);
});

test('the usage block says 未知 for what nobody gave and keeps a real zero as $0.00', async () => {
  // Connection not known (an older main, or nothing running): the connection and the allowance both say so, and nothing is measured.
  const unknown = await usageHtml({ usage: async () => ({ ok: true, value: usageOf({ todayUsdMicros: 0, monthUsdMicros: null, budgetUsd: null, agents: {
    claude: { path: null, reason: null, next: { path: null, reason: null }, limits: null }, codex: { path: 'terminal', reason: null, limits: { state: 'rate_limited' } } } }) }) });
  for (const agent of ['Claude', 'Codex']) {
    const section = usageSection(unknown, agent);
    assert.match(section, /<dt>连接<\/dt><dd><span>未知<\/span><\/dd>/);
    assert.match(section, /<dt>额度<\/dt><dd><span>未知<\/span><\/dd>/, 'not connected or not known: 额度 未知');
    assert.doesNotMatch(section, /activity-metrics|role="meter"|API 花费|月预算|5 小时额度/);
  }
  assert.doesNotMatch(unknown, /最近切换|还没有切换过|新会话/);
  // An API connection: a real zero is $0.00; a missing amount is 未知; a budget with no known spend has no share and no bar; no budget says 未设置.
  const api = patch => usageHtml({ usage: async () => ({ ok: true, value: usageOf({ ...patch }) }) });
  const none = await api({ todayUsdMicros: 0, monthUsdMicros: null, budgetUsd: null });
  assert.doesNotMatch(none, /今日|估算/); assert.match(none, /<span class="activity-metric-label">月预算<\/span><small>未设置<\/small>/); assert.doesNotMatch(usageSection(none, 'Claude'), /role="meter"/);
  const noShare = await api({ monthUsdMicros: null });
  assert.match(noShare, /<span class="activity-metric-label">月预算<\/span><b[^>]*>未知<\/b><small>本月 未知 \/ \$50\.00<\/small>/); assert.doesNotMatch(usageSection(noShare, 'Claude'), /role="meter"/, 'no spend, no share, no bar');
  assert.doesNotMatch(await api({ todayUsdMicros: null, monthUsdMicros: null }), /今日|估算|API 花费/, 'no spend row, whatever the amounts');
  // The warning colour only from 90%.
  assert.doesNotMatch(usageSection(await api({ monthUsdMicros: 44_000_000 }), 'Claude'), /is-warn/); assert.match(await api({ monthUsdMicros: 45_000_000 }), /activity-metric is-warn activity-figure/);
  // A rate-limited subscription with no window says so rather than a number.
  const limited = usageOf({  }); limited.agents.codex.limits = { state: 'rate_limited', limitsById: {} };
  assert.match(usageSection(await usageHtml({ usage: async () => ({ ok: true, value: limited }) }), 'Codex'), /<small>已限流，恢复时间未知<\/small>/);
});

test('the usage block distinguishes no API records from records with unknown or zero spend, and Codex on the API has none to show', async () => {
  const html = await usageHtml({ usage: async () => ({ ok: true, value: usageOf({ apiRecords: false, todayUsdMicros: null, monthUsdMicros: null, budgetUsd: null }) }) });
  assert.doesNotMatch(usageSection(html, 'Claude'), /API 花费|API 用量记录|估算|今日|本月|role="meter"|最近切换/);
  assert.doesNotMatch(usageSection(html, 'Codex'), /API 用量记录/);
  // Codex through the API: the same words and no budget (there is no spend record to measure one against).
  const codexApi = usageOf({  }); codexApi.agents.codex.connection = { kind: 'api', source: 'account/read: API key', observedAt: 1 };
  const codex = usageSection(await usageHtml({ usage: async () => ({ ok: true, value: codexApi }) }), 'Codex');
  assert.doesNotMatch(codex, /API 花费|API 用量记录|月预算|5 小时额度|每周额度|role="meter"/);
});

test('the allowance of each agent follows its connection: the current session’s agent leads with the context and ends with the round, windows come from main with the session’s own as fallback', async () => {
  const future = Date.now() + 3600_000, tokens = { input: 496000, cached: 476000, output: 5100 };
  const current = (agent, extra = {}) => ({ id: 't1', agent, codexActive: true, sessionId: 's1', agentStartedAt: 1, agentUsage: { provider: null, limits: [], context: { used: 170000, window: 1000000 }, round: tokens, total: null, ...extra } });
  const usage = usageOf({ budgetUsd: null }), sub = { kind: 'subscription', source: null, observedAt: 1 };
  usage.agents.claude = { ...usage.agents.claude, connection: sub, limits: null };
  // The session's agent without windows from main falls back to what its own records gave; the other agent has neither context nor round.
  const fallback = await usageHtml({ usage: async () => ({ ok: true, value: usage }) }, current('claude', { limits: [{ minutes: 300, percent: 20, resetsAt: future }, { minutes: 10080, percent: 26, resetsAt: future }], limitsAt: Date.now(), limitsFrom: 'Claude Code' }));
  const claude = usageSection(fallback, 'Claude'), codex = usageSection(fallback, 'Codex');
  const order = ['上下文长度', '5 小时额度', '每周额度', '>本轮<', '额度来自 Claude Code'].map(text => claude.indexOf(text));
  assert.ok(order.every((position, i) => position >= 0 && (!i || position > order[i - 1])), 'context, the two windows, the round, then where the numbers come from');
  assert.match(claude, /aria-valuenow="20"/); assert.match(claude, /aria-valuenow="26"/); assert.match(claude, /aria-valuenow="17"/);
  assert.doesNotMatch(claude, /API 花费|月预算/, 'a subscription has no spend or budget');
  assert.doesNotMatch(codex, /上下文长度|>本轮<|>本次对话</, 'the other agent has no context or round');
  assert.match(codex, /5 小时额度/);
  // Windows from main come first: the session's own numbers do not replace them.
  const main = usageOf({  }); main.agents.claude = { ...main.agents.claude, connection: sub, limits: { state: 'ready', observedAtMs: Date.now(), limitsById: { five: { primary: { usedPercent: 33, windowDurationMins: 300, resetsAtMs: future }, secondary: null } } } };
  const preferred = usageSection(await usageHtml({ usage: async () => ({ ok: true, value: main }) }, current('claude', { limits: [{ minutes: 300, percent: 20, resetsAt: future }] })), 'Claude');
  assert.match(preferred, /aria-valuenow="33"/); assert.doesNotMatch(preferred, /aria-valuenow="20"/); assert.match(preferred, /额度来自 Claude，/);
  // A window nobody measured says 未知 (never 0), and one past its reset time keeps the percent last observed while it waits for its next reading.
  const odd = usageOf({  }); odd.agents.codex.limits = { state: 'stale', limitsById: { a: { primary: { usedPercent: null, windowDurationMins: 300, resetsAtMs: null }, secondary: { usedPercent: 50, windowDurationMins: 10080, resetsAtMs: Date.now() - 1000 } } } };
  const staleHtml = usageSection(await usageHtml({ usage: async () => ({ ok: true, value: odd }) }), 'Codex');
  assert.match(staleHtml, /<span class="activity-metric-label">5 小时额度<\/span><b[^>]*>未知<\/b>/); assert.doesNotMatch(staleHtml, /<b[^>]*>0%<\/b>/);
  assert.match(staleHtml, /<span class="activity-metric-label">每周额度<\/span><span class="activity-meter" role="meter"[^>]*aria-valuenow="50"[^>]*>[\s\S]*?<b[^>]*>50%<\/b><small>已到重置时间，等待更新<\/small>/);
  assert.doesNotMatch(staleHtml, /已重置，等待更新/, 'a reset time alone is no reset'); assert.match(staleHtml, /数据可能已过期/);
  // Not connected: the connection and 额度 未知 and nothing to measure, even for the session's own agent.
  const idle = usageOf({  }); idle.agents.codex = { ...idle.agents.codex, connection: { kind: 'none', source: null, observedAt: 1 }, limits: null };
  const none = usageSection(await usageHtml({ usage: async () => ({ ok: true, value: idle }) }), 'Codex');
  assert.match(none, /<dt>连接<\/dt><dd><span[^>]*>未连接<\/span><\/dd>/); assert.match(none, /<dt>额度<\/dt><dd><span>未知<\/span><\/dd>/); assert.doesNotMatch(none, /role="meter"|5 小时额度/);
  assert.equal(words().nextPathWord, undefined, 'the route of the next session is not drawn any more, so its words are gone');
});

test('the connection in use reads in words per agent: Claude API / subscription / not connected, Codex ChatGPT subscription / API, and unknown as 未知', async () => {
  const { connectionWord } = words(), c = (kind, source = null) => ({ kind, source, observedAt: 1 });
  const kinds = ['api', 'subscription', 'none', 'unknown'];
  assert.deepEqual(kinds.map(kind => connectionWord('claude', c(kind)).text), ['已连接 API', '订阅（Claude Code 登录）', '未连接', '未知']);
  assert.deepEqual(kinds.map(kind => connectionWord('codex', c(kind)).text), ['API', 'ChatGPT 订阅', '未连接', '未知']);
  assert.deepEqual([connectionWord('claude', undefined), connectionWord('codex', null), connectionWord('claude', c('api', 'init'))], [{ text: '未知', source: null }, { text: '未知', source: null }, { text: '已连接 API', source: 'init' }]);
  const html = await usageHtml({ usage: async () => ({ ok: true, value: usageOf({ agents: {
    claude: { path: 'terminal', reason: null, next: { path: 'terminal', reason: 'set_terminal' }, limits: null, connection: c('subscription', 'terminal: Claude Code login') },
    codex: { path: 'terminal', reason: null, next: { path: 'terminal', reason: 'set_terminal' }, limits: null, connection: c('api', 'account/read: API key') } } }) }) });
  assert.ok(usageSection(html, 'Claude').includes(connectionRow('terminal: Claude Code login', '订阅（Claude Code 登录）')));
  assert.ok(usageSection(html, 'Codex').includes(connectionRow('account/read: API key', 'API')));
});

test('an account signed in while the agent has no main session names its plan and never claims 已连接; none and unknown never read as signed in; the bars and spend stay, the context and tokens are not made up', async () => {
  const { connectionWord } = words(), c = (kind, active) => ({ kind, source: 'src', observedAt: 1, ...(active === undefined ? {} : { active }) });
  const kinds = ['api', 'subscription', 'none', 'unknown'];
  assert.deepEqual(kinds.map(kind => connectionWord('claude', c(kind, false)).text), ['API', '订阅（Claude Code 登录）', '未连接', '未知']);
  assert.deepEqual(kinds.map(kind => connectionWord('codex', c(kind, false)).text), ['API', 'ChatGPT 订阅', '未连接', '未知']);
  assert.deepEqual(kinds.map(kind => connectionWord('claude', c(kind, true)).text), ['已连接 API', '订阅（Claude Code 登录）', '未连接', '未知'], 'an active connection reads as before');
  assert.deepEqual(kinds.map(kind => connectionWord('codex', c(kind)).text), ['API', 'ChatGPT 订阅', '未连接', '未知'], 'a field that is missing (older data) reads as before');
  const base = usageOf(), idle = usageOf({ agents: {
    claude: { ...base.agents.claude, connection: c('api', false) },
    codex: { ...base.agents.codex, connection: c('subscription', false), limits: { ...base.agents.codex.limits, observedAtMs: Date.now() - 60_000 } } } });
  const html = await usageHtml({ usage: async () => ({ ok: true, value: idle }) }), claude = usageSection(html, 'Claude'), codex = usageSection(html, 'Codex');
  assert.match(claude, /<dd><span[^>]*>API<\/span><\/dd>/); assert.match(codex, /<dd><span[^>]*>ChatGPT 订阅<\/span><\/dd>/);
  assert.doesNotMatch(html, /未开会话/, 'a sub-agent may be running on this account, so no session is not something the pane can say');
  assert.match(codex, /5 小时额度[\s\S]*?aria-valuenow="40"/); assert.match(codex, /每周额度/); assert.match(codex, /额度来自 Codex/);
  assert.match(claude, /月预算/); assert.doesNotMatch(claude, /API 花费/);
  assert.doesNotMatch(html, /上下文长度|本轮|本次对话|<dt>额度<\/dt>/, 'no session: no context, no round, no empty row');
  const signed = { ...base.agents.codex, connection: c('api', false) }, codexApi = usageSection(await usageHtml({ usage: async () => ({ ok: true, value: usageOf({ agents: { ...base.agents, codex: signed } }) }) }), 'Codex');
  assert.doesNotMatch(codexApi, /API 用量记录|API 花费|activity-metrics/);
});

test('a connection test reads as four lines, each with a tone and a next step for what failed, and nothing in it can carry the key', () => {
  const { connectionLines } = words(), required = '2.1.317';
  const good = { checkedAt: 1, key: { status: 'ok', detail: null, latencyMs: 182.4 }, models: ['claude-opus-5-5', 'a', 'b', 'c', 'd', 'e', 'f'], cli: { status: 'ok', version: '2.1.317', required }, path: 'api', reason: null };
  const lines = connectionLines(good);
  assert.deepEqual(lines.map(line => [line.id, line.tone, line.label, line.text, line.hint]), [
    ['key', 'ok', '密钥', '有效 · 182 ms', null], ['models', 'ok', '可用模型', 'claude-opus-5-5、a、b、c、d 等 7 个', null],
    ['cli', 'ok', 'Claude Code', '版本 2.1.317（满足 ≥ 2.1.317）', null], ['path', 'ok', '新会话将使用', 'API', null]]);
  const bad = connectionLines({ ...good, key: { status: 'invalid', detail: 'The key was refused.', latencyMs: 40 }, models: null, cli: { status: 'too_old', version: '2.0.0', required }, path: 'terminal', reason: 'no_key' });
  assert.deepEqual(bad.map(line => [line.id, line.tone, line.text]), [['key', 'bad', '无效'], ['models', 'warn', '未知'], ['cli', 'bad', '版本 2.0.0 过低（需要 ≥ 2.1.317）'], ['path', 'ok', '终端（订阅） · 还没有保存 API key']]);
  assert.match(bad[0].hint, /检查密钥/); assert.equal(bad[0].title, 'The key was refused.'); assert.equal(bad[2].hint, '请升级 Claude Code。');
  const hint = (status, detail = null) => connectionLines({ ...good, key: { status, detail, latencyMs: null } })[0];
  assert.deepEqual(['missing', 'forbidden', 'rate_limited', 'unreachable', 'error'].map(status => [hint(status).tone, hint(status).hint !== null]), [['bad', true], ['bad', true], ['warn', true], ['bad', true], ['bad', true]]);
  assert.match(hint('forbidden').hint, /权限/); assert.match(hint('unreachable').hint, /网络/); assert.match(hint('error', 'boom').hint, /boom/);
  assert.equal(hint('rate_limited').text, '被限流', 'a failed check shows no latency');
  const odd = connectionLines({ ...good, models: [], cli: { status: 'missing', version: null, required }, path: null });
  assert.deepEqual(odd.map(line => [line.tone, line.text]), [['ok', '有效 · 182 ms'], ['warn', '没有可用模型'], ['bad', '未找到'], ['warn', '未知']]);
  assert.match(odd[2].hint, /请安装 Claude Code（需要 ≥ 2\.1\.317）/);
  // Anthropic's own reason follows the refusal; a key that may not list models but answered the token count reads as working.
  const refused = connectionLines({ ...good, key: { status: 'forbidden', detail: 'x', latencyMs: 1, error: 'permission_error: key is disabled' }, models: null })[0];
  assert.equal(refused.text, '无权限'); assert.match(refused.hint, /检查网络和代理（所在地区可能不受支持）。 Anthropic：permission_error: key is disabled$/);
  const unlisted = connectionLines({ ...good, models: null, modelsForbidden: true, modelsError: 'permission_error: no list' });
  assert.deepEqual([unlisted[0].tone, unlisted[1].tone, unlisted[1].text], ['ok', 'warn', '无列表权限']);
  assert.equal(unlisted[1].hint, '这个密钥不能读取模型列表，但能正常通过验证。 Anthropic：permission_error: no list');
  assert.equal(connectionLines({ ...good, models: null, modelsForbidden: true, modelsError: null, unavailableModel: 'claude-x-1' })[1].hint,
    '这个密钥不能读取模型列表，但能正常通过验证。 模型 claude-x-1 对这个密钥不可用。');
  // A CLI that was found but failed its check says how, with the file, instead of 未找到.
  const file = 'C:\\Users\\u\\.local\\bin\\claude.exe', cliLine = cli => connectionLines({ ...good, cli: { status: 'missing', version: null, required, ...cli } })[2];
  assert.deepEqual([cliLine({ reason: 'timeout', found: file }).text, cliLine({ reason: 'timeout', found: file }).title], ['检查失败', file]);
  assert.equal(cliLine({ reason: 'timeout', found: file }).hint, `找到 ${file}，但运行 claude --version 超时，请稍后重试。`);
  assert.equal(cliLine({ reason: 'timeout', found: file, elapsedMs: 11500 }).hint, `找到 ${file}，但运行 claude --version 12 秒后仍没有结束，请稍后重试。`);
  assert.equal(cliLine({ reason: 'failed', found: file, error: 'EPERM' }).hint, `找到 ${file}，但无法运行它（EPERM）。 请重新安装 Claude Code，或检查安全软件是否拦截。`);
  assert.equal(cliLine({ reason: 'failed', found: file }).hint, `找到 ${file}，但无法运行它。 请重新安装 Claude Code，或检查安全软件是否拦截。`);
  assert.equal(cliLine({ reason: 'unreadable', found: file }).hint, `找到 ${file}，但它没有输出版本号。 请重新安装 Claude Code，或检查安全软件是否拦截。`);
  assert.equal(cliLine({ reason: 'failed' }).hint, '检查 Claude Code 时出错，请重试。');
  assert.deepEqual([cliLine({ reason: 'not_found' }).text, cliLine({ reason: 'not_found' }).title], ['未找到', null]);
  // None found says where main looked; an npm package without its native program says why and how to install the native one.
  const searched = ['~\\.local\\bin', '~\\.claude\\local', '~\\AppData\\Local\\Microsoft\\WinGet\\Links'];
  assert.equal(cliLine({ reason: 'not_found', pathFolders: 14, searched }).hint,
    '请安装 Claude Code（需要 ≥ 2.1.317）。 已查找 PATH 里的 14 个目录，以及 ~\\.local\\bin、~\\.claude\\local、~\\AppData\\Local\\Microsoft\\WinGet\\Links。');
  assert.equal(cliLine({ reason: 'not_found', searched: ['~/.local/bin'] }).hint, '请安装 Claude Code（需要 ≥ 2.1.317）。 已查找 ~/.local/bin。');
  const incomplete = 'D:\\nodejs22\\node_modules\\@anthropic-ai\\claude-code', npm = cliLine({ reason: 'not_found', pathFolders: 14, searched, incomplete });
  assert.deepEqual([npm.text, npm.title, npm.tone], ['安装不完整', incomplete, 'bad']);
  assert.equal(npm.hint, `找到用 npm 安装的 Claude Code（${incomplete}），但里面没有原生程序：npm 跳过了它的安装步骤（npm 12 默认跳过，--ignore-scripts 或 --omit=optional 也会）。请改用官方安装器安装原生版：在 PowerShell 运行 irm https://claude.ai/install.ps1 | iex，装好后重新测试连接。`);
  assert.match(cliLine({ reason: 'not_found', incomplete: '~/.npm-global/lib/node_modules/@anthropic-ai/claude-code' }).hint, /在终端运行 curl -fsSL https:\/\/claude\.ai\/install\.sh \| bash，/);
  assert.equal(connectionLines({ ...good, cli: { status: 'missing', version: null, required, reason: 'failed' }, path: 'terminal', reason: 'native_cli_unverified' })[3].text,
    '终端（订阅） · Claude Code 检查没有通过，无法通过 API 运行');
  assert.doesNotMatch(JSON.stringify([lines, bad, odd]), /sk-ant/);
});

test('when main gives no usage (a read that failed or has not come back, a project it cannot answer for, no bridge) the current session’s context, bars and tokens stay, and the connection and the allowance read 未知', async () => {
  const future = Date.now() + 3600_000, round = { input: 496000, cached: 476000, output: 5100 };
  const session = { id: 't1', agent: 'claude', codexActive: true, sessionId: null, agentStartedAt: 1, agentUsage: { provider: null, limits: [{ minutes: 300, percent: 20, resetsAt: future }], limitsAt: Date.now(), limitsFrom: 'Claude Code', context: { used: 170000, window: 1000000 }, round, total: null } };
  for (const bridge of [{ usage: async () => ({ ok: false, error: 'native sessions are local only' }) }, { usage: async () => new Promise(() => {}) }, null]) {
    const html = await usageHtml(bridge, session), claude = usageSection(html, 'Claude'), codex = usageSection(html, 'Codex');
    assert.match(claude, /上下文长度/); assert.match(claude, /aria-valuenow="17"/); assert.match(claude, /5 小时额度/); assert.match(claude, />本轮</, 'its context, bar and round are the session’s own');
    assert.match(claude, /连接<\/dt><dd><span>未知<\/span>/); assert.doesNotMatch(codex, /上下文长度|>本轮</); assert.match(codex, /连接<\/dt><dd><span>未知<\/span>/);
    assert.equal((html.match(/role="alert"/g) ?? []).length, bridge?.usage.toString().includes('local only') ? 1 : 0, 'an error is one line, not the whole block');
  }
  assert.match(await usageHtml({ usage: async () => ({ ok: false, error: 'locked' }) }), /role="alert">无法读取额度：locked/, 'a failed read says so');
  assert.equal(await usageHtml(null), '', 'a window without the bridge and without a session shows no card');
  assert.match(await usageHtml(null, { ...session, agentUsage: null }), /上下文长度/, 'a session that has not answered yet says its context comes with the first reply');
});

test('a failed read says so, a window without the bridge shows no card, and limits read as their provider gave them', async () => {
  assert.match(await usageHtml({ usage: async () => ({ ok: false, error: 'locked' }) }), /role="alert">无法读取额度：locked/);
  assert.equal(await usageHtml(null), '');
  const { limitLines } = load('features/agents/ApiUsage.tsx'), soon = Date.now() + 3600_000;
  assert.match(limitLines({ state: 'rate_limited', limitsById: { api: { primary: { usedPercent: 100, windowDurationMins: 60, resetsAtMs: soon } } } })[0], /^已限流，约 .+ 恢复$/);
  assert.deepEqual(limitLines({ ordinaryUsageAllowed: false }), ['已限流，恢复时间未知']);
  assert.deepEqual(limitLines({ state: 'unavailable' }), ['暂时读不到']);
  assert.deepEqual(limitLines(null), ['未知']);
  assert.deepEqual(limitLines({ state: 'stale', limitsById: { a: { primary: { usedPercent: 5, windowDurationMins: 60, resetsAtMs: null } } } }), ['1 小时 · 已用 5% · 未知 重置', '数据可能已过期']);
});

// ---- the run-mode switch (r12) -------------------------------------------------------------------------------------------------------
const switchState = (patch = {}) => ({ changeId: 3, current: 'api', target: 'terminal', phase: 'waiting-turn', background: { count: null, known: false }, requestId: null, reason: null, ...patch });

test('switch words: the header says where a change goes and when, a failure says the session stayed, and an unknown background count is never a number', () => {
  const words = load('features/native-session/native-words.ts'), line = patch => words.switchLine(switchState(patch));
  assert.equal(line(), '本轮结束后切到 终端');
  assert.equal(line({ target: 'native' }), '本轮结束后切到 原生模式'); assert.equal(line({ target: 'api' }), '本轮结束后切到 API');
  assert.equal(line({ reason: '输入框里有未发送的文字' }), '输入框里有未发送的文字', 'a reason from main is the line');
  assert.equal(line({ phase: 'waiting-background' }), '等后台任务结束后再切到 终端');
  assert.deepEqual(['preparing', 'switching'].map(phase => line({ phase })), ['正在切到 终端', '正在切到 终端']);
  assert.deepEqual(['stable', 'awaiting-choice', 'rolling-back'].map(phase => line({ phase })), [null, null, null], 'nothing under way, the question has its card and a failure its note');
  assert.equal(words.switchLine(null), null);
  const failure = patch => words.switchNote(switchState({ phase: 'rolling-back', ...patch }));
  assert.equal(failure(), '没有切换成功，仍使用 API'); assert.equal(failure({ reason: 'native_cli_required' }), '没有切换成功，仍使用 API · 未找到原生 Claude Code，无法通过 API 运行');
  const settled = patch => words.switchNote(switchState({ phase: 'stable', ...patch }));
  assert.equal(settled({ outcome: 'failed', reason: '终端没有启动' }), '没有切换成功，仍使用 API · 终端没有启动', 'only the outcome failed says the switch failed');
  assert.equal(settled({ reason: '终端没有启动' }), null, 'a reason alone is not a failure: an ended change that gives no outcome says nothing');
  const kept = '运行方式切换失败，已保留原会话。';
  assert.equal(settled({ outcome: 'failed', reason: kept, cause: 'terminal_agent_exited' }), `没有切换成功，仍使用 API · ${kept} · Claude Code 在终端里启动后就退出了`, 'a cause we know is told in words after the reason');
  assert.equal(settled({ outcome: 'failed', reason: kept, cause: 'ENOENT' }), `没有切换成功，仍使用 API · ${kept} · ENOENT`, 'one we do not know is shown as it is, so the failure can be told apart');
  assert.equal(settled({ outcome: 'switched', reason: '旧进程没有正常退出', cause: 'ENOENT' }), '旧进程没有正常退出', 'only a failure tells a cause');
  assert.equal(settled({ outcome: 'switched', reason: '旧进程没有正常退出' }), '旧进程没有正常退出', 'switched with a reason is a switch that worked, told as the warning it is');
  assert.deepEqual([settled({ outcome: 'switched' }), settled({ outcome: 'restored' }), settled({ outcome: 'stopped' })], [null, null, null], 'no reason, nothing to tell');
  assert.deepEqual([settled({ outcome: 'restored', reason: '已恢复到原来的会话' }), settled({ outcome: 'stopped', reason: '会话已停止，没有切换' })], ['已恢复到原来的会话', '会话已停止，没有切换'], 'a restore or a stop says its reason, not that it failed');
  assert.doesNotMatch(String(settled({ outcome: 'switched', reason: 'native_cli_required' })), /没有切换成功/);
  assert.deepEqual([failure({ phase: 'waiting-turn', reason: '输入框里有未发送的文字' }), words.switchNote(switchState({ phase: 'waiting-turn', outcome: 'failed', reason: 'x' })), words.switchNote(null)], [null, null, null], 'a change still waiting is not an ended one');
  const background = (count, known) => words.backgroundWords({ count, known });
  assert.equal(background(2, true), '切换会结束 2 个后台任务。'); assert.equal(background(0, true), '切换会结束 0 个后台任务。', 'a real zero is a zero');
  for (const unknown of [background(null, false), background(3, false), background(null, true)]) { assert.match(unknown, /还不知道/); assert.doesNotMatch(unknown, /\d/, 'unknown is not a number'); }
});

test('resolveSwitch: ProjectTerminal’s state and the event stream’s are one state; the newer change wins, then the later phase, and a finished session has none', () => {
  const { resolveSwitch } = load('features/native-session/native-store.ts'), entry = (state, session = { state: 'running', reason: null }) => ({ model: { switchState: state, session } });
  const a = switchState({ phase: 'waiting-turn' }), b = switchState({ phase: 'preparing' }), later = switchState({ changeId: 4, phase: 'waiting-turn' });
  assert.deepEqual([resolveSwitch(null, undefined), resolveSwitch(a, undefined), resolveSwitch(undefined, entry(b)), resolveSwitch(null, entry(null))], [null, a, b, null]);
  assert.equal(resolveSwitch(a, entry(b)), b, 'inside one change the later phase is the newer copy, from either side');
  assert.equal(resolveSwitch(b, entry(a)), b);
  assert.equal(resolveSwitch(later, entry(switchState({ phase: 'switching' }))), later, 'a newer change beats an older change’s later phase');
  assert.equal(resolveSwitch(a, entry(later)), later);
  assert.equal(resolveSwitch(null, entry(b, { state: 'stopped', reason: 'user' })), null, 'a finished session is not on its way anywhere');
});

test('the store folds switch.updated and a snapshot’s switch state into the entry, a settled change asks again for its draft, and a draft is taken once', async () => {
  const ev = stream(), waiting = switchState(), prepare = switchState({ phase: 'preparing' }), stable = switchState({ phase: 'stable' });
  const first = [ev('session.state', { state: 'idle' }), ev('switch.updated', waiting)];
  const draft = { version: 2, text: 'keep me', images: [], undelivered: [{ clientMessageId: 'c1', text: 'never sent' }] };
  let emit = null, calls = 0, reply = () => ({ ok: true, value: { runtimeSessionId: 'rs1', lastSequence: first.length, events: first, state: 'idle' } });
  const bridge = { onEvent: listener => { emit = listener; return () => {}; }, snapshot: async () => { calls++; return reply(); } };
  await withBridge(bridge, async store => {
    store.ensureNativeSession('t1'); await settle();
    assert.deepEqual([entriesOf(store).get('t1').model.switchState.phase, calls], ['waiting-turn', 1]);
    emit(ev('switch.updated', prepare)); await settle();
    assert.deepEqual([entriesOf(store).get('t1').model.switchState.phase, calls], ['preparing', 1], 'a live update changes the state without asking again');
    reply = () => ({ ok: true, value: { runtimeSessionId: 'rs1', lastSequence: 4, events: [...first, ev('session.state', { state: 'idle' })], state: 'idle', switchState: stable, handoff: { changeId: 3, draft } } });
    emit(ev('switch.updated', stable)); await sleep(400);
    assert.equal(calls, 2, 'a settled change asks for the snapshot, which may carry the draft');
    assert.equal(entriesOf(store).get('t1').model.switchState.phase, 'stable'); assert.deepEqual(entriesOf(store).get('t1').handoff.draft, draft);
    assert.deepEqual(store.takeHandoff('t1'), draft); assert.equal(store.takeHandoff('t1'), null, 'once');
    store.refreshNativeSession('t1'); await settle();
    assert.equal(entriesOf(store).get('t1').handoff, null, 'the same change in a later snapshot does not bring the words back');
    emit(ev('switch.updated', stable, { replay: true })); await sleep(400);
    assert.equal(calls, 3, 'a replayed settle is not news (only the explicit refresh asked)');
  });
});

test('a live switch.updated moves the usage count of waiting sessions; a replayed one does not', async () => {
  const ev = stream(), bridge = { onEvent: listener => { bridge.emit = listener; return () => {}; }, snapshot: async () => ({ ok: true, value: null }) };
  await withBridge(bridge, async store => {
    store.ensureNativeSession('t1'); await settle();
    bridge.emit(ev('switch.updated', switchState(), { replay: true })); assert.equal(read(store.useUsageRevision), 0);
    bridge.emit(ev('switch.updated', switchState({ phase: 'preparing' }))); assert.equal(read(store.useUsageRevision), 1);
  });
});

function noticeView(bridge) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { agentrix: { nativeSession: bridge } } });
  const harness = hookHarness('src/features/native-session/SwitchNotice.tsx', {
    '@phosphor-icons/react': new Proxy({}, { get: () => () => null }), './i18n': { t: fill }, './native-session.css': {}, './native-store.ts': { resolveSwitch: (terminal, entry) => terminal ?? entry?.model.switchState ?? null, useNativeEntries: () => new Map() },
    './native-words': words(), './native-bridge.ts': { nativeBridge: () => bridge },
  });
  const question = (state, sessionId = 'rs1') => elements(harness.render('SwitchQuestion', { terminalId: 't1', sessionId, state }).result);
  const button = (state, label, sessionId) => question(state, sessionId).find(node => node.type === 'button' && node.props.children === label);
  return { harness, question, button, done() { harness.dispose(); if (previous) Object.defineProperty(globalThis, 'window', previous); else delete globalThis.window; } };
}
const asking = (patch = {}) => switchState({ phase: 'awaiting-choice', requestId: 'rq1', background: { count: 2, known: true }, ...patch });

test('the question card shows only while main asks, says what a switch ends, and sends the owner’s choice with the change and request it was asked for', async () => {
  const answers = [], view = noticeView({ answer: async (...args) => { answers.push(args); return { ok: true, value: {} }; } });
  try {
    for (const state of [null, switchState(), asking({ requestId: null }), asking({ phase: 'waiting-background', requestId: null }), asking({ phase: 'stable' })]) assert.deepEqual(view.question(state), [], JSON.stringify(state));
    const nodes = view.question(asking());
    assert.equal(nodes.find(node => node.type === 'section').props.className, 'reading-choice native-request native-switch-question', 'the request card’s look');
    assert.equal(nodes.find(node => node.type === 'strong').props.children, '现在切到 终端？'); assert.equal(nodes.find(node => node.props?.className === 'native-switch-text').props.children, '切换会结束 2 个后台任务。');
    assert.deepEqual(nodes.filter(node => node.type === 'button').map(node => node.props.children), ['等它们结束', '现在切换']);
    assert.equal(answers.length, 0, 'it waits for the owner’s click');
    view.button(asking(), '等它们结束').props.onClick(); await settle();
    assert.deepEqual(answers, [['t1', 'rs1', 'rq1', { switch: { changeId: 3, requestId: 'rq1', action: 'wait' } }]]);
    assert.equal(view.button(asking(), '现在切换').props.disabled, true, 'shut while the answer is with main'); view.button(asking(), '现在切换').props.onClick(); await settle();
    assert.equal(answers.length, 1, 'one answer per question');
    assert.equal(view.button(asking({ phase: 'waiting-background' }), '现在切换').props.disabled, false, 'after 等它们结束 the same request in the waiting phase can still switch now');
    assert.equal(view.button(asking({ requestId: 'rq2' }), '现在切换').props.disabled, false, 'a new question is a new card');
    view.button(asking({ requestId: 'rq2' }), '现在切换').props.onClick(); await settle();
    assert.deepEqual(answers.at(-1), ['t1', 'rs1', 'rq2', { switch: { changeId: 3, requestId: 'rq2', action: 'now' } }]);
    assert.deepEqual(view.question(asking({ phase: 'waiting-background' })).filter(node => node.type === 'button').map(node => node.props.children), ['现在切换'], 'while it waits for the tasks, the owner can still switch now');
    view.button(asking({ phase: 'waiting-background', requestId: 'rq9' }), '现在切换').props.onClick(); await settle();
    assert.deepEqual(answers.at(-1), ['t1', 'rs1', 'rq9', { switch: { changeId: 3, requestId: 'rq9', action: 'now' } }]);
    const bare = view.question(asking({ background: { count: 0, known: false } })).find(node => node.props?.className === 'native-switch-text').props.children;
    assert.match(bare, /还不知道/); assert.doesNotMatch(bare, /\d/, 'unknown background state is not “0 tasks”');
    view.button(asking({ requestId: 'rq3' }), '现在切换', null).props.onClick(); await settle();
    assert.equal(answers.at(-1)[1], 't1', 'a terminal session has no runtime id: main finds it by the terminal');
  } finally { view.done(); }
});

test('a refused answer opens the question again with the reason', async () => {
  const view = noticeView({ answer: async () => ({ ok: false, error: 'the change has moved on' }) });
  try {
    view.button(asking(), '等它们结束').props.onClick(); await settle();
    assert.equal(view.question(asking()).find(node => node.props?.role === 'alert').props.children, 'the change has moved on');
    assert.equal(view.button(asking(), '等它们结束').props.disabled, false, 'and it can be answered again');
  } finally { view.done(); }
  const thrown = noticeView({ answer: async () => { throw new Error('ipc closed'); } });
  try { thrown.button(asking(), '现在切换').props.onClick(); await settle(); assert.equal(thrown.question(asking()).find(node => node.props?.role === 'alert').props.children, 'ipc closed'); } finally { thrown.done(); }
});

test('an answer main ignores as late ({accepted: false}) is not an answer taken: the card opens again and says so', async () => {
  const view = noticeView({ answer: async () => ({ ok: true, value: { accepted: false } }) });
  try {
    view.button(asking(), '现在切换').props.onClick(); await settle();
    assert.equal(view.question(asking()).find(node => node.props?.role === 'alert').props.children, '这个选择已经过期，没有生效。');
    assert.equal(view.button(asking(), '现在切换').props.disabled, false);
  } finally { view.done(); }
});

test('the switch line and the question stand at the end of the timeline, not in a header, and neither is a request', () => {
  const view = sessionView(idle, {});
  try {
    assert.equal(elements(view.tree()).some(node => node.props?.className === 'native-tail'), false, 'nothing under way: nothing is added');
    view.switching(switchState({ phase: 'waiting-turn' }));
    const nodes = elements(view.tree()), tail = nodes.find(node => node.props?.className === 'native-tail');
    assert.ok(tail, 'a line under way has its place in the conversation'); assert.equal(elements(tail.props.children).filter(node => node.props?.state?.phase === 'waiting-turn').length, 2, 'the line and the question read the state');
    assert.equal(nodes.some(node => node.props?.request), false, 'the question is not a request');
    view.switching(asking());
    const asked = elements(view.tree()).find(node => node.props?.className === 'native-tail');
    assert.ok(asked, 'the question has its place in the conversation'); assert.equal(elements(asked.props.children).filter(node => node.props?.state?.phase === 'awaiting-choice').length, 2);
    view.switching(asking({ phase: 'waiting-background' }));
    assert.equal(elements(view.tree()).some(node => node.props?.className === 'native-tail'), true, 'while it waits, the owner can still switch now');
    assert.equal(view.decorations().status, null, 'a switch under way is no round in progress'); assert.equal(view.toBottom.length, 1, 'the question is brought into view once');
  } finally { view.done(); }
});

test('a draft carried into the native view lands in the empty box, beside typed words otherwise, with its pictures and unsent messages; nothing is sent', async () => {
  const sends = [], view = sessionView(idle, { send: async (...args) => { sends.push(args); return { ok: true, value: {} }; } });
  const texts = () => elements(view.tree()).filter(node => node.type === 'li').map(node => node.props.children[0]);
  const take = node => node.type === 'button' && node.props.children === '取回';
  const attached = () => elements(view.tree()).find(node => node.type === view.parts.UserImages)?.props.images;
  try {
    view.handoff.incoming = { version: 1, text: 'half a thought', images: ['data:image/png;base64,AAAA'], undelivered: [{ clientMessageId: 'u1', text: 'refused earlier' }, { clientMessageId: 'u2', text: 'second', images: ['data:image/png;base64,BBBB'] }] };
    view.tree(); await settle(); view.tree();
    assert.equal(view.box().props.value, 'half a thought'); assert.deepEqual(texts(), ['refused earlier', 'second']);
    assert.equal(view.handoff.taken, 1, 'taken once'); assert.deepEqual(sends, [], 'arrival sends nothing');
    assert.deepEqual(attached(), ['data:image/png;base64,AAAA'], 'the picture waits with the next message');
    assert.equal(elements(view.tree()).find(take).props.disabled, true, 'the box is not empty: nothing replaces it');
    view.type(''); view.tree();
    elements(view.tree()).find(take).props.onClick(); view.tree();
    assert.equal(view.box().props.value, 'refused earlier'); assert.deepEqual(texts(), ['second']);
    view.press(); await settle(); view.tree();
    assert.equal(sends.length, 1); assert.deepEqual(sends[0].slice(0, 2), ['t1', 'rs1']); assert.equal(sends[0][3], 'refused earlier'); assert.deepEqual(sends[0][4], ['data:image/png;base64,AAAA'], 'the carried picture goes with the owner’s own send');
    view.type('typing now'); view.tree();
    view.handoff.incoming = { version: 2, text: 'new words', images: [], undelivered: [] };
    view.tree(); await settle(); view.tree();
    assert.equal(view.box().props.value, 'typing now', 'typed words stay'); assert.deepEqual(texts(), ['second', 'new words'], 'the carried words wait beside them, unsent');
  } finally { view.done(); }
});

test('a draft that comes back to the box it left (a switch that failed) is shown once: in the box, its picture once, and a message that is still here as lost is not listed again', async () => {
  const sends = [], view = sessionView(idle, { send: async (...args) => { sends.push(args); return { ok: true, value: {} }; } });
  const texts = () => elements(view.tree()).filter(node => node.type === 'li').map(node => node.props.children[0]);
  const attached = () => elements(view.tree()).find(node => node.type === view.parts.UserImages)?.props.images;
  try {
    view.type('half a thought'); view.tree();
    view.type('refused'); view.press(); await settle();
    const id = sends[0][2];
    view.show([...idle(view.ev), view.ev('item.upsert', { kind: 'user-message', status: 'interrupted', content: { text: 'refused', clientMessageId: id, unsent: true } }, { itemId: id })]);
    view.type('half a thought'); view.tree();
    view.handoff.incoming = { version: 3, text: 'half a thought', images: ['data:image/png;base64,AAAA'], undelivered: [{ clientMessageId: id, text: 'refused' }, { clientMessageId: 'old', text: 'from before' }] };
    view.tree(); await settle(); view.tree();
    view.handoff.incoming = { version: 4, text: 'half a thought', images: ['data:image/png;base64,AAAA'], undelivered: [{ clientMessageId: 'old', text: 'from before' }] };
    view.tree(); await settle(); view.tree();
    assert.equal(view.box().props.value, 'half a thought'); assert.deepEqual(texts(), ['from before'], 'the words are in the box and in no list; the refused message is its card’s alone');
    assert.deepEqual(attached(), ['data:image/png;base64,AAAA']);
  } finally { view.done(); }
});

test('the native view offers its draft to a switch: the words, the pictures and only the messages main refused; and its input shuts only when main accepts', async () => {
  const view = sessionView(idle, { send: async () => ({ ok: true, value: {} }) });
  try {
    view.tree(); view.type('draft one'); view.tree();
    assert.deepEqual(view.handoff.offers.at(-1), { text: 'draft one', images: [], undelivered: [] });
    view.type('sent words'); view.tree(); view.press(); await settle(); view.tree();
    assert.deepEqual(view.handoff.offers.at(-1), { text: '', images: [], undelivered: [] }, 'a message in flight is not offered: it may arrive');
    assert.equal(view.box().props.disabled, false, 'until main accepts, the old input stays as it was');
    view.handoff.locked = true; view.tree();
    assert.equal(view.box().props.disabled, true); assert.equal(view.box().props.placeholder, '正在切换运行方式，稍后继续');
  } finally { view.done(); }
});

test('a card nobody offers a draft for (the raw terminal) hands main an empty draft, so its switch is never left preparing; a picture main would refuse stays out of the draft instead of stopping it', async () => {
  const answers = [], hook = handoffHook({ answer: async (...args) => { answers.push(args); return { ok: true, value: { changeId: 3, version: 0, accepted: true } }; } }, { state: switchState({ phase: 'preparing' }), identity: { runtimeSessionId: 'rs7' } });
  try {
    hook.render(); await settle();
    assert.deepEqual(answers, [['t1', 'rs7', 'handoff-3', { handoff: { changeId: 3, draft: { version: 0, text: '', images: [], undelivered: [] } } }]], 'with no view, an empty draft; the session is the one the window knows');
    assert.equal(hook.render().locked, true);
  } finally { hook.done(); }
  const seen = [], pictures = handoffHook({ answer: async (...args) => { seen.push(args[3]); return { ok: true, value: {} }; } }, { state: switchState({ phase: 'waiting-turn' }) });
  try {
    pictures.render().offer({ text: 'x', images: ['data:image/gif;base64,AAAA', 'data:image/png;base64,BBBB'], undelivered: [{ clientMessageId: 'u', text: 'y', images: ['data:image/gif;base64,AAAA'] }] });
    pictures.set({ state: switchState({ phase: 'preparing' }) }); pictures.render(); await settle();
    assert.deepEqual(seen.at(-1).handoff.draft, { version: 1, text: 'x', images: ['data:image/png;base64,BBBB'], undelivered: [{ clientMessageId: 'u', text: 'y', images: [] }] });
  } finally { pictures.done(); }
});

function handoffHook(bridge, current) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window'), taken = [];
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { agentrix: { nativeSession: bridge } } });
  const harness = hookHarness('src/features/native-session/draft-handoff.ts', {
    './native-bridge.ts': { nativeBridge: () => bridge },
    './native-store.ts': { resolveSwitch: terminal => terminal, useNativeEntries: () => new Map([['t1', { model: { identity: current.identity, switchState: current.eventState }, handoff: current.incoming ? { changeId: current.incomingChange ?? 9, draft: current.incoming } : null }]]), takeHandoff: id => { taken.push(id); const draft = current.incoming; current.incoming = null; return draft; } },
  });
  return { render: () => harness.render('useHandoff', 't1', current.runtimeId ?? null, current.state, current.surface).result, taken, set(patch) { Object.assign(current, patch); }, done() { harness.dispose(); if (previous) Object.defineProperty(globalThis, 'window', previous); else delete globalThis.window; } };
}

test('R5 a preparing snapshot cannot give the outgoing draft back to its source; only the committed surface takes it once', () => {
  const state = switchState({ current: 'terminal', target: 'api', phase: 'preparing' });
  const draft = { version: 1, text: 'survive the fast switch', images: [], undelivered: [] };
  const hook = handoffHook({ answer: async () => ({ ok: true, value: {} }) }, { state, surface: 'terminal', incoming: draft, incomingChange: state.changeId });
  try {
    assert.equal(hook.render().incoming, null); assert.equal(hook.render().take(), null); assert.equal(hook.taken.length, 0);
    hook.set({ state: { ...state, current: 'api', phase: 'stable' } });
    assert.equal(hook.render().incoming, null, 'workspace still draws the old surface');
    hook.set({ surface: 'api' });
    assert.deepEqual(hook.render().take(), draft); assert.equal(hook.render().take(), null); assert.equal(hook.taken.length, 1);
  } finally { hook.done(); }
});

test('R7 a changed runtime binding retries handoff even with the same switch-state object', async () => {
  const answers = [], state = switchState({ phase: 'preparing' });
  const hook = handoffHook({ answer: async (...args) => {
    answers.push(args); return { ok: true, value: { changeId: state.changeId, version: 0, accepted: args[1] === 'new' } };
  } }, { state, runtimeId: 'old' });
  try {
    hook.render(); await settle(); assert.equal(hook.render().locked, false);
    hook.set({ runtimeId: 'new' }); hook.render(); await settle();
    assert.deepEqual(answers.map(args => args[1]), ['old', 'new']); assert.equal(hook.render().locked, true);
  } finally { hook.done(); }
  const seen = [], newer = handoffHook({ answer: async (...args) => { seen.push(args[1]); return { ok: true, value: {} }; } },
    { state, runtimeId: 'old', identity: { runtimeSessionId: 'new' }, eventState: state });
  try { newer.render(); await settle(); assert.deepEqual(seen, ['new'], 'the event binding for this change wins over an older workspace broadcast'); }
  finally { newer.done(); }
});

test('R7 a late receipt for the previous change cannot unlock or replace the latest accepted handoff', async () => {
  const pending = [], hook = handoffHook({ answer: (...args) => new Promise(resolve => pending.push({ args, resolve })) },
    { state: switchState({ phase: 'preparing' }), runtimeId: 'old' });
  try {
    hook.render(); hook.set({ state: switchState({ changeId: 4, phase: 'preparing' }), runtimeId: 'new' }); hook.render();
    const accept = index => pending[index].resolve({ ok: true, value: { changeId: index + 3, version: 0, accepted: true } });
    accept(1); await settle(); assert.equal(hook.render().locked, true);
    accept(0); await settle(); assert.equal(hook.render().locked, true, 'the latest receipt remains authoritative');
  } finally { hook.done(); }
});

test('the draft goes to main once per version when a switch prepares, only an accepted receipt for the latest version shuts the input, and a failed switch opens it again', async () => {
  const answers = []; let receipt = { ok: true, value: { changeId: 3, version: 1, accepted: false } };
  const hook = handoffHook({ answer: async (...args) => { answers.push(args); return receipt; } }, { state: switchState({ phase: 'waiting-turn' }) });
  try {
    let handoff = hook.render(); handoff.offer({ text: 'one', images: [], undelivered: [] });
    hook.render(); await settle();
    assert.deepEqual(answers, [], 'nothing leaves while the switch only waits'); assert.equal(handoff.locked, false);
    hook.set({ state: switchState({ phase: 'preparing' }) }); hook.render(); await settle();
    assert.deepEqual(answers, [['t1', 't1', 'handoff-3', { handoff: { changeId: 3, draft: { version: 1, text: 'one', images: [], undelivered: [] } } }]]);
    assert.equal(hook.render().locked, false, 'not accepted: the old input is untouched');
    hook.render(); await settle(); assert.equal(answers.length, 1, 'the same version is not sent twice');
    handoff = hook.render(); handoff.offer({ text: 'one two', images: ['data:image/png;base64,AAAA'], undelivered: [{ clientMessageId: 'w1', text: 'not delivered' }] });
    receipt = { ok: true, value: { changeId: 3, version: 2, accepted: true } };
    hook.render(); await settle(); hook.render();
    assert.equal(answers.length, 2); assert.deepEqual(answers[1][3].handoff.draft, { version: 2, text: 'one two', images: ['data:image/png;base64,AAAA'], undelivered: [{ clientMessageId: 'w1', text: 'not delivered' }] });
    assert.equal(hook.render().locked, true, 'accepted: the old input shuts while the switch goes');
    hook.set({ state: switchState({ phase: 'switching' }) }); assert.equal(hook.render().locked, true);
    hook.set({ state: switchState({ phase: 'rolling-back' }) }); assert.equal(hook.render().locked, false, 'a switch that fails gives the input back');
    hook.set({ state: switchState({ changeId: 4, phase: 'preparing' }) }); assert.equal(hook.render().locked, false, 'a new change is a new handoff');
  } finally { hook.done(); }
});

test('a receipt for an older version shuts nothing, and a refused or throwing answer is offered again with the next update of the switch', async () => {
  const pending = [], offer = text => ({ text, images: [], undelivered: [] }), accepted = version => ({ ok: true, value: { changeId: 3, version, accepted: true } });
  const hook = handoffHook({ answer: (...args) => new Promise(resolve => pending.push({ version: args[3].handoff.draft.version, resolve })) }, { state: switchState({ phase: 'waiting-turn' }) });
  try {
    const handoff = hook.render(); handoff.offer(offer('a')); hook.set({ state: switchState({ phase: 'preparing' }) }); hook.render(); handoff.offer(offer('ab')); hook.render();
    assert.deepEqual(pending.map(call => call.version), [1, 2]);
    pending[0].resolve(accepted(1)); await settle();
    assert.equal(hook.render().locked, false, 'version 1 was accepted but the draft is already at version 2');
    pending[1].resolve({ ok: false, error: 'busy' }); await settle();
    hook.set({ state: switchState({ phase: 'preparing', reason: 'again' }) }); hook.render(); await settle();
    assert.deepEqual(pending.map(call => call.version), [1, 2, 2], 'a refused answer is offered again with the next update');
    pending[2].resolve(Promise.reject(new Error('ipc'))); await settle();
    hook.set({ state: switchState({ phase: 'preparing', reason: 'and again' }) }); hook.render(); await settle();
    assert.equal(pending.length, 4, 'so is one that threw'); assert.equal(hook.render().locked, false);
    pending[3].resolve(accepted(2)); await settle();
    assert.equal(hook.render().locked, true);
  } finally { hook.done(); }
  const quiet = handoffHook({ answer: async () => { throw new Error('never asked'); } }, { state: null });
  try { const handoff = quiet.render(); handoff.offer(offer('x')); quiet.render(); await settle(); assert.equal(quiet.render().locked, false); } finally { quiet.done(); }
});

test('the draft that arrives is read from the entry and handed over by take', () => {
  const hook = handoffHook({}, { state: null, incoming: { version: 1, text: 'back', images: [], undelivered: [] } });
  try {
    const handoff = hook.render();
    assert.equal(handoff.incoming.text, 'back'); assert.equal(handoff.take().text, 'back'); assert.deepEqual(hook.taken, ['t1']);
  } finally { hook.done(); }
});

test('a failed switch is told in the path note whichever transport the card is on, until the owner closes it; the move-to-terminal note is still the terminal’s only', () => {
  const { applyEvents, emptyModel } = load('features/native-session/native-model.ts'), ev = stream(), store = load('features/native-session/native-store.ts');
  const model = applyEvents(emptyModel(), [ev('session.state', { state: 'idle' }), ev('path.changed', { previous: 'api', selected: 'terminal', reason: 'budget_exhausted' })]).model;
  const entry = { model, dismissed: null, noteDismissed: false, handoff: null }, dismissed = []; let shown = true;
  const harness = hookHarness('src/features/native-session/NativePathNote.tsx', {
    '@phosphor-icons/react': new Proxy({}, { get: () => () => null }), './i18n': { t: fill }, './native-session.css': {}, './native-words': words(), './native-bridge.ts': { copyNativeText: async () => ({ ok: true }) }, './SwitchNotice': load('features/native-session/SwitchNotice.tsx'),
    './native-store.ts': { useNativeEntries: () => new Map([['t1', entry]]), terminalSwitch: store.terminalSwitch, dismissNote: () => dismissed.push('path'), resolveSwitch: store.resolveSwitch, useSwitchNoteShown: () => shown, dismissSwitchNote: (id, state) => dismissed.push([id, state.changeId]) },
  });
  const note = props => harness.render('NativePathNote', { terminalId: 't1', ...props }).result;
  const text = props => { const result = note(props); return result && elements(result).find(node => node.type === 'span')?.props.children; };
  try {
    const failed = switchState({ phase: 'rolling-back', reason: '终端没有启动' });
    assert.equal(text({ terminalActive: false, switchState: failed }), '没有切换成功，仍使用 API · 终端没有启动', 'a native card has no terminal move to tell, but a failure it does');
    assert.equal(text({ terminalActive: false }), null, 'a native card says nothing about the terminal move'); assert.match(text({ terminalActive: true }), /已改用终端/);
    assert.match(text({ terminalActive: true, switchState: failed }), /没有切换成功/, 'the failure of the change in hand comes first');
    elements(note({ switchState: failed })).find(node => node.props?.title === '知道了').props.onClick();
    assert.deepEqual(dismissed, [['t1', 3]], 'closing it is for that change');
    shown = false; assert.match(text({ terminalActive: true, switchState: failed }), /已改用终端/, 'closed: the older note is not hidden by it');
    assert.equal(text({ terminalActive: false, switchState: failed }), null);
    assert.equal(text({ terminalActive: false, switchState: switchState({ phase: 'preparing' }) }), null, 'a switch under way is not a failure');
  } finally { harness.dispose(); }
});

test('every card holds its draft handoff, whatever it shows: the raw terminal, the reading view and the native view alike, so a switch never waits for a view that is not there', () => {
  const handoffs = [], state = switchState({ phase: 'preparing' });
  gridMarkup([terminal('t1', { sessionId: 's1', codexActive: true, switchState: state, nativeRuntimeSessionId: 'rs1' }), terminal('t2'), terminal('t3', { switchState: state })], { focused: true, native: ['t3'], handoffs });
  assert.deepEqual(handoffs.sort(), [['t1', 'rs1', 'preparing'], ['t2', null, null], ['t3', null, 'preparing']], 'one per card, with its own switch state');
  const grid = fs.readFileSync(path.join(src, 'features/terminal/ProjectTerminals.tsx'), 'utf8');
  assert.equal((grid.match(/useHandoff\(/g) ?? []).length, 1, 'one place holds it');
  assert.doesNotMatch(fs.readFileSync(path.join(src, 'features/native-session/NativeSessionView.tsx'), 'utf8'), /useHandoff\(/, 'and the native view takes it from the card like the reading view');
});

test('the grid hands each card’s switch state to the note over it and to the native view, on both transports', () => {
  const state = switchState({ phase: 'preparing' });
  const term = gridMarkup([terminal('t1', { sessionId: 's1', codexActive: true, switchState: state })]);
  assert.match(term, /class="note-stub" data-terminal="t1" data-phase="preparing" data-active="true"/);
  const native = gridMarkup([terminal('t1', { switchState: state })], { native: ['t1'] });
  assert.match(native, /class="native-stub" data-terminal="t1" data-phase="preparing"/, 'the native view draws its own line in its header');
  assert.match(native, /class="note-stub" data-terminal="t1" data-phase="preparing" data-active="false"/, 'the failure note reaches a native card too');
  assert.match(gridMarkup([terminal('t1', { sessionId: 's1' })]), /data-phase=""/, 'no switch, no state');
});

test('over a terminal card the path note carries the switch line and the question, in one frame with the other notes; over a native card it leaves them to the view', () => {
  const store = load('features/native-session/native-store.ts'), SwitchLine = () => null, SwitchQuestion = () => null;
  const harness = hookHarness('src/features/native-session/NativePathNote.tsx', {
    '@phosphor-icons/react': new Proxy({}, { get: () => () => null }), './i18n': { t: fill }, './native-session.css': {}, './native-words': words(), './native-bridge.ts': { copyNativeText: async () => ({ ok: true }) },
    './native-store.ts': { useNativeEntries: () => new Map(), terminalSwitch: store.terminalSwitch, dismissNote() {}, resolveSwitch: store.resolveSwitch, useSwitchNoteShown: () => true, dismissSwitchNote() {} },
    './SwitchNotice': { asksChoice: state => state?.phase === 'awaiting-choice' && !!state.requestId, SwitchLine, SwitchQuestion },
  });
  const frame = props => harness.render('NativePathNote', { terminalId: 't1', ...props }).result;
  const parts = result => elements(result).filter(node => node.type === SwitchLine || node.type === SwitchQuestion).map(node => [node.type === SwitchLine ? 'line' : 'question', node.props.sessionId ?? null, node.props.state.phase]);
  try {
    assert.equal(frame({ terminalActive: true, switchState: switchState({ phase: 'stable' }) }), null, 'a settled change has nothing to say');
    assert.equal(frame({ terminalActive: true }), null);
    const waiting = frame({ terminalActive: true, switchState: switchState({ phase: 'waiting-turn' }), sessionId: 'rs9' });
    assert.equal(waiting.props.className, 'native-path-note'); assert.deepEqual(parts(waiting), [['line', null, 'waiting-turn'], ['question', 'rs9', 'waiting-turn']]);
    const question = frame({ terminalActive: true, switchState: asking() });
    assert.ok(question, 'the question alone is enough to show the frame'); assert.deepEqual(parts(question).map(part => part[0]), ['question']);
    assert.equal(frame({ terminalActive: false, switchState: asking() }), null, 'a native card’s view draws the question itself');
    assert.equal(frame({ terminalActive: false, switchState: switchState({ phase: 'switching' }) }), null);
  } finally { harness.dispose(); }
});

test('the switch parts write to no terminal, never expand a project and keep no secret: the guard covers the new files', () => {
  const dir = path.join(src, 'features/native-session'), code = file => fs.readFileSync(path.join(dir, file), 'utf8').replace(/\/\/.*$/gm, '');
  for (const file of ['SwitchNotice.tsx', 'draft-handoff.ts']) {
    assert.ok(fs.existsSync(path.join(dir, file)), file);
    assert.doesNotMatch(code(file), /writeTerminal|pasteTerminal|onExpand|expandProject|window\.agentrix|console\.|localStorage|sessionStorage/, file);
  }
  assert.doesNotMatch(code('draft-handoff.ts'), /\.send\(/, 'a draft is handed to main and never sent by the handoff');
});

// ---- the reading view's side of the draft handoff -------------------------------------------------------------------------------------
const { popupHarness } = require('./reading-popup-coverage.test.cjs');
const { DIALOG_SETTLE } = require('../src/features/reading/reading-ready.ts');

function handoffProps() {
  return { locked: false, incoming: null, offers: [], taken: 0, offer(draft) { this.offers.push(draft); }, take() { const draft = this.incoming; this.incoming = null; this.taken++; return draft; } };
}

test('the reading view offers its words and the messages still waiting to be written, and nothing else; the box shuts only when the handoff says so', t => {
  const h = popupHarness(t, 'codex'), handoff = handoffProps();
  h.props.handoff = handoff; h.render();
  assert.deepEqual(handoff.offers.at(-1), { text: '', images: [], undelivered: [] });
  h.edit('half a thought');
  assert.deepEqual(handoff.offers.at(-1), { text: 'half a thought', images: [], undelivered: [] });
  // A dialog is waiting, so a sent message waits in the outbox for the input to come back.
  h.view.rows = ['Settings', 'Esc to close']; h.render(); h.tick(DIALOG_SETTLE);
  h.keys('Enter');
  const waiting = handoff.offers.at(-1);
  assert.equal(waiting.text, ''); assert.deepEqual(waiting.undelivered.map(message => message.text), ['half a thought']); assert.match(waiting.undelivered[0].clientMessageId, /^waiting-\d+$/);
  const box = () => elements(h.tree()).find(element => element.type === 'textarea').props;
  assert.equal(box().disabled, false, 'until the handoff is accepted the input is untouched');
  handoff.locked = true; h.render();
  assert.equal(box().disabled, true); assert.equal(box().placeholder, '正在切换运行方式，稍后继续');
  assert.deepEqual(h.writes, []); assert.deepEqual(h.pastes, []);
});

test('a draft that comes with the new session goes into the empty box, beside typed words otherwise; its messages wait as unsent for the owner’s click, and nothing is written to the terminal', t => {
  const h = popupHarness(t, 'codex'), handoff = handoffProps(), box = () => elements(h.tree()).find(element => element.type === 'textarea').props;
  const unsent = () => elements(h.tree()).filter(element => element.type === 'li').map(element => element.props.children[0]);
  const retrieve = () => elements(h.tree()).find(element => element.type === 'button' && element.props.children === '取回');
  h.props.handoff = handoff; h.render();
  handoff.incoming = { version: 2, text: 'carried words', images: ['data:image/png;base64,AAAA'], undelivered: [{ clientMessageId: 'u1', text: 'never delivered' }] };
  h.render(); h.render();
  assert.equal(box().value, 'carried words'); assert.equal(handoff.taken, 1, 'taken once');
  assert.deepEqual(unsent(), ['never delivered'], 'an undelivered message is shown as unsent and is not sent');
  assert.deepEqual(handoff.offers.at(-1).undelivered.map(message => message.text), ['never delivered'], 'and a second switch offers it again: it is still not delivered');
  assert.deepEqual(elements(h.tree()).find(element => element.props?.images)?.props.images, ['data:image/png;base64,AAAA'], 'the picture is shown, to be pasted again');
  assert.equal(retrieve().props.disabled, true, 'the box holds words: the message does not replace them');
  h.edit(''); retrieve().props.onClick(); h.render();
  assert.equal(box().value, 'never delivered'); assert.deepEqual(unsent(), []);
  h.edit('typing now'); handoff.incoming = { version: 3, text: 'second draft', images: [], undelivered: [] }; h.render(); h.render();
  assert.equal(box().value, 'typing now'); assert.deepEqual(unsent(), ['second draft'], 'the arriving words wait beside what is being typed');
  assert.deepEqual(h.writes, []); assert.deepEqual(h.pastes, [], 'handing a draft over writes nothing and sends nothing');
});

test('a draft waits while the box cannot take it', t => {
  const h = popupHarness(t, 'codex'), handoff = handoffProps();
  h.props.handoff = handoff; handoff.locked = true; handoff.incoming = { version: 1, text: 'later', images: [], undelivered: [] };
  h.render(); h.render();
  assert.equal(handoff.taken, 0, 'a shut box does not take it'); assert.equal(handoff.incoming.text, 'later');
  handoff.locked = false; h.render(); h.render();
  assert.equal(handoff.taken, 1);
});

// ---- the structured end of a turn, the provider's notice, command phrases ------------------------------------------------------------
const mainWords = {
  completed: '本轮已完成。', tool_deferred: '这次工具调用被钩子推迟，没有执行。', max_turns: '已达到本轮最大执行次数。', budget_exhausted: 'API 预算上限已用完。',
  api_error: 'API 请求失败，本轮未能完成。', owner: '本轮已中断。',
};
// One finished round of a session: your message, a reply (unless `reply` is false) and the turn.completed the provider sent.
const endedRound = (completed, { reply = true, extra = [], provider = {} } = {}) => viewHtml(ev => [ev('session.state', { state: 'idle', reason: null }),
  ev('item.upsert', { kind: 'user-message', status: 'completed', content: { text: 'go', clientMessageId: 'c1' } }, { itemId: 'u1' }), ...extra.map(make => make(ev)),
  ...(reply ? [ev('item.upsert', { kind: 'agent-message', status: 'completed', content: { text: 'here is the answer' } }, { itemId: 'a1' })] : []), ev('turn.completed', completed)], provider);
const resultRow = html => (html.match(/<div class="result-status[^"]*"[\s\S]*?<\/p>(?:<p class="result-sub">[^<]*<\/p>)?/) ?? [''])[0];

test('the model keeps how a turn ended as the provider gave it and the provider’s notice, and a field nobody gave stays null', () => {
  const { applyEvents, emptyModel } = load('features/native-session/native-model.ts'), ev = stream();
  const done = applyEvents(emptyModel(), [ev('turn.started', {}), ev('turn.completed', { status: 'completed', error: null, terminalReason: 'completed', message: '本轮已完成。', durationMs: 83000, costUsdMicros: 120000, costEstimated: true,
    tokens: { input: 1200, cachedInput: 50000, cacheWrite: 800, output: 300, reasoning: null } })]).model;
  assert.deepEqual(done.turn.end, { reason: 'completed', message: '本轮已完成。', durationMs: 83000, costUsdMicros: 120000, costEstimated: true, tokens: { input: 1200, cachedInput: 50000, cacheWrite: 800, output: 300, reasoning: null } });
  const bare = applyEvents(emptyModel(), [ev('turn.completed', { status: 'failed', error: 'x', durationMs: -5, costUsdMicros: 'a', tokens: { input: null, output: undefined } })]).model;
  assert.deepEqual(bare.turn.end, { reason: null, message: null, durationMs: null, costUsdMicros: null, costEstimated: null, tokens: null }, 'nothing is made up, and a count that is not a count is none');
  const next = stream(), again = applyEvents(emptyModel(), [next('turn.completed', { status: 'completed', error: null, durationMs: 5 }), next('turn.started', {})]).model;
  assert.equal(again.turn.end, null, 'a new turn forgets the last one’s end');
  const text = '额度不足，需要充值后继续。';
  const limited = applyEvents(emptyModel(), [ev('limits.updated', { scopeId: 's', providerStatus: 'rejected', notice: { code: 'credits_required', message: text, resetsAtMs: null } })]).model;
  assert.deepEqual(limited.limits, { providerStatus: 'rejected', notice: { code: 'credits_required', message: text, resetsAtMs: null } });
  const consoleNotice = applyEvents(emptyModel(), [stream()('limits.updated', { scopeId: 's', notice: { code: 'credits_required', message: text, resetsAtMs: null, action: 'check-console', url: 'https://platform.claude.com/settings/billing' } })]).model;
  assert.deepEqual(consoleNotice.limits.notice, { code: 'credits_required', message: text, resetsAtMs: null, action: 'check-console', url: 'https://platform.claude.com/settings/billing' }, 'the console action and its address are kept as given');
  assert.equal(applyEvents(limited, [ev('limits.updated', { scopeId: 's', notice: null })]).model.limits.notice, null, 'a later update with no notice clears it');
  assert.equal(applyEvents(emptyModel(), [ev('limits.updated', { scopeId: 's', notice: { code: 'rate_limited' } })]).model.limits.notice, null, 'a notice without words is none');
});

test('turn facts: the duration main measured, this turn’s spend as an estimate and its tokens, nothing for what was not given, and never a zero', () => {
  const { turnFacts, noticeWords, sentence, clockWords } = words(), counts = patch => ({ input: null, cachedInput: null, cacheWrite: null, output: null, reasoning: null, ...patch });
  const end = patch => ({ reason: 'completed', message: '本轮已完成。', durationMs: null, costUsdMicros: null, costEstimated: null, tokens: null, ...patch });
  assert.deepEqual(turnFacts(end({ durationMs: 83000, costUsdMicros: 120000, costEstimated: true, tokens: counts({ input: 1200, cachedInput: 50000, cacheWrite: 800, output: 300 }) }), 'claude', true),
    { durationMs: 83000, spend: '约 $0.12', tokens: '输入 52,000 · 输出 300' }, 'Claude’s input does not hold its cache: the cached and written parts are added; the completed message is not repeated');
  assert.deepEqual(turnFacts(end({ durationMs: 5000, tokens: counts({ input: 1000, cachedInput: 400, output: 50, reasoning: 20 }) }), 'codex', true),
    { durationMs: 5000, tokens: '输入 1,000 · 输出 50' }, 'Codex’s input holds its cache and reasoning is part of its output: neither is added again; Codex gives no spend');
  assert.equal(turnFacts(end({ costUsdMicros: 5, costEstimated: true }), 'claude', true).spend, '约 <$0.01');
  assert.equal(turnFacts(end({ costUsdMicros: 120000, costEstimated: false }), 'claude', true).spend, '$0.12', 'only an estimate is marked 约');
  assert.equal(turnFacts(end({ durationMs: 0, costUsdMicros: 0, tokens: counts({ input: 0, output: 0 }) }), 'claude', true), undefined, 'a duration, spend or count that is zero is not written');
  assert.equal(turnFacts(end(), 'codex', true), undefined); assert.equal(turnFacts(null, 'claude', false), undefined);
  assert.deepEqual(turnFacts(end({ reason: 'tool_deferred', message: mainWords.tool_deferred }), 'claude', false), { message: mainWords.tool_deferred }, 'a turn that did not complete carries main’s sentence');
  assert.deepEqual([sentence(null), sentence(''), sentence('API 请求失败，本轮未能完成。')], [null, null, 'API 请求失败，本轮未能完成。']);
  const at = Date.UTC(2026, 10, 4, 12, 0), later = at + 3 * 3600_000, notice = patch => ({ code: 'rate_limited', message: 'API 请求受到限流。', resetsAtMs: null, ...patch });
  assert.deepEqual(noticeWords(notice({ message: 'API 请求受到限流。' }), at), { text: 'API 请求受到限流。', resets: null }, 'no recovery time given: none is written or guessed');
  assert.deepEqual(noticeWords(notice({ resetsAtMs: later, message: 'API 额度不足，需要充值后继续。' }), at), { text: 'API 额度不足，需要充值后继续。', resets: `约 ${clockWords(later, at)} 恢复` }, 'the time comes from resetsAtMs in the owner’s clock, not as a machine date');
  assert.equal(noticeWords(notice({ resetsAtMs: at - 1 }), at), null, 'a notice whose recovery has passed is over'); assert.equal(noticeWords(null), null);
});

test('the result row draws what the provider said: completed with duration, spend and tokens; deferred, over budget, stopped and API errors are never drawn as done', async () => {
  const claudeDone = resultRow(await endedRound({ status: 'completed', error: null, terminalReason: 'completed', message: mainWords.completed, durationMs: 83000, costUsdMicros: 120000, costEstimated: true,
    tokens: { input: 1200, cachedInput: 50000, cacheWrite: 800, output: 300, reasoning: null } }));
  assert.match(claudeDone, /class="result-status" role="status" aria-label="已完成"/); assert.match(claudeDone, /<span class="result-took"> · 用时 1 分 23 秒 · 约 \$0\.12 · 输入 52,000 · 输出 300<\/span>/);
  assert.doesNotMatch(claudeDone, /本轮已完成/, 'the completed message is not said again'); assert.doesNotMatch(claudeDone, /\{|undefined|null/);
  const codexDone = resultRow(await endedRound({ status: 'completed', error: null, terminalReason: null, message: null, durationMs: 5000, costUsdMicros: null, costEstimated: null, tokens: { input: 1000, cachedInput: 400, cacheWrite: null, output: 50, reasoning: 20 } },
    { provider: { provider: 'codex', transport: 'codex-app-server' } }));
  assert.match(codexDone, /<span class="result-took"> · 用时 5 秒 · 输入 1,000 · 输出 50<\/span>/); assert.doesNotMatch(codexDone, /约|\$/, 'Codex has no spend');
  const bare = resultRow(await endedRound({ status: 'completed', error: null }));
  assert.match(bare, /aria-label="已完成"/); assert.doesNotMatch(bare, /约|\$|输入|输出/, 'a result with no facts writes none');
  const cases = [['tool_deferred', 'interrupted', '已中断'], ['max_turns', 'interrupted', '已中断'], ['budget_exhausted', 'interrupted', '已中断'], ['owner', 'interrupted', '已中断'], ['api_error', 'failed', '失败']];
  for (const [reason, status, label] of cases) {
    const html = await endedRound({ status, error: mainWords[reason], terminalReason: reason === 'owner' ? null : reason, message: mainWords[reason], durationMs: 2000, costUsdMicros: null, costEstimated: true, tokens: null }), row = resultRow(html);
    assert.match(row, new RegExp(`class="result-status is-failed" role="status" aria-label="${label}"`), reason); assert.doesNotMatch(row, /aria-label="已完成"|[0-9:]+ 完成/, `${reason} is never drawn as done`);
    assert.match(row, new RegExp(`<p class="result-sub">${mainWords[reason]}</p>`), `${reason}: main’s sentence is the line under the row`); assert.match(row, /用时 2 秒/);
  }
  // A stopped round whose last step failed is still stopped; a round that failed says failed.
  const stopped = resultRow(await endedRound({ status: 'interrupted', error: mainWords.owner, message: mainWords.owner }, { extra: [ev => ev('item.upsert', { kind: 'command', status: 'failed', content: { command: 'npm test', exitCode: 1 } }, { itemId: 'k1' })], reply: false }));
  assert.match(stopped, /aria-label="已中断"/, 'the turn’s status decides, not its last step');
  // No step or reply to stand on: the sentence is a line of its own (a quiet one for a stop, an alert for a failure), not a row.
  const noneStopped = await endedRound({ status: 'interrupted', error: mainWords.max_turns, message: mainWords.max_turns }, { reply: false }), noneFailed = await endedRound({ status: 'failed', error: mainWords.api_error, message: mainWords.api_error }, { reply: false });
  assert.match(noneStopped, /<p class="reading-status" role="status">已达到本轮最大执行次数。<\/p>/); assert.doesNotMatch(noneStopped, /form-error|result-status/);
  assert.match(noneFailed, /<p class="form-error" role="alert">API 请求失败，本轮未能完成。<\/p>/);
});

test('the provider’s notice that a limit was reached is told in the conversation with its recovery time only when it gave one, and its error event is not told twice', async () => {
  const when = Date.now() + 2 * 3600_000, line = '额度不足，需要充值后继续。';
  const html = notice => viewHtml(ev => [ev('session.state', { state: 'idle', reason: null }), ev('limits.updated', { scopeId: 's', billingRoute: 'api', providerStatus: 'rejected', notice }),
    ev('error', { code: 'credits_required', message: `${line}`, retryable: false, willRetry: false, stage: 'turn' })]);
  const timed = await html({ code: 'credits_required', message: `${line}`, resetsAtMs: when });
  assert.ok(timed.includes(`<p class="reading-status" role="status">${line} · 约 ${words().clockWords(when)} 恢复</p>`)); assert.doesNotMatch(timed, /2026-11-04T|form-error/, 'no machine date, and the same limit is not said twice');
  const untimed = await html({ code: 'credits_required', message: `${line}`, resetsAtMs: null });
  assert.ok(untimed.includes(`<p class="reading-status" role="status">${line}</p>`)); assert.doesNotMatch(untimed, /恢复|服务未提供/, 'no time is guessed or written when the provider gave none');
});

test('the console button is for the one fixed billing address only, and a notice’s sentence already in the conversation is not said again', () => {
  const { consoleCheck, noticeTold } = words(), url = 'https://platform.claude.com/settings/billing', line = '服务端拒绝了这次请求：余额不足。';
  const notice = patch => ({ code: 'credits_required', message: line, resetsAtMs: null, action: 'check-console', url, ...patch });
  assert.deepEqual([consoleCheck(notice()), consoleCheck(notice({ url: 'https://example.com/settings/billing' })), consoleCheck(notice({ url: 'https://platform.claude.com/settings/billing/' })),
    consoleCheck(notice({ url: undefined })), consoleCheck(notice({ action: undefined })), consoleCheck(notice({ action: 'open' })), consoleCheck(null), consoleCheck(undefined)], [true, false, false, false, false, false, false, false]);
  assert.deepEqual([noticeTold(notice(), [null, line]), noticeTold(notice(), [`${line}\n`]), noticeTold(notice(), [null, undefined, '别的话']), noticeTold(notice(), []), noticeTold(null, [line])], [true, true, false, false, false]);
});

test('a balance rejection’s notice has one 在控制台核对 button for the fixed address, and its sentence appears once however many places carry it', async () => {
  const url = 'https://platform.claude.com/settings/billing', line = '服务端拒绝了这次请求：余额不足。', when = Date.now() + 2 * 3600_000, count = (html, part) => html.split(part).length - 1;
  const notice = patch => ({ code: 'credits_required', message: line, resetsAtMs: null, action: 'check-console', url, ...patch });
  const limits = value => ev => [ev('session.state', { state: 'idle', reason: null }), ev('limits.updated', { scopeId: 's', billingRoute: 'api', providerStatus: 'rejected', notice: value }),
    ev('error', { code: 'credits_required', message: line, retryable: false, willRetry: false, stage: 'turn' })];
  const trusted = await viewHtml(limits(notice()));
  assert.equal(count(trusted, '>在控制台核对</button>'), 1); assert.equal(count(trusted, line), 1, 'the error event and the notice are one sentence');
  assert.match(trusted, /<button type="button" class="text-button api-billing">在控制台核对<\/button>/);
  for (const other of [notice({ url: 'https://platform.claude.com.evil.example/settings/billing' }), notice({ url: undefined }), notice({ action: undefined }), notice({ code: 'rate_limited', action: undefined, url: undefined })])
    assert.doesNotMatch(await viewHtml(limits(other)), /在控制台核对/, 'any other address or action has no button');
  // The agent's own reply carries the sentence (the record's text), and the failed result card carries it too: the notice then adds only the time and the button.
  const user = ev => ev('item.upsert', { kind: 'user-message', status: 'completed', content: { text: 'go' } }, { itemId: 'u1' });
  const replied = await viewHtml(ev => [ev('session.state', { state: 'idle', reason: null }), user(ev), ev('turn.started', {}),
    ev('item.upsert', { kind: 'agent-message', status: 'completed', content: { text: line } }, { itemId: 'a1' }),
    ev('limits.updated', { scopeId: 's', billingRoute: 'api', providerStatus: 'rejected', notice: notice({ resetsAtMs: when }) })]);
  assert.equal(count(replied, line), 1, 'the reply and the notice are one sentence'); assert.equal(count(replied, '>在控制台核对</button>'), 1);
  assert.ok(replied.includes(`<p class="reading-status" role="status">约 ${words().clockWords(when)} 恢复</p>`), 'when it recovers is still told');
  const failed = await viewHtml(ev => [ev('session.state', { state: 'idle', reason: null }), user(ev), ev('turn.started', {}),
    ev('limits.updated', { scopeId: 's', billingRoute: 'api', providerStatus: 'rejected', notice: notice() }),
    ev('turn.completed', { status: 'failed', error: line, terminalReason: 'api_error', message: line })]);
  assert.equal(count(failed, line), 1, 'the result card and the notice are one sentence'); assert.equal(count(failed, '>在控制台核对</button>'), 1);
  assert.doesNotMatch(trusted + replied + failed, /check-console|credits_required|billing_error/, 'no machine code is shown');
});

test('a Codex reset the app used is an ordinary reply in words: no JSON, no outcome code, no card of its own', async () => {
  const { nativeEntries } = load('features/native-session/native-entries.ts'), { applyEvents, emptyModel } = load('features/native-session/native-model.ts'), ev = stream();
  const text = '额度已用完，已自动使用 1 次重置，还剩 2 次。', resetCredit = { status: 'consumed', outcome: 'reset', remaining: 2, confirmed: true };
  const model = applyEvents(emptyModel(), [ev('item.upsert', { kind: 'agent-message', status: 'completed', content: { text, resetCredit } }, { itemId: 'r1' })]).model;
  assert.deepEqual(nativeEntries(model).map(entry => [entry.role, entry.text]), [['assistant', text]]);
  const html = await viewHtml(e => [e('session.state', { state: 'idle', reason: null }), e('item.upsert', { kind: 'agent-message', status: 'completed', content: { text, resetCredit: { ...resetCredit, remaining: null } } }, { itemId: 'r1' })], { provider: 'codex', transport: 'codex-app-server' });
  assert.ok(html.includes(text)); assert.doesNotMatch(html, /resetCredit|nothingToReset|noCredit|alreadyRedeemed|consumed|"remaining"|\{"|\bnull\b|undefined/, 'no JSON and no machine code');
});

test('a command’s phrase comes from main and the checks it names are listed under a round that wrote files; a Claude Bash command is read from its input', async () => {
  const { nativeEntries } = load('features/native-session/native-entries.ts'), { applyEvents, emptyModel } = load('features/native-session/native-model.ts'), ev = stream();
  const model = applyEvents(emptyModel(), [
    ev('item.upsert', { kind: 'command', status: 'completed', content: { command: 'npm test', phrase: '运行测试', exitCode: 0 } }, { itemId: 'k1' }),
    ev('item.upsert', { kind: 'command', status: 'failed', content: { name: 'Bash', input: '{"command":"npx tsc --noEmit"}', phrase: '检查类型', output: 'error TS1' } }, { itemId: 'k2' }),
    ev('item.upsert', { kind: 'command', status: 'completed', content: { command: 'ls' } }, { itemId: 'k3' }),
  ]).model, by = nativeEntries(model);
  assert.deepEqual(by.map(entry => [entry.tool.target, entry.tool.phrase]), [['npm test', '运行测试'], ['npx tsc --noEmit', '检查类型'], ['ls', undefined]], 'no phrase from main, none made up here');
  const html = await endedRound({ status: 'completed', error: null }, { extra: [
    e => e('item.upsert', { kind: 'file-change', status: 'completed', content: { path: 'src/a.ts', diff: '+x' } }, { itemId: 'f1' }),
    e => e('item.upsert', { kind: 'command', status: 'completed', content: { command: 'npm test', phrase: '运行测试', exitCode: 0 } }, { itemId: 'k1' }),
    e => e('item.upsert', { kind: 'command', status: 'failed', content: { name: 'Bash', input: '{"command":"npx tsc"}', phrase: '检查类型' } }, { itemId: 'k2' })] });
  assert.match(html, /<p class="result-list-head">验证<\/p>/); assert.match(html, /运行测试<small>[\s\S]*?npm test/); assert.match(html, /检查类型<small>[\s\S]*?npx tsc/);
  assert.match(html, /<li class="is-failed">[\s\S]*?检查类型/, 'a check that failed is listed as failed');
});

test('the usage block tells the provider’s notice with its recovery time only if it gave one, and offers the console’s billing page for Claude’s API spend only', async () => {
  const line = 'API 额度不足，需要充值后继续。', when = Date.now() + 2 * 3600_000;
  const api = (claude, codex = {}) => { const value = usageOf({  }); Object.assign(value.agents.claude.limits, claude); Object.assign(value.agents.codex.limits, codex); return usageHtml({ usage: async () => ({ ok: true, value }) }); };
  const untimed = usageSection(await api({ providerStatus: 'rejected', ordinaryUsageAllowed: false, notice: { code: 'credits_required', message: line + '', resetsAtMs: null } }), 'Claude');
  assert.ok(untimed.includes('<p class="activity-note" role="status">' + line + '</p>')); assert.doesNotMatch(untimed, /恢复|服务未提供/, 'no time is written when the provider gave none');
  const timed = usageSection(await api({ providerStatus: 'rejected', notice: { code: 'rate_limited', message: 'API 请求受到限流。', resetsAtMs: when } }), 'Claude');
  assert.ok(timed.includes('API 请求受到限流。 · 约 ' + words().clockWords(when) + ' 恢复')); assert.doesNotMatch(timed, /2026-11-04T/);
  assert.doesNotMatch(usageSection(await api({ notice: null }), 'Claude'), /role="status"/, 'no notice, no line');
  // A subscription that is rejected says so from the status; with the provider’s notice the notice speaks and the status line stays quiet.
  const rejected = usageSection(await api({}, { providerStatus: 'rejected' }), 'Codex');
  assert.match(rejected, /已限流，约 [^<]+ 恢复/);
  const both = usageSection(await api({}, { providerStatus: 'rejected', notice: { code: 'rate_limited', message: 'API 请求受到限流。', resetsAtMs: null } }), 'Codex');
  assert.doesNotMatch(both, /已限流/); assert.match(both, /API 请求受到限流。/);
  // No standalone billing link under the spend (there is no spend row); the button is only beside a balance-rejection notice.
  const html = await api({}), claude = usageSection(html, 'Claude');
  assert.doesNotMatch(claude, /在控制台核对|api-billing|今日|估算/);
  assert.doesNotMatch(usageSection(html, 'Codex'), /在控制台核对/);
  const subscription = usageOf({  }); subscription.agents.claude.connection = { kind: 'subscription', source: null, observedAt: 1 };
  assert.doesNotMatch(await usageHtml({ usage: async () => ({ ok: true, value: subscription }) }), /在控制台核对/);
  assert.doesNotMatch(await usageHtml({ usage: async () => ({ ok: true, value: usageOf({  }) }) }, quietTerminal, ''), /在控制台核对/, 'without a project there is nothing to open a page through');
});

test('a balance rejection brings the console button next to its notice in the usage block, once, for the fixed address only', async () => {
  const url = 'https://platform.claude.com/settings/billing', line = '服务端拒绝了这次请求：余额不足。', count = (html, part) => html.split(part).length - 1;
  const api = claude => { const value = usageOf({}); Object.assign(value.agents.claude.limits, claude); return usageHtml({ usage: async () => ({ ok: true, value }) }); };
  const notice = patch => ({ code: 'credits_required', message: line, resetsAtMs: null, action: 'check-console', url, ...patch });
  const withBoth = usageSection(await api({ providerStatus: 'rejected', ordinaryUsageAllowed: false, notice: notice() }), 'Claude');
  assert.equal(count(withBoth, '>在控制台核对</button>'), 1, 'only the notice has the button');
  assert.ok(withBoth.indexOf(line) < withBoth.indexOf('在控制台核对'), 'it stands beside the notice that says why'); assert.equal(count(withBoth, line), 1);
  const noSpend = usageOf({ apiRecords: false }); noSpend.agents.claude.limits.notice = notice();
  const alone = usageSection(await usageHtml({ usage: async () => ({ ok: true, value: noSpend }) }), 'Claude');
  assert.equal(count(alone, '>在控制台核对</button>'), 1, 'a notice without API records still has the button');
  for (const other of [notice({ url: 'https://example.com/billing' }), notice({ url: undefined }), notice({ action: undefined })]) {
    const section = usageSection(await api({ providerStatus: 'rejected', notice: other }), 'Claude');
    assert.equal(count(section, '>在控制台核对</button>'), 0, 'no standalone button remains: an unknown address or action has none'); assert.match(section, new RegExp(line));
  }
  const none = usageOf({ apiRecords: false }); none.agents.claude.limits.notice = notice({ url: 'https://example.com/billing' });
  assert.doesNotMatch(usageSection(await usageHtml({ usage: async () => ({ ok: true, value: none }) }), 'Claude'), /在控制台核对/, 'an unknown address has no button at all');
  assert.doesNotMatch(withBoth + alone, /check-console|credits_required/, 'no machine code is shown');
});

test('the billing link opens the console page through the project and shows a refusal', async () => {
  const opened = [], previous = Object.getOwnPropertyDescriptor(globalThis, 'window'); let answer = { ok: true, value: { kind: 'external' } };
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { agentrix: { openLink: async (...args) => { opened.push(args); return answer; } } } });
  const harness = hookHarness('src/features/native-session/native-billing-link.ts', { './i18n': { t: fill }, './native-words': words(), './native-bridge.ts': load('features/native-session/native-bridge.ts') });
  try {
    const button = () => elements(harness.render('BillingLink', { projectId: 'p1' }).result).find(node => node.type === 'button');
    button().props.onClick(); await settle();
    assert.deepEqual(opened, [['p1', 'https://platform.claude.com/settings/billing']]);
    assert.equal(elements(harness.render('BillingLink', { projectId: 'p1' }).result).some(node => node.props?.role === 'alert'), false);
    answer = { ok: false, error: '打不开这个链接' }; button().props.onClick(); await settle();
    assert.equal(elements(harness.render('BillingLink', { projectId: 'p1' }).result).find(node => node.props?.role === 'alert').props.children, '打不开这个链接');
  } finally { harness.dispose(); if (previous) Object.defineProperty(globalThis, 'window', previous); else delete globalThis.window; }
});

test('a switch that worked with a warning, one restored and one stopped tell their reason in the path note; only a failed one says it did not switch', () => {
  const { applyEvents, emptyModel } = load('features/native-session/native-model.ts'), ev = stream(), store = load('features/native-session/native-store.ts');
  const entry = { model: applyEvents(emptyModel(), [ev('session.state', { state: 'idle' })]).model, dismissed: null, noteDismissed: false, handoff: null };
  const harness = hookHarness('src/features/native-session/NativePathNote.tsx', {
    '@phosphor-icons/react': new Proxy({}, { get: () => () => null }), './i18n': { t: fill }, './native-session.css': {}, './native-words': words(), './native-bridge.ts': { copyNativeText: async () => ({ ok: true }) }, './SwitchNotice': load('features/native-session/SwitchNotice.tsx'),
    './native-store.ts': { useNativeEntries: () => new Map([['t1', entry]]), terminalSwitch: store.terminalSwitch, dismissNote() {}, resolveSwitch: store.resolveSwitch, useSwitchNoteShown: () => true, dismissSwitchNote() {} },
  });
  const text = patch => { const result = harness.render('NativePathNote', { terminalId: 't1', terminalActive: false, switchState: switchState({ phase: 'stable', ...patch }) }).result; return result && elements(result).find(node => node.type === 'span')?.props.children; };
  try {
    assert.equal(text({ outcome: 'failed', reason: '终端没有启动' }), '没有切换成功，仍使用 API · 终端没有启动');
    assert.equal(text({ outcome: 'switched', reason: '旧进程没有正常退出' }), '旧进程没有正常退出'); assert.equal(text({ outcome: 'restored', reason: '已恢复到原来的会话' }), '已恢复到原来的会话');
    assert.equal(text({ outcome: 'stopped', reason: '会话已停止，没有切换' }), '会话已停止，没有切换');
    assert.equal(text({ outcome: 'switched' }), null); assert.equal(text({ reason: '终端没有启动' }), null, 'a reason without an outcome is not a failure');
  } finally { harness.dispose(); }
});

// ---- the Claude commands of the box (round r13) ---------------------------------------------------------------------------------------
const CODEX = { provider: 'codex', transport: 'codex-app-server' };
const alertOf = view => view.find(node => node.props?.role === 'alert')?.props.children;
// What was set is told by the short note (NativeToast), one at a time.
const statuses = view => view.toasts();
const ok = value => async () => ({ ok: true, value });

test('a compaction and a dropped result are lines of the conversation, and the compaction under way is told on the working line', async () => {
  const { applyEvents, emptyModel } = load('features/native-session/native-model.ts'), { nativeEntries } = load('features/native-session/native-entries.ts'), { tokenWords, sizeWords } = load('features/native-session/native-notices.ts'), ev = stream();
  assert.deepEqual([180000, 21000, 20000, 10000, 8600, 0].map(tokenWords), ['18 万', '2.1 万', '2 万', '1 万', '8600', '0'], 'ten thousand on in 万 with one decimal, ".0" dropped; below it the number');
  const i18n = load('shared/i18n.ts');
  i18n.applyLanguage('en');
  try { assert.deepEqual([180000, 21000, 20000, 12345, 10000, 8600, 0].map(tokenWords), ['180k', '21k', '20k', '12.3k', '10k', '8600', '0'], 'English counts in k'); } finally { i18n.applyLanguage('zh'); }
  assert.deepEqual([4404019, 73400320, 0].map(sizeWords), ['4.2', '70.0', '0.0']);
  const model = applyEvents(emptyModel(), [ev('session.state', { state: 'running', reason: null }), ev('turn.started', { origin: 'user', clientMessageId: null }), ev('context.compacting', { active: true })]).model;
  assert.equal(model.compacting, true);
  // Events of the sequence that follows the model's.
  const next = (type, payload, extra) => ev(type, payload, { sequence: 4, ...extra });
  const lines = events => nativeEntries(applyEvents(model, events).model).map(entry => [entry.id, entry.role, entry.text, entry.tool]);
  assert.deepEqual(lines([next('context.compacted', { trigger: 'auto', preTokens: 180000, postTokens: 20000 })]), [['notice:4', 'assistant', '上下文已压缩（自动）· 18 万 → 2 万 token', undefined]], 'a plain line of text, no step');
  assert.deepEqual(lines([next('context.compacted', { trigger: 'manual', preTokens: 180000, postTokens: null })]), [['notice:4', 'assistant', '上下文已压缩（手动）', undefined]], 'a count no event gave is not written, and no number alone');
  assert.deepEqual(lines([next('item.dropped', { reason: 'too_large', bytes: 73400320 })]), [['notice:4', 'assistant', '有一条结果太大（70.0 MB），未显示，任务继续', undefined]]);
  assert.equal(lines([next('item.dropped', { reason: 'too_large' })])[0][2], '有一条结果太大，未显示，任务继续');
  i18n.applyLanguage('en');
  try {
    assert.equal(lines([next('context.compacted', { trigger: 'auto', preTokens: 180000, postTokens: 20000 })])[0][2], 'Context compacted (automatic) · 180k → 20k tokens', 'in English: a space before the dot, and tokens');
    assert.deepEqual(load('features/native-session/native-composer.ts').fastChoices(true).map(choice => choice.description), ['On', 'Off'], 'the /fast menu says On and Off, not another button’s words');
  } finally { i18n.applyLanguage('zh'); }
  for (const end of [next('context.compacting', { active: false }), next('context.compacted', { trigger: 'auto', preTokens: null, postTokens: null }), next('turn.completed', { status: 'completed' }), next('session.state', { state: 'stopped', reason: 'user' })])
    assert.equal(applyEvents(model, [end]).model.compacting, false, end.type);
  assert.equal(applyEvents(emptyModel(), [stream()('context.compacting', { active: true }, { replay: true })]).model.compacting, false, 'a replayed compaction is over');
  const first = stream(), history = applyEvents(emptyModel(), [first('context.compacted', { trigger: 'auto', preTokens: 1, postTokens: 1 }, { replay: true })]).model;
  assert.deepEqual(nativeEntries(history).map(entry => entry.id), ['notice:1'], 'the line stays in the history');
  assert.deepEqual(applyEvents(history, [first('context.compacted', { trigger: 'auto', preTokens: 1, postTokens: 1 }, { sequence: 1 })]).model, history, 'heard again it changes nothing');
  // The line is a block of its own beside the replies and the tools (the feed merges tool steps only), and the round's result is the one it would have without it.
  const { conversationBlocks } = await import('../electron/conversation-blocks.mjs'), tail = stream();
  const round = list => nativeEntries(applyEvents(emptyModel(), [...list, tail('item.upsert', { kind: 'agent-message', status: 'completed', content: { text: 'second' } }, { itemId: 'a2' })]).model);
  assert.deepEqual(conversationBlocks(round([tail('item.upsert', { kind: 'agent-message', status: 'completed', content: { text: 'first' } }, { itemId: 'a1' }), tail('context.compacted', { trigger: 'auto', preTokens: null, postTokens: null })])).map(block => block.map(entry => entry.id)), [['a1'], ['notice:2'], ['a2']]);
  const resultOf = list => sessionView(make => [...idle(make), userMessage(make, 'c1', 'hi'), ...list(make), make('turn.completed', { status: 'completed' })], {});
  const anchor = list => { const done = resultOf(list); try { return done.decorations().anchor; } finally { done.done(); } };
  const answer = make => make('item.upsert', { kind: 'agent-message', status: 'completed', content: { text: 'done' } }, { itemId: 'a1' }), compacted = make => make('context.compacted', { trigger: 'auto', preTokens: 5, postTokens: 1 });
  assert.deepEqual([anchor(make => [answer(make)]), anchor(make => [answer(make), compacted(make)]), anchor(make => [compacted(make), answer(make)])], ['a1', 'a1', 'a1'], 'a line after the answer, or before it, does not become the round’s answer');
  assert.deepEqual([anchor(make => []), anchor(make => [compacted(make)])], [undefined, undefined], 'a round with only the line (a /compact) has no result of its own');
  const view = sessionView(make => [make('session.state', { state: 'running', reason: null }), make('context.compacting', { active: true })], {});
  try {
    assert.equal(elements(view.tree()).find(node => node.type === view.parts.WorkingLine).props.label, '正在压缩上下文');
    view.show([view.ev('session.state', { state: 'running', reason: null })]);
    assert.notEqual(elements(view.tree()).find(node => node.type === view.parts.WorkingLine).props.label, '正在压缩上下文');
  } finally { view.done(); }
});

test('/clear, /new and /reset begin a new conversation, the box shut meanwhile; a refusal keeps the old one and brings the words back', async () => {
  for (const command of ['/clear', '/new', '/reset']) {
    const calls = [], view = sessionView(idle, { newConversation: async (...args) => { calls.push(args); return { ok: true, value: { runtimeSessionId: 'rs2' } }; }, send: async () => { throw new Error('sent as a message'); } });
    try {
      view.type(command); view.press(); view.tree(); assert.equal(view.box().props.disabled, true, 'shut while the new conversation starts');
      await settle();
      assert.deepEqual([calls, view.refreshed, view.box().props.value, view.box().props.disabled], [[['t1', 'rs1']], ['t1'], '', true], `${command}: the card is asked for the new session, which replaces this view`);
      assert.deepEqual(view.prompts().prompts, [], 'nothing was sent as a message');
    } finally { view.done(); }
  }
  const sends = [], view = sessionView(idle, { newConversation: async () => ({ ok: false, error: 'busy' }), send: async (...args) => { sends.push(args); return { ok: true, value: {} }; } });
  try {
    view.type('/clear'); view.press(); await settle();
    assert.deepEqual([view.box().props.value, view.box().props.disabled, alertOf(view), view.refreshed], ['/clear', false, 'busy', []], 'the old conversation stays and the words come back');
    view.type('/clear now'); view.press(); await settle(); assert.deepEqual(sends.map(send => send[3]), ['/clear now'], 'with words after it, it is a message');
  } finally { view.done(); }
  const old = sessionView(idle, { send: async () => ({ ok: true, value: {} }) });
  try { old.type('/new'); old.press(); await settle(); assert.deepEqual([old.box().props.value, alertOf(old)], ['/new', '当前版本还不支持这个命令'], 'a main without the call refuses'); } finally { old.done(); }
  const sent = [], codex = sessionView(idle, { newConversation: ok({ runtimeSessionId: 'x' }), send: async (...args) => { sent.push(args); return { ok: true, value: {} }; } }, CODEX);
  try { codex.type('/clear'); codex.press(); await settle(); assert.deepEqual(sent, []); assert.deepEqual(codex.refreshed, ['t1'], 'Codex also starts a new conversation through main'); } finally { codex.done(); }
});

test('/model, /effort and /fast set with an argument and open a menu without one: the current value is marked, ↑↓ Enter and Esc work, a refusal brings the words back', async () => {
  const MODELS = [{ value: 'opus', displayName: 'Opus', description: 'Most capable', efforts: ['low', 'high', 'max'] }, { value: 'sonnet', displayName: 'sonnet', description: 'Balanced', efforts: ['low', 'high'] }];
  const patches = []; let now = { model: 'sonnet', effort: 'high', fast: false }, refuse = null;
  const bridge = { runOptions: async (...args) => { patches.push(args[2]); return refuse ?? { ok: true, value: (now = { ...now, ...args[2] }) }; }, models: ok(MODELS), send: async () => { throw new Error('sent as a message'); }, commands: ok([{ name: '/model', description: 'Model', source: 'builtin', view: 'reading' }]) };
  const view = sessionView(idle, bridge);
  const enter = async () => { keyIn(view, 'Enter'); await settle(); view.tree(); };
  const marked = () => options(view).map(node => [elements(node).find(child => child.type === 'code').props.children, elements(node).some(child => child.type === 'small' && child.props.children === '当前')]);
  try {
    await typeIn(view, '/model opus'); await enter();
    assert.deepEqual([patches, view.box().props.value, statuses(view)], [[{ model: 'opus' }], '', ['模型已设为 opus']], 'with an argument it is set at once and told');
    await typeIn(view, '/model default'); await enter();
    assert.deepEqual([patches.at(-1), statuses(view)], [{ model: null }, ['模型已恢复默认']], '"default" is the default model: null, not a name');
    await typeIn(view, '/effort max'); await enter(); assert.deepEqual([patches.at(-1), statuses(view)], [{ effort: 'max' }, ['思考强度已设为 max']]);
    await typeIn(view, '/fast on'); await enter(); assert.deepEqual([patches.at(-1), statuses(view)], [{ fast: true }, ['快速模式已开启']]);
    patches.length = 0; await typeIn(view, '/fast maybe'); await enter();
    assert.deepEqual([patches, view.box().props.value, alertOf(view)], [[], '/fast maybe', '用法：/fast on 或 /fast off'], 'a value /fast does not take sets nothing and keeps the words');
    now = { model: 'sonnet', effort: 'high', fast: false };
    await typeIn(view, '/model'); assert.ok(listbox(view), 'the command list is open'); await enter();
    assert.deepEqual([patches, view.box().props.value, marked()], [[{}], '', [['opus', false], ['sonnet', true]]], 'no argument: the current values are asked for (an empty patch) and the models listed, the current one marked');
    assert.equal(options(view).findIndex(node => node.props['aria-selected']), 1, 'the current one is chosen first');
    assert.equal(keyIn(view, 'ArrowUp'), 1); keyIn(view, 'Escape'); view.tree(); assert.deepEqual([listbox(view), patches.length], [undefined, 1], 'Esc closes the menu and sets nothing');
    await typeIn(view, '/model'); await enter(); await enter(); await settle();
    assert.deepEqual([patches.at(-1), listbox(view), statuses(view)], [{ model: 'sonnet' }, undefined, ['模型已设为 sonnet']], 'Enter chooses the line');
    await typeIn(view, '/effort'); await enter();
    assert.deepEqual(marked(), [['low', false], ['high', true]], 'the efforts of the model that runs');
    now = { ...now, model: null }; view.type('x'); await typeIn(view, '/effort'); await enter();
    assert.deepEqual(marked().map(line => line[0]), ['low', 'high', 'max'], 'a model not known: the efforts of every model');
    keyIn(view, 'ArrowDown'); await enter(); assert.deepEqual(patches.at(-1), { effort: 'max' }, 'the current one is chosen first and ↓ goes on from it');
    now = { model: 'sonnet', effort: 'high', fast: false }; await typeIn(view, '/fast'); await enter();
    assert.deepEqual(marked(), [['on', false], ['off', true]], '/fast is on or off');
    options(view)[0].props.onClick(); await settle(); assert.deepEqual([patches.at(-1), listbox(view)], [{ fast: true }, undefined], 'a click chooses too');
    await typeIn(view, '/fast'); await enter(); view.type('a'); assert.equal(listbox(view), undefined, 'typing leaves the menu');
    refuse = { ok: false, error: 'not now' }; await typeIn(view, '/model opus'); await enter();
    assert.deepEqual([view.box().props.value, alertOf(view)], ['/model opus', 'not now'], 'a refusal brings the words back with the reason');
    await typeIn(view, '/fast'); await enter(); assert.deepEqual([view.box().props.value, listbox(view)], ['/fast', undefined], 'and no menu opens');
  } finally { view.done(); }
  const nothing = sessionView(idle, { runOptions: ok({ model: null, effort: null, fast: false }), send: async () => ({ ok: true, value: {} }) });
  try { nothing.type('/model'); nothing.press(); await settle(); assert.deepEqual([nothing.box().props.value, alertOf(nothing)], ['/model', '当前版本还不支持这个命令'], 'a main without the model list refuses'); } finally { nothing.done(); }
  const sent = [], codex = sessionView(idle, { ...bridge, send: async (...args) => { sent.push(args); return { ok: true, value: {} }; } }, CODEX);
  refuse = null; now = { model: 'sonnet', effort: 'high', fast: false };
  try {
    codex.type('/model'); codex.press(); await settle(); codex.tree();
    assert.deepEqual(optionNames(codex), ['opus', 'sonnet'], 'Codex uses the same native model menu');
    keyIn(codex, 'Escape'); await typeIn(codex, '/model opus'); keyIn(codex, 'Enter'); await settle();
    assert.deepEqual(patches.at(-1), { model: 'opus' });
    await typeIn(codex, '/effort max'); keyIn(codex, 'Enter'); await settle(); assert.deepEqual(patches.at(-1), { effort: 'max' });
    await typeIn(codex, '/fast on'); keyIn(codex, 'Enter'); await settle(); assert.deepEqual(patches.at(-1), { fast: true });
    assert.deepEqual(sent, [], 'no model control is sent as model text');
  } finally { codex.done(); }
});

test('a line that starts with ! is a shell command: noted over the box, sent as the command without the !, kept in the history, and never a message', async () => {
  const shells = [], sends = []; let answer = { ok: true, value: { exitCode: 0 } };
  const view = sessionView(idle, { shell: async (...args) => { shells.push(args); return answer; }, send: async (...args) => { sends.push(args); return { ok: true, value: {} }; } });
  const noted = () => elements(view.tree()).some(node => node.type === 'code' && node.props.children === '!');
  try {
    assert.equal(noted(), false); view.type('ls'); assert.equal(noted(), false);
    view.type('!  ls -la '); assert.equal(noted(), true, 'the box says what the line will do');
    view.press(); await settle();
    assert.deepEqual([shells.length, shells[0].slice(0, 2), typeof shells[0][2], shells[0][3], sends, view.box().props.value], [1, ['t1', 'rs1'], 'string', 'ls -la', [], ''], 'the command is trimmed and has no "!"');
    assert.equal(noted(), false);
    view.type('!'); view.press(); view.type('!   '); view.press(); await settle();
    assert.deepEqual([shells.length, sends, view.box().props.value], [1, [], '!   '], 'a "!" alone does nothing');
    answer = { ok: false, error: 'the agent is working' }; view.type('!make'); view.press(); await settle();
    assert.deepEqual([view.box().props.value, alertOf(view), sends], ['!make', 'the agent is working', []], 'a refusal before the command ran brings the words back with main’s reason');
    // A command that ran (its card has an exit code or output) is never given back: Enter would run it again.
    const ran = sessionView(idle, { shell: async (...args) => { ran.show([...idle(ran.ev), ran.ev('item.upsert', { kind: 'command', status: 'completed', content: { command: 'make', exitCode: 0, output: 'built' } }, { itemId: `shell:${args[2]}` })]); return { ok: false, error: '命令已执行，但输出未发送给模型。' }; } });
    try {
      ran.type('!make'); ran.press(); await settle();
      assert.deepEqual([ran.box().props.value, alertOf(ran)], ['', '命令已执行，但输出未发送给模型。'], 'the words stay gone and the refusal is told');
    } finally { ran.done(); }
    view.show([...idle(view.ev), view.ev('item.upsert', { kind: 'command', status: 'completed', content: { command: 'ls -la', exitCode: 0, output: 'a' } }, { itemId: 'shell:c1' }), userMessage(view.ev, 'm1', 'hello')]);
    view.type(''); keyIn(view, 'ArrowUp'); await settle(); assert.equal(view.box().props.value, 'hello');
    keyIn(view, 'ArrowUp', { currentTarget: caretAt(0) }); assert.equal(view.box().props.value, '!ls -la', 'the line is in the history with its "!"');
  } finally { view.done(); }
  const sent = [], codex = sessionView(idle, { shell: ok({ exitCode: 0 }), send: async (...args) => { sent.push(args); return { ok: true, value: {} }; } }, CODEX);
  try {
    codex.type('!ls'); assert.equal(elements(codex.tree()).some(node => node.type === 'code' && node.props.children === '!'), true, 'Codex also explains shell input');
    codex.press(); await settle(); assert.deepEqual(sent, []);
  } finally { codex.done(); }
});

test('Codex unknown shell delivery is told without restoring an executable draft', async () => {
  const view = sessionView(idle, { shell: async (...args) => {
    view.show([...idle(view.ev), view.ev('item.upsert', { kind: 'command', status: 'unknown',
      content: { command: 'echo proof', exitCode: null, output: null, modelDelivery: 'unknown' } }, { itemId: `shell:${args[2]}` })]);
    return { ok: false, error: '执行状态未知' };
  } }, CODEX);
  try { view.type('!echo proof'); view.press(); await settle(); assert.deepEqual([view.box().props.value, alertOf(view)], ['', '执行状态未知']); }
  finally { view.done(); }
});

test('a /fast the runtime cannot do shows its reason and never says fast mode is on: typed, or chosen from the menu', async () => {
  const reason = 'Claude Agent SDK 目前不支持快速模式', patches = [];
  const view = sessionView(idle, { runOptions: async (...args) => { patches.push(args[2]); return args[2].fast === true ? { ok: false, error: reason } : { ok: true, value: { model: null, effort: null, fast: false } }; } });
  try {
    await typeIn(view, '/fast on'); keyIn(view, 'Enter'); await settle(); view.tree();
    assert.deepEqual([patches, view.box().props.value, alertOf(view), statuses(view)], [[{ fast: true }], '/fast on', reason, []], 'the words come back with the reason, and nothing is told as set');
    patches.length = 0; await typeIn(view, '/fast'); keyIn(view, 'Enter'); await settle(); view.tree();
    assert.deepEqual(optionNames(view), ['on', 'off']);
    options(view)[0].props.onClick(); await settle(); view.tree();
    assert.deepEqual([patches.at(-1), alertOf(view), statuses(view), listbox(view)], [{ fast: true }, reason, [], undefined], 'choosing 开 from the menu ends the same way');
    await typeIn(view, '/fast off'); keyIn(view, 'Enter'); await settle(); view.tree();
    assert.deepEqual([alertOf(view), statuses(view)], [undefined, ['快速模式已关闭']], 'what it can do is still told');
  } finally { view.done(); }
});

// ---- a turn that ended unknown, a "!" round, and a sentence told once (round r13) -----------------------------------------------------------
const statusLines = view => elements(view.tree()).filter(node => node.props?.role === 'status' && node.props.className === 'reading-status').map(node => node.props.children);
const answered = (make, status = 'completed', extra = {}) => [...idle(make), userMessage(make, 'c1', '/status'), make('item.upsert', { kind: 'agent-message', status: 'completed', content: { text: 'It is fine.' } }, { itemId: 'a1' }), make('turn.completed', { status, error: null, ...extra })];

test('a turn that ended unknown is told quietly: no result card with a check, no alert, and the sentence main gave', () => {
  const done = sessionView(make => answered(make), {}), unknown = sessionView(make => answered(make, 'unknown', { message: '本轮已结束，完成状态未知。' }), {}), bare = sessionView(make => answered(make, 'unknown'), {});
  try {
    assert.equal(done.decorations().anchor, 'a1', 'a completed turn has its result card');
    assert.deepEqual([unknown.decorations().anchor, !!unknown.decorations().beforeResult, !!unknown.decorations().afterResult], [undefined, false, false], 'an unknown end has no card of success');
    assert.deepEqual([statusLines(unknown), alertOf(unknown)], [['本轮已结束，完成状态未知。'], undefined], 'a quiet line, not an alert');
    assert.deepEqual([statusLines(bare), alertOf(bare)], [['本轮已结束，完成状态未知。'], undefined], 'with no sentence of its own the view says the same');
  } finally { done.done(); unknown.done(); bare.done(); }
});

test('a round a ! line drove offers no retry of the message above it, and a command whose output the model never got says so', () => {
  const { shellRound } = load('features/native-session/native-entries.ts');
  const card = (make, extra = {}) => make('item.upsert', { kind: 'command', status: 'failed', content: { command: 'false', cwd: '/work', output: 'x', exitCode: 1, ...extra } }, { itemId: 'shell:s1' });
  const asked = make => [...idle(make), userMessage(make, 'c1', 'fix it'), make('item.upsert', { kind: 'agent-message', status: 'completed', content: { text: 'Done.' } }, { itemId: 'a1' }), make('turn.completed', { status: 'completed', error: null })];
  const plain = sessionView(asked, {}), shelled = sessionView(make => [...asked(make), card(make, { modelDelivery: 'rejected' })], {});
  try {
    assert.ok(plain.decorations().afterResult, 'a round of a message has its actions');
    assert.deepEqual([!!shelled.decorations().afterResult, shellRound(shelled.feed().entries), shellRound(plain.feed().entries)], [false, true, false], 'no action under a round a "!" line drove: its retry would send the earlier message again');
    assert.match(shelled.feed().entries.find(entry => entry.id === 'shell:s1').tool.detail, /退出码 1 · 输出未发送给模型/, 'the card says the model never saw the output');
    const ok = sessionView(make => [...asked(make), card(make)], {});
    try { assert.doesNotMatch(ok.feed().entries.find(entry => entry.id === 'shell:s1').tool.detail, /输出未发送给模型/); } finally { ok.done(); }
  } finally { plain.done(); shelled.done(); }
});

test('the sentence that ends a session is told above the box once: not again in the conversation, nor by the bar of the card', () => {
  const words = 'Codex app-server 连接失败，请重试。';
  const failedWith = make => [make('session.state', { state: 'failed', reason: words }), make('error', { code: 'codex_start_failed', message: words, retryable: true, willRetry: false, stage: 'startup' })];
  const view = sessionView(failedWith, {}), other = sessionView(make => [make('session.state', { state: 'failed', reason: words }), make('error', { code: 'x', message: '另一句话', retryable: false, willRetry: false, stage: 'turn' })], {});
  try {
    assert.equal(alertOf(view), undefined, 'the conversation does not say it again');
    assert.deepEqual(elements(view.tree()).filter(node => node.props?.className === 'native-ended').flatMap(node => elements(node).filter(child => child.type === 'span').map(child => child.props.children)), [words], 'it is told with the way to a new conversation');
    assert.equal(alertOf(other)?.[0], '另一句话', 'a different sentence is still told');
    const { nativeTells } = load('features/native-session/native-store.ts'), { applyEvents, emptyModel } = load('features/native-session/native-model.ts'), ev = stream();
    const entry = { model: applyEvents(emptyModel(), failedWith(ev)).model, dismissed: null, noteDismissed: false, handoff: null };
    assert.deepEqual([nativeTells(entry, words), nativeTells(entry, '另一句话'), nativeTells(undefined, words), nativeTells({ ...entry, dismissed: 'rs1' }, words)], [true, false, false, false], 'a bar elsewhere leaves out what the view tells, and says anything else');
  } finally { view.done(); other.done(); }
});

test('a step its provider could not settle (a tool left open by a lost frame, a "!" command of uncertain result) is a question: no check, 结果未能确认, and no pass in the checks', () => {
  const { applyEvents, emptyModel } = load('features/native-session/native-model.ts'), { nativeEntries } = load('features/native-session/native-entries.ts'), { latestResult } = load('features/reading/result-round.ts'), ev = stream();
  const command = (id, status, extra = {}) => ev('item.upsert', { kind: 'command', status, content: { command: 'npm test', phrase: '运行测试', output: null, exitCode: null, ...extra } }, { itemId: id });
  const entries = nativeEntries(applyEvents(emptyModel(), [...idle(ev), userMessage(ev, 'c1', 'test it'),
    command('lost-frame', 'unknown'), command('shell:s1', 'unknown', { modelDelivery: 'unknown' }), command('known', 'completed', { exitCode: 0, output: 'ok' }), command('broken', 'failed', { exitCode: 1, output: 'no' }),
    ev('item.upsert', { kind: 'agent-message', status: 'completed', content: { text: 'Done.' } }, { itemId: 'a1' })]).model);
  const steps = entries.filter(entry => entry.tool);
  assert.deepEqual(steps.map(entry => [entry.id, entry.tool.done, entry.tool.failed, entry.tool.unconfirmed]), [['lost-frame', true, false, true], ['shell:s1', true, false, true], ['known', true, false, undefined], ['broken', true, true, undefined]],
    'unknown is neither done-and-fine nor failed; the flag is on those two only');
  assert.ok(steps.slice(0, 2).every(entry => /结果未能确认/.test(entry.tool.detail)), 'each says so on its own line'); assert.doesNotMatch(steps[2].tool.detail, /结果未能确认/);
  const result = latestResult(entries, { idle: true, interrupted: false });
  assert.deepEqual(result.checks.map(check => [check.id, check.failed, check.unconfirmed]), [['lost-frame', false, true], ['shell:s1', false, true], ['known', false, undefined], ['broken', true, undefined]]);
  assert.deepEqual(result.checks.filter(check => !check.failed && !check.unconfirmed).map(check => check.id), ['known'], 'only the command whose end was confirmed passes');
  const { ResultChecks } = load('features/reading/ResultCard.tsx'), rows = renderToStaticMarkup(React.createElement(ResultChecks, { result }));
  assert.deepEqual([rows.match(/is-unconfirmed/g)?.length, rows.match(/is-passed/g)?.length, rows.match(/is-failed/g)?.length, rows.match(/>结果未能确认</g)?.length, rows.match(/>通过</g)?.length], [2, 1, 1, 2, 1]);
  assert.deepEqual([rows.match(/data-icon="Question"/g)?.length, rows.match(/data-icon="CheckCircle"/g)?.length], [2, 1], 'a question for each, the check for the one that passed');
  const { ConversationFeed } = load('features/reading/ConversationFeed.tsx');
  const group = list => renderToStaticMarkup(React.createElement(ConversationFeed, { entries: list, agent: 'claude', projectId: 'p', live: false, hideToolOutput: true, onError() {} }));
  const only = (...ids) => group(entries.filter(entry => entry.role === 'user' || ids.includes(entry.id))), unsettled = only('lost-frame', 'shell:s1');
  assert.deepEqual([unsettled.match(/data-icon="Question"/g)?.length, /data-icon="CheckCircle"/.test(unsettled)], [1, false], 'a group of nothing but unsettled steps shows the question in its head, not the check');
  assert.match(only('known'), /data-icon="CheckCircle"/);
  assert.doesNotMatch(only('broken', 'lost-frame'), /data-icon="Question"/, 'a failure in the group is the group’s mark');
});

const costLocal = { command: 'cost', costUsdMicros: 1840000, durationMs: 60000, apiDurationMs: 30000, models: [], month: { spentMicros: null, budgetUsd: null } };
const answerOf = (agent, command) => agent === 'codex' ? statusLocal({ command }) : { context: contextLocal, cost: costLocal, status: { command: 'status', context: null, errors: [], account: { kind: 'api' }, session: {} },
  usage: { command: 'usage', month: { spentMicros: 0, budgetUsd: null }, today: { spentMicros: 0 }, tokens: {}, limits: [], notice: null } }[command];

const windowFlow = async (agent, commands) => {
  const sends = [], answers = [];
  const bridge = { send: async (...args) => { sends.push(args); return answers.shift() ?? { ok: true, value: { status: 'consumed', local: answerOf(agent, args[3].slice(1)) } }; } };
  const view = sessionView(idle, bridge, { provider: agent });
  try {
    const node = voiceBox(view, `/${commands[0]}`);
    view.press(); const loading = view.panel();
    assert.equal(view.box().props.value, '', 'the words are not kept: the query is no message'); assert.deepEqual([loading.state.state, loading.state.agent, loading.state.command], ['loading', agent, commands[0]]);
    await settle(); view.tree();
    assert.deepEqual([sends.length, sends[0][0], sends[0][3], sends[0][4]], [1, 't1', `/${commands[0]}`, undefined]);
    assert.deepEqual([view.panel().state.state, view.panel().state.panel.agent, view.panel().state.panel.command], ['ready', agent, `/${commands[0]}`]);
    assert.equal(view.prompts().prompts.length, 0, 'no sent bubble, so no thinking line and no retry for it');
    for (const command of commands.slice(1)) { view.type(`/${command}`); view.press(); await settle(); view.tree(); assert.deepEqual([sends.at(-1)[3], view.panel().state.command, view.panel().state.state], [`/${command}`, command, 'ready']); }
    answers.push({ ok: false, error: '会话正在切换，请稍后重试。' });
    view.type('/status'); view.press(); await settle(); view.tree();
    assert.deepEqual([view.panel().state.state, view.panel().state.error, view.box().props.value], ['failed', '会话正在切换，请稍后重试。', ''], 'the window tells the refusal; the words are not put back');
    answers.push({ ok: true, value: { status: 'consumed' } });
    view.type('/status'); view.press(); await settle(); view.tree();
    assert.deepEqual([view.panel().state.state, view.panel().state.error], ['failed', '这个会话没有返回状态'], 'an answer without facts is not a window of unknowns');

    // Refresh asks the same again and leaves what was typed meanwhile; closing gives the box its focus back.
    const before = sends.length; view.type('typed meanwhile'); view.panel().onRefresh(); view.tree();
    assert.deepEqual([view.panel().state.state, view.box().props.value], ['loading', 'typed meanwhile'], 'the window reads again, the box is left alone'); await settle(); view.tree();
    assert.deepEqual([sends.length - before, sends.at(-1)[3], view.panel().state.state], [1, '/status', 'ready']);
    document.activeElement = null; view.panel().onClose(true); view.tree();
    assert.deepEqual([view.panel(), document.activeElement === node], [undefined, true], 'closing removes it and the cursor is back in the box');
    view.type('/status'); view.press(); view.tree(); document.activeElement = null; view.panel().onClose(false); view.tree();
    assert.deepEqual([view.panel(), document.activeElement], [undefined, null], 'closed from the page (nothing focused, or its project hidden) it takes no focus');
    assert.equal(view.prompts().prompts.length, 0);
  } finally { document.activeElement = null; view.done(); }
};
test('codex: /status, /usage empty the box, open the window at once and fill it with the answer; no bubble, a refusal in the window, Esc gives the box its focus back', () => windowFlow('codex', ['status', 'usage']));
test('claude: /context, /cost, /status, /usage empty the box, open the window at once and fill it with the answer; no bubble, a refusal in the window, Esc gives the box its focus back', () => windowFlow('claude', ['context', 'cost', 'status', 'usage']));

test('closing the window drops an answer still on its way, and a newer query wins over an older one', async () => {
  const pending = [];
  const view = sessionView(idle, { send: (...args) => new Promise(resolve => pending.push({ args, resolve })) }, { provider: 'codex' });
  const answer = (row, command) => row.resolve({ ok: true, value: { status: 'consumed', local: statusLocal({ command }) } });
  try {
    voiceBox(view, '/status'); view.press(); view.tree();
    view.panel().onClose(); view.tree(); assert.equal(view.panel(), undefined);
    answer(pending[0], 'status'); await settle(); view.tree();
    assert.equal(view.panel(), undefined, 'a late answer does not open it again');
    view.type('/status'); view.press(); view.tree(); view.type('/usage'); view.press(); view.tree();
    answer(pending[2], 'usage'); await settle(); view.tree();
    answer(pending[1], 'status'); await settle(); view.tree();
    assert.deepEqual([view.panel().state.command, view.panel().state.state], ['usage', 'ready'], 'the older answer does not replace the newer window');
  } finally { document.activeElement = null; view.done(); }
});

test('words that are not exactly a window command stay messages: Codex with an argument, and Claude’s /context, /cost with one', async () => {
  for (const [provider, words] of [['codex', '/status now'], ['codex', '/context'], ['claude', '/context now'], ['claude', '/cost please']]) {
    const sends = [], view = sessionView(idle, { send: async (...args) => { sends.push(args); return { ok: true, value: { status: 'delivered' } }; } }, { provider });
    try {
      voiceBox(view, words); view.press(); await settle(); view.tree();
      assert.equal(sends.length, 1, `${provider} ${words}`); assert.equal(sends[0][3], words);
      assert.equal(view.panel(), undefined, `${provider} ${words}`);
      assert.equal(view.prompts().prompts.length, 1, 'it is a message of the conversation');
    } finally { document.activeElement = null; view.done(); }
  }
});

test('what a setting was changed to is a note of two seconds in the place of the panel, never a line of the conversation; a panel in its place shows no note', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const bridge = { runOptions: async (...args) => ({ ok: true, value: { model: args[2].model ?? 'sonnet', effort: args[2].effort ?? 'high', fast: false } }), send: async () => ({ ok: true, value: { status: 'consumed', local: contextLocal } }) };
  const view = sessionView(idle, bridge);
  try {
    await typeIn(view, '/model opus'); keyIn(view, 'Enter'); await settle(); view.tree();
    assert.deepEqual([view.toasts(), statusLines(view)], [['模型已设为 opus'], []], 'told by the note, in no <p> of the tail');
    t.mock.timers.tick(1999); view.tree(); assert.deepEqual(view.toasts(), ['模型已设为 opus'], 'still there just before two seconds');
    t.mock.timers.tick(1); view.tree(); assert.deepEqual(view.toasts(), [], 'gone at two seconds');
    await typeIn(view, '/effort max'); keyIn(view, 'Enter'); await settle(); view.tree(); t.mock.timers.tick(1000);
    await typeIn(view, '/effort low'); keyIn(view, 'Enter'); await settle(); view.tree();
    assert.deepEqual(view.toasts(), ['思考强度已设为 low'], 'a newer note replaces the older');
    t.mock.timers.tick(1000); view.tree(); assert.deepEqual(view.toasts(), ['思考强度已设为 low'], 'and has its own two seconds');
    view.type('x'); assert.deepEqual(view.toasts(), [], 'the owner typing again clears it');
    await typeIn(view, '/effort max'); keyIn(view, 'Enter'); await settle(); view.tree(); assert.equal(view.toasts().length, 1);
    view.type('/context'); view.press(); await settle(); view.tree();
    assert.deepEqual([view.toasts(), view.panel().state.state], [[], 'ready'], 'a panel and a note are never both there');
  } finally { view.done(); }
});
