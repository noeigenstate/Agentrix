const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { readCss, assertRule } = require('./helpers/css-rules.cjs');
const { importsOf, usesWindowMember } = require('./helpers/source-structure.cjs');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

// The dashboard page, tested without Electron: pure modules, the store against a stubbed bridge, the page rendered to markup
// from fixture summaries, and the stylesheet read as text. Source files are transpiled the way the other UI tests do it.
const root = path.join(__dirname, '..');
const src = path.join(root, 'src');
const dashboardDir = path.join(src, 'features', 'dashboard');

function makeLoader(overrides = {}) {
  const cache = new Map();
  const resolve = (from, name) => [name, `${name}.ts`, `${name}.tsx`, `${name}.json`].map(candidate => path.resolve(path.dirname(from), candidate)).find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
  function load(filename) {
    if (cache.has(filename)) return cache.get(filename).exports;
    if (filename.endsWith('.json')) return JSON.parse(fs.readFileSync(filename, 'utf8'));
    const mod = new Module(filename, module);
    mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename));
    cache.set(filename, mod);
    const original = mod.require.bind(mod);
    mod.require = name => {
      if (name in overrides) return overrides[name];
      if (name.endsWith('.css')) return {};
      if (name === '@phosphor-icons/react') return new Proxy({}, { get: () => () => null });
      return name.startsWith('.') ? load(resolve(filename, name)) : original(name);
    };
    mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename);
    return mod.exports;
  }
  return relative => load(path.join(src, relative));
}

const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
before(() => { Object.defineProperty(globalThis, 'document', { configurable: true, value: { documentElement: { dataset: {}, lang: '' } } }); });
after(() => { if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument); else delete globalThis.document; });

const load = makeLoader();
const dashboard = name => load(`features/dashboard/${name}`);
const { applyLanguage } = load('shared/i18n.ts');
const zh = (run) => { applyLanguage('zh'); return run(); };

// ---- fixtures ------------------------------------------------------------------------------------------------------------
const at = (month, day, hour = 10) => new Date(2026, month - 1, day, hour).getTime();
const outcomes = ([passed, failed, untested, unfinished], small = false) => {
  const tasks = passed + failed + untested + unfinished;
  return { tasks, passed, failed, untested, unfinished, passRate: passed / tasks, small };
};
const row = (model, agent, counts, small) => ({ model, agent, ...outcomes(counts, small) });
const cell = (kind, model, counts, small) => ({ kind, model, ...outcomes(counts, small) });
const point = (bucket, model, tasks, passed) => ({ bucket, model, tasks, passed, passRate: passed / tasks });
function fixture(patch = {}) {
  return {
    generatedAt: at(10, 31, 14), query: { projectId: null, range: '30d' },
    projects: [{ id: 'p1', name: 'agentrix' }, { id: 'p2', name: 'site' }], minTasks: 5,
    models: [row('claude-opus-5-5', 'claude', [8, 1, 1, 0]), row('gpt-6.1-sol', 'codex', [5, 2, 1, 2]), row('gemini-3.8-flash', 'agy', [2, 0, 0, 0], true)],
    kinds: [cell('core', 'claude-opus-5-5', [6, 0, 1, 0]), cell('core', 'gpt-6.1-sol', [3, 1, 1, 1]), cell('frontend', 'gpt-6.1-sol', [2, 1, 0, 1], true),
      cell('unreported', 'gemini-3.8-flash', [2, 0, 0, 0], true), cell('frontend', 'claude-opus-5-5', [2, 1, 0, 0], true)],
    trend: { unit: 'day', buckets: ['2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31'], points: [
      point('2026-10-28', 'claude-opus-5-5', 4, 3), point('2026-10-29', 'claude-opus-5-5', 3, 3), point('2026-10-31', 'claude-opus-5-5', 3, 2),
      point('2026-10-28', 'gpt-6.1-sol', 5, 2), point('2026-10-30', 'gpt-6.1-sol', 5, 3), point('2026-10-31', 'gemini-3.8-flash', 2, 2)] },
    ...patch,
  };
}
const emptySummary = () => fixture({ models: [], kinds: [], trend: { unit: 'day', buckets: ['2026-10-31'], points: [] } });
const view = (props = {}) => {
  const { DashboardView } = dashboard('Dashboard.tsx');
  return renderToStaticMarkup(React.createElement(DashboardView, { summary: fixture(), query: { projectId: null, range: '30d' }, error: null, named: true,
    onQuery() {}, actions: { minimize() {}, maximize() {}, close() {} }, ...props }));
};
const count = (html, pattern) => (html.match(pattern) ?? []).length;
const panel = (html, title) => html.split('<section class="panel">').find(part => part.startsWith(`<h2>${title}`)) ?? '';
const rows = html => html.split('<li class="rel-row').slice(1).map(part => part.slice(0, part.indexOf('</li>')));

// ---- pure parts ---------------------------------------------------------------------------------------------------------
test('a bar has the four outcomes in a fixed order, each a share of the tasks', () => {
  const { shares, OUTCOMES } = dashboard('chart-math.ts');
  assert.deepEqual(OUTCOMES, ['passed', 'failed', 'untested', 'unfinished']);
  assert.deepEqual(shares(outcomes([5, 2, 1, 2])).map(part => [part.outcome, part.count, part.share]),
    [['passed', 5, 0.5], ['failed', 2, 0.2], ['untested', 1, 0.1], ['unfinished', 2, 0.2]]);
});

test('trend series line up with the buckets, leave a gap where a model had no task and drop a model with none', () => {
  const { trendSeries, runs } = dashboard('chart-math.ts'), { trend } = fixture();
  const series = trendSeries(trend, ['claude-opus-5-5', 'gpt-6.1-sol', 'mystery']);
  assert.deepEqual(series.map(line => line.model), ['claude-opus-5-5', 'gpt-6.1-sol']);
  assert.deepEqual(series[1].cells.map(value => value && value.passRate), [0.4, null, 0.6, null]);
  assert.deepEqual(runs(series[1].cells.map(value => value && value.passRate)), [[0], [2]], 'no line is drawn across a bucket without tasks');
});

test('kind rows keep the usual kind order with untyped tasks last', () => {
  const { kindRows } = dashboard('chart-math.ts');
  assert.deepEqual(kindRows(fixture().kinds).map(entry => entry.kind), ['core', 'frontend', 'unreported']);
  assert.deepEqual(Object.keys(kindRows(fixture().kinds)[1].cells).sort(), ['claude-opus-5-5', 'gpt-6.1-sol']);
});

test('models are named by the shared naming, for all three CLIs, and kinds in the owner’s words', () => zh(() => {
  const f = dashboard('format.ts');
  assert.deepEqual(['claude-opus-5-5', 'gpt-6.1-sol', 'gemini-3.8-flash', 'unreported', 'agy:unreported'].map(f.modelTitle),
    ['Opus 5.5', 'GPT-6.1-Sol', 'gemini-3.8-flash', '模型未确认', 'agy · 模型未确认']);
  assert.deepEqual(['core', 'unreported', 'custom'].map(f.kindLabel), ['复杂代码', '未分类', 'custom']);
  assert.deepEqual([f.percent(0.875), f.percent(null), f.rangeName('7d'), f.dayLabel('2026-10-31')], ['88%', '—', '近 7 天', '10-31']);
}));

// ---- the page --------------------------------------------------------------------------------------------------------------
test('one page with three charts top to bottom and only the project and time-range filters', () => zh(() => {
  const html = view();
  assert.deepEqual([...html.matchAll(/<section class="panel"><h2>([^<]+)/g)].map(match => match[1]), ['可靠性总览', '可靠性走势', '模型 × 任务类型']);
  assert.equal(count(html, /role="group"/g), 1, 'the range buttons are the only button group: no tabs');
  assert.equal(count(html, /aria-pressed=/g), 3);
  assert.match(html, /aria-pressed="true"[^>]*>30 天</);
  assert.match(html, /aria-label="项目"/);
  for (const gone of ['模型评估', '协作报告', '成本', '输出速度', '份额', '事故', '审查发现', '改进建议', '正在运行', '刷新']) assert.doesNotMatch(html, new RegExp(gone));
}));

test('the overview ranks models by reliability with a large pass rate, an outcome bar in words and the task count', () => zh(() => {
  const html = panel(view(), '可靠性总览'), list = rows(html);
  assert.match(html, /通过率 = 测试通过的任务 ÷ 全部任务/);
  assert.deepEqual(list.map(part => /class="name" title="([^"]+)"/.exec(part)[1]), ['Opus 5.5', 'GPT-6.1-Sol', 'gemini-3.8-flash']);
  assert.deepEqual(list.map(part => /class="rate">([^<]+)/.exec(part)[1]), ['80%', '50%', '100%']);
  assert.deepEqual(list.map(part => /class="tasks">([^<]+)/.exec(part)[1]), ['10 次任务', '10 次任务', '2 次任务']);
  assert.deepEqual([...list[1].matchAll(/class="seg (\w+)" style="width:([\d.]+)%"/g)].map(match => [match[1], Number(match[2])]),
    [['passed', 50], ['failed', 20], ['untested', 10], ['unfinished', 20]]);
  assert.match(list[1], /aria-label="GPT-6.1-Sol：测试通过 5 · 测试失败 2 · 没有测试 1 · 没做完 2"/);
  assert.match(list[1], /测试通过 5<\/span>.*测试失败 2<\/span>.*没有测试 1<\/span>.*没做完 2<\/span>/);
  assert.doesNotMatch(list[0], /class="seg unfinished"/, 'an outcome with no tasks takes no part of the bar');
  for (const word of ['测试通过', '测试失败', '没有测试', '没做完']) assert.match(html, new RegExp(`<i class="swatch \\w+" aria-hidden="true"></i>${word}`));
}));

test('a small sample comes last under a caption, reads weaker and is never ranked above enough tasks', () => zh(() => {
  const html = panel(view(), '可靠性总览');
  assert.match(html, /<li class="rel-caption">样本少：任务不到 5 次，不参与排名<\/li><li class="rel-row is-small">/);
  assert.equal(count(html, /class="rel-row is-small"/g), 1);
  assert.ok(html.indexOf('rel-caption') > html.indexOf('GPT-6.1-Sol'), 'the 100% of two tasks sits below the ranked models');
  assert.doesNotMatch(panel(view({ summary: fixture({ models: fixture().models.slice(0, 2) }) }), '可靠性总览'), /rel-caption/);
}));

test('the page says that a pass is the role’s own check, not an independent test', () => zh(() => {
  assert.match(panel(view(), '可靠性总览'), /「测试通过」来自角色交回时自己报告的检查（自测）；记录里还没有能对应到具体任务的独立测试结论。/);
}));

test('the trend draws a line per model with gaps, a text alternative, end labels and a data table with dashes for no tasks', () => zh(() => {
  const html = panel(view(), '可靠性走势');
  assert.match(html, /每天的测试通过率，按截至当天的 7 天计算/);
  assert.match(html, /role="img" aria-label="每个模型的测试通过率走势，数据见下方数据表"/);
  assert.equal(count(html, /<polyline class="line"/g), 1, 'Opus has one run of three days; Sol and Gemini have lone points');
  assert.match(html, /<text class="end"[^>]*>Opus 5.5 67%<\/text>/); assert.match(html, /<text class="end"[^>]*>GPT-6.1-Sol 60%<\/text>/);
  for (const label of ['0%', '50%', '100%']) assert.match(html, new RegExp(`>${label}</text>`));
  assert.match(html, /<td>10-29<\/td><td class="num">100% · 3 次任务<\/td><td class="num muted">—<\/td>/);
  assert.match(panel(view({ summary: fixture({ trend: { ...fixture().trend, unit: 'week' } }) }), '可靠性走势'), /每周的测试通过率[\s\S]*周（新到旧）/);
}));

test('the model × kind table gives each cell its rate and task count, weakens small samples and dashes a pair with no tasks', () => zh(() => {
  const html = panel(view(), '模型 × 任务类型');
  assert.deepEqual([...html.matchAll(/<tr><td>([^<]+)<\/td>/g)].map(match => match[1]), ['复杂代码', '前端', '未分类']);
  assert.match(html, /<td class="num kind-cell"><span class="kind-value"><b>86%<\/b><small>7 次任务<\/small><\/span><i class="kind-bar" aria-hidden="true"><b style="width:85\.\d+%"><\/b><\/i><\/td>/);
  assert.match(html, /<td class="num kind-cell is-small" title="样本少">/);
  assert.match(html, /<td class="num muted" title="没有任务">—<\/td>/);
}));

test('without tasks every chart says so in one sentence and draws no axes or tables', () => zh(() => {
  const html = view({ summary: emptySummary() });
  assert.match(panel(html, '可靠性总览'), /<p class="empty">这段时间没有派发给角色的任务。<\/p>/);
  assert.match(panel(html, '可靠性走势'), /<p class="empty">这段时间没有任务，画不出走势。<\/p>/);
  assert.match(panel(html, '模型 × 任务类型'), /<p class="empty">这段时间没有任务，无法按类型比较。<\/p>/);
  assert.doesNotMatch(html, /<svg class="chart|<table/);
}));

test('the title bar has the window buttons and the page says what is wrong and what is loading', () => zh(() => {
  const html = view();
  assert.match(html, /class="titlebar"/); assert.equal(count(html, /class="icon-button/g), 3); assert.match(html, /aria-label="关闭窗口"/);
  assert.match(html, /<span class="dash-note" role="status">近 30 天 · 全部项目<\/span>/);
  assert.match(view({ summary: null }), /正在读取…/);
  assert.doesNotMatch(view({ summary: null, error: 'boom' }), /正在读取/);
  assert.match(view({ error: 'boom' }), /role="alert">读取数据失败：boom<\/p>/);
  assert.match(view({ summary: null, named: false }), /<span class="dash-title"><\/span>/, 'no title before the language is known');
}));

test('every scrolling table sits in a labelled, keyboard-focusable region', () => zh(() => {
  const html = view(), regions = count(html, /<div class="scroll[^"]*"/g);
  assert.equal(regions, 2);
  assert.equal(count(html, /<div class="scroll[^"]*" role="region" aria-label="[^"]+" tabindex="0"/g), regions);
}));

test('English mode writes the same page in English', () => {
  try {
    applyLanguage('en');
    const html = view();
    assert.doesNotMatch(html, /[一-鿿]/, 'no Chinese is left on the page');
    assert.doesNotMatch(view({ summary: emptySummary() }), /[一-鿿]/, 'nor in the empty states');
    assert.equal(document.documentElement.lang, 'en');
  } finally { applyLanguage('zh'); }
});

test('every model keeps one colour and one shape for the whole page, whichever models are shown', () => {
  const m = dashboard('chart-math.ts'), ids = ['gpt-6.1-luna', 'claude-haiku-5-5', 'gpt-6.1-terra', 'gpt-6.1-sol', 'claude-sonnet-5-5', 'claude-opus-5-5'];
  const all = m.modelLooks(ids);
  assert.deepEqual(['claude-opus-5-5', 'claude-sonnet-5-5', 'gpt-6.1-sol', 'gpt-6.1-terra', 'claude-haiku-5-5', 'gpt-6.1-luna'].map(id => [all.get(id).colour, all.get(id).shape]),
    [[0, 'circle'], [1, 'square'], [2, 'diamond'], [3, 'triangle'], [4, 'inverted'], [5, 'hexagon']], 'the six models told apart so far keep the slots they always had');
  assert.deepEqual(m.modelLooks(['gpt-6.1-sol']).get('gpt-6.1-sol'), all.get('gpt-6.1-sol'), 'a filter that leaves fewer models does not repaint the others');
  assert.equal(m.PALETTE, 6); assert.equal(new Set(m.SHAPES).size, 6);
});

test('an alias is the same model as its full id, and what the records do not name is grey outside the palette', () => {
  const m = dashboard('chart-math.ts'), looks = m.modelLooks(['sonnet', 'claude-sonnet-5-5', 'gpt-6.1-sol', 'unreported', 'opus']);
  assert.deepEqual(looks.get('sonnet'), looks.get('claude-sonnet-5-5'), 'one colour and one shape for one model');
  assert.equal(looks.get('opus').slot, 0, 'an alias with no full id on the page takes the slot the model always had');
  assert.equal(looks.get('unreported'), m.NEUTRAL); assert.equal(m.NEUTRAL.neutral, true);
  assert.ok(![...looks.entries()].some(([model, look]) => model !== 'unreported' && look.slot < 0), 'no model takes the neutral slot');
  assert.deepEqual(m.modelLooks(['unreported', 'claude-opus-5-5']).get('claude-opus-5-5').slot, 0, 'it takes no palette slot from a model');
});

test('a model past the six takes a free slot, and no two models share both colour and shape', () => {
  const m = dashboard('chart-math.ts');
  const looks = m.modelLooks(['zeta', 'alpha', 'gpt-6.1-sol', 'claude-opus-5-5', 'claude-opus-5-6']);
  assert.deepEqual([looks.get('gpt-6.1-sol').slot, looks.get('claude-opus-5-5').slot], [2, 0]);
  assert.deepEqual(['alpha', 'claude-opus-5-6', 'zeta'].map(id => looks.get(id).slot), [6, 7, 8], 'the second Opus and models the page never met follow in name order');
  const pairs = new Set([...looks.values()].map(look => `${look.colour}/${look.shape}`));
  assert.equal(pairs.size, looks.size);
  assert.equal(new Set(Array.from({ length: 36 }, (_, slot) => { const look = m.lookOf(slot); return `${look.colour}/${look.shape}`; })).size, 36, 'colour repeats past six, but with another shape');
});

// ---- the store -----------------------------------------------------------------------------------------------------------------
function stubBridge(extra = {}) {
  const calls = [], changed = new Set(), appearance = new Set(), off = [];
  const answer = (query, tag = 'summary') => ({ ok: true, value: { ...fixture(), query, tag } });
  const bridge = {
    calls, off, fireChanged: () => changed.forEach(callback => callback()), pushAppearance: value => appearance.forEach(callback => callback(value)),
    async summary(query) { calls.push(['summary', query]); return answer(query); },
    async appearance() { calls.push(['appearance']); return { ok: true, value: { theme: 'light', language: 'zh', uiZoom: 1 } }; },
    onAppearance(callback) { appearance.add(callback); return () => { off.push('appearance'); appearance.delete(callback); }; },
    onChanged(callback) { changed.add(callback); return () => { off.push('changed'); changed.delete(callback); }; },
    close() {}, minimize() {}, maximize() {}, ...extra,
  };
  return bridge;
}
const settle = () => new Promise(resolve => setImmediate(resolve));
const newStore = bridge => dashboard('dashboard-store.ts').createDashboardStore(bridge);

test('the store reads the appearance and the default summary on start and follows the owner’s choices', async () => {
  const bridge = stubBridge(), store = newStore(bridge);
  assert.equal(store.getState().summary, null);
  store.start(); await settle();
  assert.deepEqual(bridge.calls.map(call => call[0]).sort(), ['appearance', 'summary']);
  assert.deepEqual(bridge.calls.find(call => call[0] === 'summary')[1], { projectId: null, range: '30d' });
  assert.equal(store.getState().appearance.theme, 'light'); assert.equal(store.getState().summary.tag, 'summary');
  store.setQuery({ range: '7d' }); await settle();
  store.setQuery({ projectId: 'p2' }); await settle();
  assert.deepEqual(bridge.calls.filter(call => call[0] === 'summary').map(call => call[1]), [{ projectId: null, range: '30d' }, { projectId: null, range: '7d' }, { projectId: 'p2', range: '7d' }], 'each change keeps the other filter');
  assert.deepEqual(store.getState().query, { projectId: 'p2', range: '7d' });
  bridge.fireChanged(); await settle();
  assert.deepEqual(bridge.calls.at(-1), ['summary', { projectId: 'p2', range: '7d' }], 'new records re-read the current query');
});

test('a read in flight is loading and a failed read stops loading', async () => {
  const pending = [], bridge = stubBridge({ summary: query => new Promise(resolve => pending.push(() => resolve({ ok: true, value: { ...fixture(), query } }))) });
  const store = newStore(bridge);
  assert.equal(store.getState().loading, false);
  store.start(); assert.equal(store.getState().loading, true);
  pending[0](); await settle(); assert.equal(store.getState().loading, false);
  assert.equal('refresh' in store, false, 'the page reads again on its own each minute; there is no refresh button');
  const failing = newStore(stubBridge({ summary: async () => ({ ok: false, error: 'boom' }) }));
  failing.start(); await settle();
  assert.deepEqual([failing.getState().loading, failing.getState().error], [false, 'boom']);
});

test('subscribers hear every change and stop hearing when they leave', async () => {
  const bridge = stubBridge(), store = newStore(bridge), heard = [];
  const leave = store.subscribe(() => heard.push(store.getState().query.range));
  store.start(); await settle();
  const before = heard.length; assert.ok(before >= 2);
  leave(); store.setQuery({ range: 'all' }); await settle();
  assert.equal(heard.length, before);
});

test('a slow answer to an earlier query never replaces the answer to a later one', async () => {
  const pending = [];
  const bridge = stubBridge({ summary: query => new Promise(resolve => pending.push(() => resolve({ ok: true, value: { ...fixture(), query } }))) });
  const store = newStore(bridge);
  store.start(); store.setQuery({ range: '7d' });
  assert.equal(pending.length, 2);
  pending[1](); await settle(); pending[0](); await settle();
  assert.equal(store.getState().summary.query.range, '7d');
});

test('a failed read keeps the last summary and says why; the next good read clears it', async () => {
  let fail = false;
  const bridge = stubBridge({ summary: async query => fail ? { ok: false, error: 'boom' } : { ok: true, value: { ...fixture(), query } } });
  const store = newStore(bridge);
  store.start(); await settle();
  fail = true; bridge.fireChanged(); await settle();
  assert.equal(store.getState().error, 'boom'); assert.ok(store.getState().summary);
  fail = false; bridge.fireChanged(); await settle();
  assert.equal(store.getState().error, null);
  const thrown = newStore(stubBridge({ summary: async () => { throw new Error('ipc closed'); } }));
  thrown.start(); await settle();
  assert.equal(thrown.getState().error, 'ipc closed');
});

test('an appearance pushed by the main window is not overwritten by the first read, and stop() lets go of everything', async () => {
  const bridge = stubBridge({ appearance: () => new Promise(resolve => setTimeout(() => resolve({ ok: true, value: { theme: 'mono', language: 'en', uiZoom: 1 } }), 5)) });
  const store = newStore(bridge);
  store.start(); bridge.pushAppearance({ theme: 'light', language: 'zh', uiZoom: 1 });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(store.getState().appearance.theme, 'light');
  const shown = store.getState().summary;
  store.stop(); bridge.fireChanged(); bridge.pushAppearance({ theme: 'mono', language: 'en', uiZoom: 1 }); await settle();
  assert.deepEqual(bridge.off.sort(), ['appearance', 'changed']);
  assert.equal(store.getState().summary, shown); assert.equal(store.getState().appearance.theme, 'light');
});

// ---- the menu entry, with hooks stood in so a click can be driven -----------------------------------
function hooks(initial = {}) {
  const slots = [];
  let index = 0;
  const api = {
    ...React,
    useState(start) { const slot = index++; if (!(slot in slots)) slots[slot] = slot in initial ? initial[slot] : typeof start === 'function' ? start() : start; return [slots[slot], value => { slots[slot] = typeof value === 'function' ? value(slots[slot]) : value; }]; },
    useRef(start) { const slot = index++; slots[slot] ??= { current: start }; return slots[slot]; },
    useEffect() {}, useLayoutEffect() {}, useContext: context => context._currentValue,
  };
  return { api, slots, render(run) { index = 0; return run(); } };
}
const elements = node => Array.isArray(node) ? node.flatMap(elements) : React.isValidElement(node) ? [node, ...elements(node.props.children)] : [];
const text = node => Array.isArray(node) ? node.map(text).join('') : typeof node === 'string' ? node : React.isValidElement(node) ? text(node.props.children) : '';

test('the app menu puts 设置 last with or without an update and closes before opening 数据看板', async () => {
  const h = hooks({ 0: { left: 0, top: 0 } }), logged = [], previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window'), original = console.error;
  const opened = [], labOpened = [];
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { agentrix: {
    openDashboard: () => { opened.push(h.slots[0]); return Promise.resolve(opened.length === 1 ? { ok: true, value: undefined } : { ok: false, error: 'no window' }); },
    openLab: () => { labOpened.push(h.slots[0]); return Promise.resolve({ ok: true, value: undefined }); },
  } } });
  console.error = (...args) => logged.push(args.join(' '));
  try {
    const loader = makeLoader({ react: h.api, 'react-dom': { createPortal: node => node }, '../shortcuts/shortcuts': { shortcut: () => '' } }), { AppMenu } = loader('features/titlebar/AppMenu.tsx');
    loader('shared/i18n.ts').applyLanguage('zh');
    const props = { fullScreen: false, canReturn: true, updateReady: true, onAddProject() {}, onReturn() {}, onFullScreen() {}, onSettings() {}, onInstallUpdate() {} };
    const items = (updateReady = props.updateReady) => elements(h.render(() => AppMenu({ ...props, updateReady }))).filter(node => node.props.label !== undefined);
    const labels = ['新建项目', '返回项目', '全屏', '虚拟实验室', '数据看板'];
    assert.deepEqual(items(false).map(node => node.props.label), [...labels, '设置']);
    assert.deepEqual(items().map(node => node.props.label), [...labels, '重启并安装更新', '设置']);
    const entry = () => items().find(node => node.props.label === '数据看板');
    h.slots[0] = { left: 0, top: 0 }; entry().props.onSelect(); await settle();
    assert.deepEqual(opened, [null], 'the menu was already closed when the dashboard was asked to open');
    assert.deepEqual(logged, [], 'opening succeeded: nothing to report');
    h.slots[0] = { left: 0, top: 0 }; entry().props.onSelect(); await settle();
    assert.deepEqual(logged, ['no window'], 'a failure only goes to the console');
    h.slots[0] = { left: 0, top: 0 }; items().find(node => node.props.label === '虚拟实验室').props.onSelect(); await settle();
    assert.deepEqual(labOpened, [null], 'the menu is also closed before the lab opens');
    assert.deepEqual(logged, ['no window'], 'opening the lab succeeded');
  } finally {
    console.error = original;
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow); else delete globalThis.window;
  }
});

// ---- build and style rules ----------------------------------------------------------------------------------------------------
test('the dashboard CSP allows its own assets and dev socket without external images or embedded pages', () => {
  const policy = file => /Content-Security-Policy" content="([^"]+)"/.exec(fs.readFileSync(path.join(root, file), 'utf8'))?.[1];
  assert.equal(policy('dashboard.html'), "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; font-src 'self'; connect-src 'self' ws://127.0.0.1:5178; object-src 'none'; base-uri 'none'; frame-src 'none'");
  const html = fs.readFileSync(path.join(root, 'dashboard.html'), 'utf8');
  assert.match(html, /<script type="module" src="\/src\/features\/dashboard\/main\.tsx"><\/script>/); assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/, 'no inline script');
  const config = fs.readFileSync(path.join(root, 'vite.config.ts'), 'utf8');
  assert.match(config, /input: \{ main: 'index\.html', dashboard: 'dashboard\.html', lab: 'lab\.html' \}/); assert.match(config, /entries: \['index\.html', 'dashboard\.html', 'lab\.html'\]/);
});

test('the dashboard stylesheet keeps the product scale and takes every colour from the theme tokens but the model series', () => {
  const css = readCss('src/features/dashboard/dashboard.css');
  const declarations = css.declarations;
  const off = [], scale = new Set([0, 2, 4, 8, 12, 16, 24, 32]);
  for (const { selector, property: name, value } of declarations) {
    if (/^(padding|margin|gap|row-gap|column-gap)(-|$)/.test(name)) for (const [, px] of value.matchAll(/(\d+(?:\.\d+)?)px/g)) if (!scale.has(Number(px))) off.push(`${selector} { ${name}: ${value} }`);
  }
  assert.deepEqual(off, [], 'spacing is 2/4/8/12/16/24/32');
  const sizes = new Set(), weights = new Set(), radii = new Set();
  for (const { property: name, value } of declarations) {
    if (name === 'font-size') sizes.add(value);
    if (name === 'font-weight') weights.add(value);
    if (name === 'font') { sizes.add(/(\d+)px/.exec(value)?.[1] + 'px'); weights.add(/^(\d+)/.exec(value)?.[1]); }
    if (name === 'border-radius') radii.add(value);
  }
  assert.deepEqual([...sizes].sort(), ['12px', '13px', '14px', '20px']); assert.deepEqual([...weights].sort(), ['400', '600']);
  assert.deepEqual([...radii].sort(), ['12px', '8px']);
  const literal = declarations.filter(({ property, value }) => /#[0-9a-f]{3,8}\b/i.test(value) && !/^--m-[0-5]$/.test(property));
  assert.deepEqual(literal, [], 'colours come from the theme tokens; only the six model colours are literal');
  assertRule(css, '.dash', { '--m-0': '#3987e5', '--m-1': '#d95926', '--m-2': '#199e70', '--m-3': '#c98500', '--m-4': '#d55181', '--m-5': '#9085e9' });
  assertRule(css, ':root[data-theme="light"] .dash', { '--m-0': '#2a78d6', '--m-1': '#eb6834', '--m-2': '#1baf7a', '--m-3': '#eda100', '--m-4': '#e87ba4', '--m-5': '#6250d6' });
  assertRule(css, ':is(.swatch, .seg).passed', { background: 'var(--success)' });
  assertRule(css, ':is(.swatch, .seg).failed', { background: 'var(--danger)' });
  assertRule(css, ':is(.swatch, .seg).untested', { border: '1px solid var(--text-3)' }, 'untested is hollow');
  assert.match(css.rule(':is(.swatch, .seg).unfinished').background, /^repeating-linear-gradient\(135deg, var\(--text-3\)/, 'unfinished is hatched');
  assertRule(css, 'details.data summary', { height: '32px' }, 'the data-table toggle is a 32px control');
  assertRule(readCss('src/shared/styles/styles.css'), '.button', { height: '32px' });
});

test('the model colours hold 3:1 on the dark card, and on white the three that do not are always paired with a mark and a name', () => {
  const css = readCss('src/features/dashboard/dashboard.css');
  const luminance = hex => { const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const ratio = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
  const dark = css.rule('.dash'), light = css.rule(':root[data-theme="light"] .dash');
  for (let slot = 0; slot < 6; slot++) assert.ok(ratio(dark[`--m-${slot}`], '#262626') >= 3, `dark model colour ${slot} on the card`);
  assert.deepEqual([0, 1, 2, 3, 4, 5].filter(slot => ratio(light[`--m-${slot}`], '#ffffff') < 3), [2, 3, 4]);
});

test('the page reads only the dashboard bridge and never the main window’s', () => {
  const files = fs.readdirSync(dashboardDir).filter(name => /\.tsx?$/.test(name)).map(name => 'src/features/dashboard/' + name);
  assert.deepEqual(files.filter(file => usesWindowMember(file, 'agentrix')), []);
  const imports = files.flatMap(importsOf).filter(specifier => specifier.startsWith('../'));
  assert.deepEqual([...new Set(imports.filter(spec => !spec.startsWith('../../shared/')))], [], 'only src/shared is imported from outside the feature');
});

test('a table the region cuts through hides the cut columns until they are whole in view: nothing half-shown beside the pinned column or at the right edge', () => {
  // A region 400 wide from x = 0 with a pinned first column of 100 and five more of 100 each; the scroll moves everything but the pinned column.
  const { hideCutColumns } = dashboard('ScrollRegion.tsx'), classes = new Set();
  const cell = (index, scrolled) => {
    const left = index === 0 ? 0 : 100 * index - scrolled, right = left + 100;
    return { getBoundingClientRect: () => ({ left, right, width: 100 }), classList: { toggle: (name, on) => on ? classes.add(`${name}:${index}`) : classes.delete(`${name}:${index}`) } };
  };
  const cut = scrolled => {
    const row = () => ({ children: [0, 1, 2, 3, 4, 5].map(index => cell(index, scrolled)) }), head = row(), body = row();
    classes.clear();
    hideCutColumns({ clientWidth: 400, getBoundingClientRect: () => ({ left: 0 }), querySelectorAll: selector => selector === '.sticky th' ? head.children : [head, body] });
    return [...classes].map(entry => entry.split(':')[1]).sort().filter((index, at, all) => all.indexOf(index) === at).join('');
  };
  assert.equal(cut(0), '45', 'at the start columns 1 to 3 are whole beside the pin; the fourth is cut by the right edge, and the fifth is beyond it');
  assert.equal(cut(100), '15', 'scrolled one column: column 1 is under the pin, 2 to 4 are whole, 5 is cut');
  assert.equal(cut(150), '125', 'between column edges, the columns half under the pin are cut as well as the one at the right edge');
  assert.equal(cut(200), '12', 'at the end of the scroll, 3 to 5 are whole and only those under the pin are cut');
  assert.equal(cut(0).includes('0'), false, 'the pinned column is never hidden');
  const css = readCss('src/features/dashboard/dashboard.css');
  assertRule(css, '.sticky .is-cut', { color: 'transparent' });
  assertRule(css, '.sticky .is-cut *', { visibility: 'hidden' }, 'its cells keep their lines and show no value');
});
