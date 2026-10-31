const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
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
const weight = { model: 'gpt-6.1-sol', kind: 'test', from: 1, to: 0.7 };
const row = (model, agent, patch = {}) => ({ model, agent, runs: 10, firstPassRate: 0.8, avgActiveMs: 600000, tokensPerSecond: 90, findingsPerRun: 1.2, sentBack: 1, outOfScope: 0, incidents: 0,
  quotaPercent: 20, costUsd: 3.2, costedRuns: 10, weight: 1, ...patch });
const task = (model, title, patch = {}) => ({ model, at: at(10, 30), project: 'agentrix', title, kind: 'core', role: '执行', meeting: null,
  firstPass: true, reason: 'exit', activeMs: 600000, outputTokens: 2000, costUsd: 0.25, ...patch });
function fixture(patch = {}) {
  return {
    generatedAt: at(10, 31, 14), query: { projectId: null, range: '30d' },
    projects: [{ id: 'p1', name: 'agentrix' }, { id: 'p2', name: 'site' }],
    kpis: { firstPassRate: 0.8, runs: 50, runsPrevious: 38, incidents: 2, quota: { provider: 'codex', percent: 68, minutes: 10080 },
      reworkPerRound: 1.5, reworkPerRoundPrevious: 2.3, rounds: 4, roundtableFirstConfirm: 0.75, findingsPerRound: 6.5, findingFixRate: 1 },
    models: [
      row('gpt-6.1-sol', 'codex', { runs: 18, firstPassRate: 0.72, avgActiveMs: 34 * 60000, tokensPerSecond: 96, findingsPerRun: 2.4, sentBack: 2, outOfScope: 1, incidents: 2, quotaPercent: 41, costUsd: 12.4, costedRuns: 16, weight: 0.7 }),
      row('claude-sonnet-5-5', 'claude', { runs: 11, firstPassRate: 0.82, tokensPerSecond: 71 }),
      row('gpt-6.1-terra', 'codex', { runs: 14, firstPassRate: 0.93, tokensPerSecond: 140 }),
      row('claude-opus-5-5', 'claude', { runs: 7, firstPassRate: null, tokensPerSecond: null, findingsPerRun: null, quotaPercent: null, costUsd: null, costedRuns: 0 }),
    ],
    kinds: [
      { kind: 'test', model: 'gpt-6.1-sol', runs: 5, firstPassRate: 0.55 }, { kind: 'core', model: 'gpt-6.1-sol', runs: 10, firstPassRate: 0.7 },
      { kind: 'test', model: 'claude-sonnet-5-5', runs: 5, firstPassRate: 0.8 }, { kind: 'frontend', model: 'claude-sonnet-5-5', runs: 6, firstPassRate: 0.84 },
      { kind: 'frontend', model: 'gpt-6.1-terra', runs: 4, firstPassRate: 0.9 }, { kind: 'docs', model: 'gpt-6.1-terra', runs: 2, firstPassRate: null },
    ],
    speed: [
      ...['2026-10-28', '2026-10-29', '2026-10-30'].map((day, index) => ({ day, model: 'gpt-6.1-sol', tokensPerSecond: [92, 95, 101][index] })),
      { day: '2026-10-28', model: 'claude-sonnet-5-5', tokensPerSecond: 70 }, { day: '2026-10-29', model: 'claude-sonnet-5-5', tokensPerSecond: null }, { day: '2026-10-30', model: 'claude-sonnet-5-5', tokensPerSecond: 72 },
      ...['2026-10-28', '2026-10-29', '2026-10-30'].map((day, index) => ({ day, model: 'gpt-6.1-terra', tokensPerSecond: [132, 138, 141][index] })),
    ],
    incidents: [{ at: at(10, 30), project: 'agentrix', meeting: 'open-r1', model: 'gpt-6.1-sol', kind: 'test', cause: 'tests only passed on Windows', fix: 'cross-platform test skill', lead: 'missed', weight }],
    rounds: [
      { project: 'agentrix', meeting: 'open-r1', at: at(10, 30), tasks: 5, questions: null, findings: 13, rework: 2, outOfScope: 0, incidents: 2, durationMs: 6.4 * 3600000, firstConfirmed: true,
        phases: { roundtable: 600000, build: 2400000, review: 600000, rework: 600000 } },
      { project: 'agentrix', meeting: 'skills-r2', at: at(10, 29), tasks: 2, questions: 4, findings: 4, rework: 1, outOfScope: 1, incidents: 0, durationMs: null, firstConfirmed: false,
        phases: { roundtable: null, build: null, review: null, rework: null } },
    ],
    findings: [{ author: 'Sol', category: 'correctness', count: 9 }, { author: 'Sonnet', category: 'ui', count: 4 }, { author: 'Sol', category: 'security', count: 3 }],
    suggestions: [
      { id: 'a', kind: 'weight', title: 'Lower Sol on tests', text: 'Sol failed tests twice.', weight, state: 'open' },
      { id: 'b', kind: 'mechanism', title: 'Fresh sessions for review fixes', text: 'Rework is 22% of build time.', weight: null, state: 'adopted' },
      { id: 'c', kind: 'mechanism', title: 'Keep the roundtable', text: 'Two of five questions changed the plan.', weight: null, state: 'dismissed' },
    ],
    modelRuns: [task('gpt-6.1-sol', 'Latest task'), task('gpt-6.1-sol', 'Needs rework', { firstPass: false, kind: 'test' }),
      task('gpt-6.1-sol', 'Unknown outcome', { firstPass: null, activeMs: null, outputTokens: null, costUsd: null, kind: null }),
      task('claude-sonnet-5-5', 'Site task', { project: 'site', kind: 'frontend' })],
    weights: [weight], prices: { updated: '2026-10-31', unpriced: ['mystery-model'] },
    ...patch,
  };
}
const emptySummary = () => fixture({ kpis: { firstPassRate: null, runs: 0, runsPrevious: null, incidents: 0, quota: null, reworkPerRound: null, reworkPerRoundPrevious: null, rounds: 0, roundtableFirstConfirm: null, findingsPerRound: null, findingFixRate: null },
  models: [], modelRuns: [], kinds: [], speed: [], incidents: [], rounds: [], findings: [], suggestions: [], weights: [], prices: { updated: '2026-10-31', unpriced: [] } });

const view = (props = {}) => {
  const { DashboardView } = dashboard('Dashboard.tsx');
  return renderToStaticMarkup(React.createElement(DashboardView, { summary: fixture(), query: { projectId: null, range: '30d' }, error: null, tab: 'models', named: true,
    onTab() {}, onQuery() {}, decide: async () => null, actions: { minimize() {}, maximize() {}, close() {} }, ...props }));
};
const count = (html, pattern) => (html.match(pattern) ?? []).length;
const rowOf = (html, text) => html.split('<tr').map(part => part.slice(0, part.indexOf('</tr>'))).find(part => part.includes(text));

// ---- format ------------------------------------------------------------------------------------------------------------------
test('numbers the records do not support read as a dash, never as 0', () => zh(() => {
  const f = dashboard('format.ts');
  assert.deepEqual([f.percent(null), f.decimal(null), f.speed(null), f.count(null), f.duration(null)], ['—', '—', '—', '—', '—']);
  assert.equal(f.percent(0), '0%'); assert.equal(f.percent(0.726), '73%'); assert.equal(f.decimal(0), '0.0'); assert.equal(f.speed(96.4), '96 tok/s');
  const unpriced = fixture().models[3];
  assert.equal(f.costValue(unpriced), '—'); assert.equal(f.costCoverage(unpriced), '没有价格');
  assert.equal(f.costValue(fixture().models[0]), '≈ $12.40'); assert.equal(f.costCoverage(fixture().models[0]), '18 次中 16 次有价格');
  assert.equal(f.costValue({ ...unpriced, costUsd: 1234.6 }), '≈ $1235');
}));

test('durations, quota windows and the previous-period hint', () => zh(() => {
  const f = dashboard('format.ts');
  assert.equal(f.duration(400), '1 秒'); assert.equal(f.duration(45000), '45 秒'); assert.equal(f.duration(34 * 60000), '34 分'); assert.equal(f.duration(6.4 * 3600000), '6.4 小时');
  assert.equal(f.windowLength(300), '5 小时'); assert.equal(f.windowLength(10080), '7 天'); assert.equal(f.windowLength(30), '30 分钟');
  assert.equal(f.quotaNote({ provider: 'codex', percent: 68, minutes: 10080 }), 'Codex · 7 天额度窗口'); assert.equal(f.quotaNote(null), '没有额度记录');
  assert.equal(f.previousNote('30d', 38), '上 30 天 38'); assert.equal(f.previousNote('7d', null), '上 7 天 —'); assert.equal(f.previousNote('all', 3), '全部累计');
}));

test('models, kinds and weights are named the way the owner writes them', () => zh(() => {
  const f = dashboard('format.ts');
  assert.deepEqual(['claude-opus-5-5', 'gpt-6.1-sol', 'gpt-6.1-terra', 'unknown-model'].map(f.modelShort), ['Opus', 'Sol', 'Terra', 'unknown-model']);
  assert.deepEqual(['claude-sonnet-5-5', 'gpt-6.1-sol', 'x'].map(f.modelLabel), ['Sonnet 5.5', 'Sol · gpt-6.1-sol', 'x']);
  assert.deepEqual(['core', 'ui-check', 'review', 'odd'].map(f.kindLabel), ['复杂代码', '界面验收', '审查', 'odd']);
  assert.equal(f.weightChange(weight), '测试 1.0 → 0.7 ↓ 降权');
  assert.equal(f.weightChange({ ...weight, to: 1.2 }), '测试 1.0 → 1.2 ↑ 升权');
  assert.equal(f.weightChange({ ...weight, to: 1 }), '测试 1.0 → 1.0');
  assert.equal(f.dayLabel('2026-10-30'), '10-30'); assert.equal(f.dateLabel(at(3, 4)), '03-04'); assert.equal(f.timeLabel(at(10, 31, 9)), '09:00');
  assert.equal(f.hasNoRecords(emptySummary()), true); assert.equal(f.hasNoRecords(fixture()), false);
}));

// ---- chart arithmetic -----------------------------------------------------------------------------------------------------
test('chart scales: round tops, half-pixel gridlines, labels that never overlap', () => {
  const m = dashboard('chart-math.ts');
  assert.deepEqual([0, 0.7, 1, 1.5, 3, 7, 96, 141, 1200].map(m.niceMax), [1, 1, 1, 2, 5, 10, 100, 200, 2000]);
  const y = m.yScale(100, 20, 132);
  assert.equal(y(0), 152.5); assert.equal(y(100), 20.5); assert.equal(y(50) % 1, 0.5);
  const spread = m.spreadLabels([100, 101, 102, 40], 14, 28, 150);
  assert.deepEqual(spread.map(Math.round), [100, 114, 128, 40]);
  const sorted = [...spread].sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i++) assert.ok(sorted[i] - sorted[i - 1] >= 14);
  assert.ok(Math.max(...m.spreadLabels([148, 149, 150], 14, 28, 150)) <= 150, 'a crowd at the bottom is pulled back into the plot');
  assert.equal(m.spreadLabels([], 14, 0, 10).length, 0);
});

test('a missing reading breaks a line; a run of one is a lone mark', () => {
  const m = dashboard('chart-math.ts');
  assert.deepEqual(m.runs([1, 2, null, 3, null, null, 4, 5]), [[0, 1], [3], [6, 7]]);
  assert.deepEqual(m.runs([null, null]), []);
  assert.equal(m.markerEvery(10), 1); assert.equal(m.markerEvery(40), 5);
  assert.equal(m.dayNumber('2026-10-31') - m.dayNumber('2026-10-28'), 3, 'idle days keep their width on the axis');
  assert.equal(m.dayNumber('2026-03-01') - m.dayNumber('2026-02-28'), 1);
  assert.equal(m.nearest([10, 50, 90], 62), 1); assert.equal(m.nearest([10, 50, 90], 400), 2);
});

test('series: the first three models with data are drawn, the rest only in the table; a model keeps its shape', () => {
  const m = dashboard('chart-math.ts'), models = fixture().models;
  const four = m.chartSeries(models, new Set(models.map(item => item.model)));
  assert.deepEqual(four.series.map(item => [item.label, item.shape, item.slot]), [['Sol', 'circle', 0], ['Sonnet', 'square', 1], ['Terra', 'diamond', 2]]);
  assert.equal(four.hidden, 1); assert.equal(four.all.length, 4);
  const without = m.chartSeries(models, new Set(['claude-opus-5-5', 'gpt-6.1-terra']));
  assert.deepEqual(without.series.map(item => [item.label, item.shape, item.slot]), [['Terra', 'diamond', 0], ['Opus', 'triangle', 1]], 'shape follows the model, line style the chart slot');
  assert.equal(m.shapeOf(models, 'not-a-listed-model'), 'circle');
  assert.deepEqual(m.DASHES.length, 3); assert.equal(new Set(m.SHAPES).size, 4);
});

test('speed rows and kind groups are built from the records, nulls kept', () => {
  const m = dashboard('chart-math.ts'), data = fixture();
  const days = m.speedByDay(data.speed);
  assert.deepEqual(days.map(item => item.day), ['2026-10-28', '2026-10-29', '2026-10-30']);
  assert.equal(days[1].values['claude-sonnet-5-5'], null); assert.equal(days[2].values['gpt-6.1-sol'], 101);
  assert.deepEqual(m.speedByDay([{ day: '2026-10-30', model: 'a', tokensPerSecond: 1 }, { day: '2026-10-28', model: 'a', tokensPerSecond: 2 }]).map(item => item.day), ['2026-10-28', '2026-10-30']);
  assert.deepEqual(m.kindGroups(data.kinds).map(item => item.kind), ['core', 'frontend', 'test', 'docs'], 'usual order of the task kinds');
  assert.deepEqual(m.kindGroups([{ kind: 'zzz', model: 'a', runs: 1, firstPassRate: 1 }, { kind: 'aaa', model: 'a', runs: 1, firstPassRate: 1 }, { kind: 'core', model: 'a', runs: 1, firstPassRate: 1 }]).map(item => item.kind), ['core', 'aaa', 'zzz']);
  assert.deepEqual([...m.modelsWithRate(data.kinds)].sort(), ['claude-sonnet-5-5', 'gpt-6.1-sol', 'gpt-6.1-terra']);
  assert.deepEqual([...m.modelsWithSpeed(data.speed)].sort(), ['claude-sonnet-5-5', 'gpt-6.1-sol', 'gpt-6.1-terra']);
  const shares = m.phaseShares({ roundtable: 1, build: 2, review: 1, rework: null });
  assert.deepEqual(shares, { roundtable: 0.25, build: 0.5, review: 0.25, rework: 0 });
  assert.deepEqual(Object.values(m.phaseShares({ a: null, b: null })), [0, 0]);
});

// ---- the store -----------------------------------------------------------------------------------------------------------------
function stubBridge(extra = {}) {
  const calls = [], changed = new Set(), appearance = new Set(), off = [];
  const answer = (query, tag = 'summary') => ({ ok: true, value: { ...fixture(), query, tag } });
  const bridge = {
    calls, off, fireChanged: () => changed.forEach(callback => callback()), pushAppearance: value => appearance.forEach(callback => callback(value)),
    async summary(query) { calls.push(['summary', query]); return answer(query); },
    async decide(id, state, query) { calls.push(['decide', id, state, query]); return answer(query, `decided-${id}-${state}`); },
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

test('deciding a suggestion sends its id, state and the current query, and shows the returned summary', async () => {
  const bridge = stubBridge(), store = newStore(bridge);
  store.start(); store.setQuery({ projectId: 'p1' }); await settle();
  assert.equal(await store.decide('a', 'adopted'), null);
  assert.deepEqual(bridge.calls.at(-1), ['decide', 'a', 'adopted', { projectId: 'p1', range: '30d' }]);
  assert.equal(store.getState().summary.tag, 'decided-a-adopted');
  const refused = newStore(stubBridge({ decide: async () => ({ ok: false, error: 'locked' }) }));
  refused.start(); await settle();
  const before = refused.getState().summary;
  assert.equal(await refused.decide('a', 'dismissed'), 'locked');
  assert.equal(refused.getState().summary, before, 'a refused decision changes nothing on the page');
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

// ---- the page --------------------------------------------------------------------------------------------------------------
test('the model page shows the fixture numbers: one hero figure, the comparison table and the cost wording', () => zh(() => {
  const html = view();
  assert.equal(count(html, /class="kpi hero"/g), 1);
  assert.match(html, /<div class="label">一次通过率<\/div><div class="value">80%<\/div>/);
  assert.match(html, /<div class="label">子任务<\/div><div class="value">50<\/div><div class="delta">上 30 天 38<\/div>/);
  assert.match(html, /<div class="label">额度消耗<\/div><div class="value">68%<\/div><div class="delta">Codex · 7 天额度窗口<\/div>/);
  const sol = rowOf(html, 'Sol · gpt-6.1-sol');
  assert.match(sol, /<td class="num">18<\/td><td class="num">72%<\/td><td class="num">34 分<\/td><td class="num">96 tok\/s<\/td><td class="num">2\.4<\/td>/);
  assert.match(sol, /≈ \$12\.40<\/span><small class="cost-note">18 次中 16 次有价格/);
  assert.match(sol, /测试 1\.0 → 0\.7 ↓ 降权/);
  assert.match(html, /没有价格的模型：mystery-model；它们不计入成本。/);
  assert.match(html, /价格更新于 2026-10-31/);
  const opus = rowOf(html, 'Opus 5.5');
  assert.doesNotMatch(opus, />0%</, 'an unknown rate is not a 0%');
  assert.equal(count(opus, />—</g) >= 5, true);
  assert.match(opus, /没有价格/); assert.match(opus, /默认 1\.0/);
  assert.match(html, /Sonnet 5\.5/); assert.match(html, /Terra · gpt-6\.1-terra/);
}));

test('the charts have a legend, a direct label, a text alternative and a data table, and tell models apart without colour', () => zh(() => {
  const html = view();
  assert.equal(count(html, /<svg class="chart"/g), 2);
  assert.match(html, /role="img" aria-label="一次通过率按任务类型，数据见下方数据表"/);
  assert.match(html, /role="img" aria-label="每天输出速度，数据见下方数据表"/);
  assert.equal(count(html, /<details class="data"><summary>查看数据表<\/summary>/g), 2);
  assert.equal(count(html, /class="legend"/g) >= 2, true);
  for (const name of ['Sol', 'Sonnet', 'Terra']) assert.match(html, new RegExp(`<text class="end"[^>]*>${name} \\d+</text>`));
  // lines: Sol and Terra have three readings (one polyline each), Sonnet's two readings are lone marks around its gap
  assert.equal(count(html, /<polyline/g), 2);
  assert.equal(count(html, /stroke-dasharray="6 4"/g) >= 1, true, 'the second series is dashed in the legend');
  assert.match(html, /<polygon|<rect x=/); assert.match(html, /<circle/);
  // bars: three textures, every bar filled from a pattern
  assert.match(html, /fill="url\(#dash-pattern-0\)"/); assert.match(html, /fill="url\(#dash-pattern-1\)"/); assert.match(html, /fill="url\(#dash-pattern-2\)"/);
  assert.match(html, /<pattern id="dash-pattern-2"/);
  // the data table of the kind chart lists every model and the task kinds, nulls as dashes
  assert.match(html, /<th>任务类型<\/th>/); assert.match(html, /55% · 5 次/);
  const docs = rowOf(html, '<td>文档</td>');
  assert.match(docs, />—</);
  // 28 / 30 October as axis labels
  assert.match(html, />10-28</); assert.match(html, />10-30</);
}));

test('a fourth model is named in the legend note and kept in the data tables only', () => zh(() => {
  const data = fixture();
  data.speed.push({ day: '2026-10-30', model: 'claude-opus-5-5', tokensPerSecond: 58 });
  data.kinds.push({ kind: 'review', model: 'claude-opus-5-5', runs: 7, firstPassRate: 1 });
  const html = view({ summary: data });
  assert.equal(count(html, /另有 1 个模型只在数据表里/g), 2);
  assert.doesNotMatch(html, /<text class="end"[^>]*>Opus/);
  assert.match(rowOf(html, '<td>10-30</td>'), />58</);
}));

test('the incident table and its stacked twin say which model, what cause, what fix and what weight change', () => zh(() => {
  const html = view();
  assert.match(html, /<th>日期<\/th><th>模型<\/th><th>任务类型<\/th><th>原因<\/th><th>改进<\/th><th>权重<\/th>/);
  assert.match(html, /Sol · gpt-6\.1-sol 主责 · 主编排漏检/);
  assert.equal(count(html, /tests only passed on Windows/g), 2);
  assert.equal(count(html, /测试 1\.0 → 0\.7 ↓ 降权/g) >= 3, true);
  assert.match(html, /class="stack-only" role="list"/); assert.match(html, /class="wide-only"/);
  const quiet = view({ summary: fixture({ incidents: [] }) });
  assert.match(quiet, /<th>日期<\/th>/, 'headers stay with no rows'); assert.equal(count(quiet, /这段时间没有事故/g), 2);
}));

test('the collaboration page: rounds with phase bars, findings by author, suggestions with their states', () => zh(() => {
  const html = view({ tab: 'team' });
  assert.equal(count(html, /class="kpi hero"/g), 1);
  assert.match(html, /<div class="label">返工 \/ 轮<\/div><div class="value">1\.5<\/div><div class="delta">上 30 天 2\.3<\/div>/);
  assert.match(html, /<div class="label">圆桌一次确认<\/div><div class="value">75%<\/div>/);
  assert.match(html, /<div class="label">审查发现 \/ 轮<\/div><div class="value">6\.5<\/div><div class="delta">修复率 100%<\/div>/);
  const first = rowOf(html, 'open-r1');
  assert.match(first, /agentrix · 10-30/, 'with every project shown, the round says which project');
  assert.match(first, /aria-label="圆桌 14% · 开发 57% · 审查 14% · 返工 14%"/);
  assert.match(first, /返工 14%/); assert.match(first, /6\.4 小时/);
  assert.match(first, /<td class="num">5<\/td><td class="num">—<\/td><td class="num">13<\/td>/, 'a round before issues were journaled has no question count');
  const second = rowOf(html, 'skills-r2');
  assert.doesNotMatch(second, /class="stagebar"/); assert.match(second, /<td class="num">—<\/td><td><span class="muted">—<\/span><\/td>/);
  assert.match(html, /<th>作者<\/th><th class="num">正确性<\/th><th class="num">安全<\/th><th class="num">性能<\/th><th class="num">边界\/规范<\/th><th class="num">界面<\/th>/);
  assert.match(html, /Sol<\/span><\/td><td class="num">9<\/td><td class="num">3<\/td><td class="num">0<\/td><td class="num">0<\/td><td class="num">0<\/td>/);
  assert.match(html, /Lower Sol on tests/); assert.match(html, /Fresh sessions for review fixes/);
  assert.equal(count(html, /已采纳 ✓/g), 1); assert.equal(count(html, />撤销</g), 2, 'adopted and dismissed ones can be taken back');
  assert.equal(count(html, />采纳</g), 1); assert.equal(count(html, />不采纳</g), 2, 'one open suggestion has the dismiss button, one dismissed one wears the tag');
  const filtered = view({ tab: 'team', summary: fixture({ query: { projectId: 'p1', range: '30d' } }) });
  assert.doesNotMatch(rowOf(filtered, 'open-r1'), /agentrix · 10-30/, 'one project: the project name is not repeated on every row');
}));

test('the toolbar: tabs, project Select with all projects, the three ranges, each told by pressed state', () => zh(() => {
  const html = view();
  assert.match(html, /role="combobox" aria-label="项目" aria-haspopup="listbox" aria-expanded="false"[^>]*data-value=""[^>]*><span class="select-value">全部项目<\/span>/);
  assert.match(view({ query: { projectId: 'p2', range: '7d' } }), /data-value="p2"[^>]*><span class="select-value">site<\/span>/);
  assert.match(html, /aria-label="时间范围"/);
  assert.match(html, /<button type="button" class="button" aria-pressed="true">模型评估<\/button><button type="button" class="button" aria-pressed="false">协作报告<\/button>/);
  assert.match(html, /aria-pressed="false">7 天<\/button><button type="button" class="button" aria-pressed="true">30 天<\/button><button type="button" class="button" aria-pressed="false">全部<\/button>/);
  assert.match(view({ tab: 'team', query: { projectId: null, range: 'all' } }), /aria-pressed="true">全部<\/button>/);
  assert.match(html, /role="status">近 30 天 · 全部项目 · 更新于 14:00<\/span>/);
  assert.match(view({ query: { projectId: 'p2', range: '7d' } }), /近 7 天 · site · 更新于/);
}));

test('the title bar has the window buttons and the page says what is wrong, what is loading and what is empty', () => zh(() => {
  const html = view();
  assert.match(html, /class="titlebar"/); assert.equal(count(html, /class="icon-button/g), 3); assert.match(html, /aria-label="关闭窗口"/);
  assert.match(view({ summary: null }), /正在读取…/);
  assert.doesNotMatch(view({ summary: null, error: 'boom' }), /正在读取/);
  assert.match(view({ error: 'boom' }), /role="alert">读取数据失败：boom<\/p>/);
  assert.match(view({ summary: null, named: false }), /<span class="dash-title"><\/span>/, 'no title before the language is known');
  const empty = view({ summary: emptySummary() });
  assert.match(empty, /还没有记录。派发子任务、完成一轮协作或评价一次交付后，这里会出现数据。/);
  assert.doesNotMatch(empty, /<table/);
  const team = view({ summary: emptySummary(), tab: 'team' });
  assert.match(team, /还没有记录/);
}));

test('with records but nothing in a table, its headers stay and it says so', () => zh(() => {
  const html = view({ summary: fixture({ rounds: [], findings: [], suggestions: [] }), tab: 'team' });
  assert.match(html, /<th>轮次<\/th>/); assert.match(html, /这段时间没有完成的轮次/); assert.match(html, /这段时间没有审查发现/); assert.match(html, /这段时间没有建议/);
  const models = view({ summary: fixture({ models: [], kinds: [], speed: [] }) });
  assert.match(models, /这段时间没有模型的记录/); assert.match(models, /还没有按任务类型统计的一次通过率/); assert.match(models, /还没有带计时的回复，算不出输出速度/);
}));

test('every scrolling table sits in a labelled, keyboard-focusable region', () => zh(() => {
  for (const tab of ['models', 'team']) {
    const html = view({ tab });
    const regions = count(html, /<div class="scroll[^"]*"/g);
    assert.ok(regions >= 2);
    assert.equal(count(html, /<div class="scroll[^"]*" role="region" aria-label="[^"]+" tabindex="0"/g), regions);
  }
}));

test('English mode writes the same page in English, with the sentence templates filled', () => {
  try {
    applyLanguage('en');
    const html = view();
    assert.match(html, /First-pass rate/); assert.match(html, /Model comparison/); assert.match(html, /16 of 18 runs priced/);
    assert.match(html, /Codex · 7 days limit window/); assert.match(html, /previous 30 days: 38/); assert.match(html, /Last 30 days · All projects · updated 14:00/);
    assert.match(html, /Models without a price: mystery-model; they are left out of the cost\./);
    assert.match(html, /Tests 1\.0 → 0\.7 ↓ lowered/); assert.match(html, /View data table/);
    assert.equal(document.documentElement.lang, 'en');
    assert.doesNotMatch(view({ tab: 'team' }), /[一-鿿]/, 'no Chinese is left on the collaboration page');
    assert.doesNotMatch(html, /[一-鿿]/, 'no Chinese is left on the model page');
  } finally { applyLanguage('zh'); }
  assert.equal(document.documentElement.lang, 'zh-CN');
});

// ---- the suggestion buttons and the menu entry, with hooks stood in so a click can be driven -----------------------------------
function hooks(initial = {}) {
  const slots = [];
  let index = 0;
  const api = {
    ...React,
    useState(start) { const slot = index++; if (!(slot in slots)) slots[slot] = slot in initial ? initial[slot] : typeof start === 'function' ? start() : start; return [slots[slot], value => { slots[slot] = typeof value === 'function' ? value(slots[slot]) : value; }]; },
    useRef(start) { const slot = index++; slots[slot] ??= { current: start }; return slots[slot]; },
    useEffect() {}, useLayoutEffect() {},
  };
  return { api, slots, render(run) { index = 0; return run(); } };
}
const elements = node => Array.isArray(node) ? node.flatMap(elements) : React.isValidElement(node) ? [node, ...elements(node.props.children)] : [];
const text = node => Array.isArray(node) ? node.map(text).join('') : typeof node === 'string' ? node : React.isValidElement(node) ? text(node.props.children) : '';

test('model cells are native buttons, open one model task list at a time and return focus when it closes', () => {
  const h = hooks(), loader = makeLoader({ react: h.api });
  loader('shared/i18n.ts').applyLanguage('zh');
  const { ModelTable } = loader('features/dashboard/ModelTable.tsx'), { ModelTasks } = loader('features/dashboard/ModelTasks.tsx');
  let summary = fixture();
  const tree = () => h.render(() => ModelTable({ summary }));
  const controls = () => elements(tree()).filter(node => node.type === 'button' && 'aria-expanded' in node.props);
  const detail = () => elements(tree()).find(node => node.type === ModelTasks);
  const focused = [], sol = { focus: () => focused.push('sol') }, sonnet = { focus: () => focused.push('sonnet') };
  assert.equal(controls().length, summary.models.length);
  assert.ok(controls().every(node => node.props.type === 'button' && node.props['aria-expanded'] === false), 'native buttons supply Enter and Space activation');
  assert.equal(detail(), undefined);
  controls()[0].props.onClick({ currentTarget: sol });
  assert.deepEqual(controls().map(node => node.props['aria-expanded']), [true, false, false, false]);
  assert.equal(controls()[0].props['aria-controls'], 'dashboard-model-tasks');
  assert.deepEqual(detail().props.runs.map(run => run.title), ['Latest task', 'Needs rework', 'Unknown outcome']);
  controls()[1].props.onClick({ currentTarget: sonnet });
  assert.deepEqual(controls().map(node => node.props['aria-expanded']), [false, true, false, false]);
  assert.deepEqual(detail().props.runs.map(run => run.title), ['Site task']);
  detail().props.onClose();
  assert.equal(detail(), undefined); assert.deepEqual(focused, ['sonnet']);
  controls()[0].props.onClick({ currentTarget: sol }); controls()[0].props.onClick({ currentTarget: sol });
  assert.equal(detail(), undefined, 'activating the open row closes it too');
  controls()[2].props.onClick({ currentTarget: sol });
  assert.deepEqual(detail().props.runs, [], 'a model without worker runs still opens an empty list');
  summary = fixture({ modelRuns: [task('gpt-6.1-terra', 'Filtered task')] });
  assert.equal(detail().props.runs[0].title, 'Filtered task', 'an open list follows new filter results');
});

test('model task details show time, project, title, named kind, three outcomes and right-aligned numeric values', () => zh(() => {
  const { ModelTasks } = dashboard('ModelTasks.tsx'), summary = fixture();
  const html = renderToStaticMarkup(React.createElement(ModelTasks, { model: 'gpt-6.1-sol', runs: summary.modelRuns.filter(run => run.model === 'gpt-6.1-sol'), onClose() {} }));
  assert.match(html, /<section id="dashboard-model-tasks"[^>]*aria-labelledby="dashboard-model-tasks-title"/);
  assert.match(html, /Sol · gpt-6\.1-sol 的任务/);
  assert.match(html, /收起任务列表/); assert.match(html, /按当前筛选，最多显示最近 50 条任务/);
  assert.match(html, /class="scroll tall" role="region" aria-label="模型任务表，可横向滚动；任务列固定" tabindex="0"/);
  for (const column of ['任务', '时间', '项目', '任务类型', '用时', '输出 token', '成本', '结果']) assert.match(html, new RegExp(`<th[^>]*>${column}</th>`));
  assert.equal(count(html, /<tbody><tr>|<\/tr><tr>/g), 3);
  const latest = rowOf(html, 'Latest task');
  assert.match(latest, /<time dateTime="[^"]+">2026-10-30 10:00<\/time>/);
  assert.match(latest, /agentrix/); assert.match(latest, />复杂代码</); assert.match(latest, />一次通过</);
  assert.match(latest, /<td class="num">10 分<\/td><td class="num">2000<\/td><td class="num">≈ \$0\.25<\/td>/);
  assert.match(rowOf(html, 'Needs rework'), />测试</); assert.match(rowOf(html, 'Needs rework'), />返工或退回</);
  const unknown = rowOf(html, 'Unknown outcome');
  assert.equal(count(unknown, />—</g), 5, 'unknown kind, outcome, duration, count and cost are dashes');
  assert.doesNotMatch(html, /Site task/);
  const zero = renderToStaticMarkup(React.createElement(ModelTasks, { model: 'custom', runs: [task('custom', 'A < B', { outputTokens: 0, costUsd: 0 })], onClose() {} }));
  assert.match(zero, /A &lt; B/); assert.match(zero, /<td class="num">0<\/td><td class="num">≈ \$0\.00<\/td>/);
}));

test('an empty model task list keeps every header and says 没有任务', () => zh(() => {
  const { ModelTasks } = dashboard('ModelTasks.tsx');
  const html = renderToStaticMarkup(React.createElement(ModelTasks, { model: 'claude-opus-5-5', runs: [], onClose() {} }));
  assert.equal(count(html, /<th[ >]/g), 8);
  assert.match(html, /<td colSpan="8" class="muted">没有任务<\/td>/);
}));

test('采纳 / 不采纳 / 撤销 call decide with the suggestion id and the state they mean, and the status line answers', async () => {
  const h = hooks(), loader = makeLoader({ react: h.api }), { Suggestions } = loader('features/dashboard/Suggestions.tsx');
  loader('shared/i18n.ts').applyLanguage('zh');
  const calls = [];
  const decide = async (id, state) => { calls.push([id, state]); return id === 'c' ? 'locked' : null; };
  const tree = () => h.render(() => Suggestions({ suggestions: fixture().suggestions, decide }));
  const buttons = () => elements(tree()).filter(node => node.type === 'button');
  const labels = () => buttons().map(node => text(node.props.children));
  assert.deepEqual(labels(), ['采纳', '不采纳', '撤销', '撤销']);
  await buttons()[0].props.onClick(); await buttons()[1].props.onClick(); await buttons()[2].props.onClick(); await buttons()[3].props.onClick();
  assert.deepEqual(calls, [['a', 'adopted'], ['a', 'dismissed'], ['b', 'open'], ['c', 'open']]);
  assert.match(text(elements(tree()).find(node => node.props.role === 'status')), /没有保存：locked/, 'the last decision was refused and the line says so');
  const note = loader('features/dashboard/Suggestions.tsx').decisionNote;
  assert.match(note('adopted', { kind: 'weight', title: 'T' }, null), /已采纳「T」，记在本机；之后新开的主编排会话会按它分工。/);
  assert.equal(note('adopted', { kind: 'mechanism', title: 'T' }, null), '已采纳「T」，记在本机。');
  assert.equal(note('dismissed', { kind: 'mechanism', title: 'T' }, null), '已标为不采纳「T」。'); assert.equal(note('open', { kind: 'weight', title: 'T' }, null), '已撤销「T」。');
});

test('the app menu offers 数据看板 after 设置, before any update item, and opening it closes the menu first', async () => {
  const h = hooks({ 0: { left: 0, top: 0 } }), logged = [], previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window'), original = console.error;
  const opened = [];
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { agentrix: { openDashboard: () => { opened.push(h.slots[0]); return Promise.resolve(opened.length === 1 ? { ok: true, value: undefined } : { ok: false, error: 'no window' }); } } } });
  console.error = (...args) => logged.push(args.join(' '));
  try {
    const loader = makeLoader({ react: h.api, 'react-dom': { createPortal: node => node }, '../shortcuts/shortcuts': { shortcut: () => '' } }), { AppMenu } = loader('features/titlebar/AppMenu.tsx');
    loader('shared/i18n.ts').applyLanguage('zh');
    const props = { fullScreen: false, canReturn: true, updateReady: true, onAddProject() {}, onReturn() {}, onFullScreen() {}, onSettings() {}, onInstallUpdate() {} };
    const items = () => elements(h.render(() => AppMenu(props))).filter(node => node.props.label !== undefined);
    assert.deepEqual(items().map(node => node.props.label), ['新建项目', '返回项目', '全屏', '设置', '数据看板', '重启并安装更新']);
    const entry = () => items().find(node => node.props.label === '数据看板');
    h.slots[0] = { left: 0, top: 0 }; entry().props.onSelect(); await settle();
    assert.deepEqual(opened, [null], 'the menu was already closed when the dashboard was asked to open');
    assert.deepEqual(logged, [], 'opening succeeded: nothing to report');
    h.slots[0] = { left: 0, top: 0 }; entry().props.onSelect(); await settle();
    assert.deepEqual(logged, ['no window'], 'a failure only goes to the console');
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
  assert.match(config, /input: \{ main: 'index\.html', dashboard: 'dashboard\.html' \}/); assert.match(config, /entries: \['index\.html', 'dashboard\.html'\]/);
});

test('the dashboard stylesheet keeps the product scale: spacing, type, radii, controls, and tokens for every colour but the chart series', () => {
  const css = fs.readFileSync(path.join(dashboardDir, 'dashboard.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const declarations = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].flatMap(([, selector, body]) => body.split(';').map(item => item.trim()).filter(Boolean)
    .map(item => ({ selector: selector.trim(), name: item.slice(0, item.indexOf(':')).trim(), value: item.slice(item.indexOf(':') + 1).trim() })));
  const off = [], scale = new Set([0, 2, 4, 8, 12, 16, 24, 32]);
  for (const { selector, name, value } of declarations) {
    if (/^(padding|margin|gap|row-gap|column-gap)(-|$)/.test(name)) for (const [, px] of value.matchAll(/(\d+(?:\.\d+)?)px/g)) if (!scale.has(Number(px))) off.push(`${selector} { ${name}: ${value} }`);
  }
  assert.deepEqual(off, [], 'spacing is 2/4/8/12/16/24/32');
  const sizes = new Set(), weights = new Set(), radii = new Set();
  for (const { name, value } of declarations) {
    if (name === 'font-size') sizes.add(value);
    if (name === 'font-weight') weights.add(value);
    if (name === 'font') { sizes.add(/(\d+)px/.exec(value)?.[1] + 'px'); weights.add(/^(\d+)/.exec(value)?.[1]); }
    if (name === 'border-radius') radii.add(value);
  }
  assert.deepEqual([...sizes].sort(), ['12px', '13px', '14px', '16px', '48px']); assert.deepEqual([...weights].sort(), ['400', '600']);
  assert.deepEqual([...radii].sort(), ['12px', '8px', '999px']);
  const literal = declarations.filter(({ name, value }) => /#[0-9a-f]{3,8}\b/i.test(value) && !/^--chart-[123]$/.test(name));
  assert.deepEqual(literal, [], 'colours come from the theme tokens; only --chart-1..3 are literal');
  assert.match(css, /\.dash \{ --chart-1: #3987e5; --chart-2: #d95926; --chart-3: #199e70;/);
  assert.match(css, /:root\[data-theme="light"\] \.dash \{ --chart-1: #2a78d6; --chart-2: #eb6834; --chart-3: #1baf7a; \}/);
  assert.equal(declarations.find(({ selector, name }) => selector === 'details.data summary' && name === 'height').value, '32px', 'the data-table toggle is a 32px control');
  assert.match(fs.readFileSync(path.join(src, 'shared/styles/styles.css'), 'utf8'), /\.button \{[^}]*height: 32px/);
});

test('the page reads only the dashboard bridge and never the main window’s', () => {
  const files = fs.readdirSync(dashboardDir).filter(name => /\.tsx?$/.test(name));
  for (const name of files) assert.doesNotMatch(fs.readFileSync(path.join(dashboardDir, name), 'utf8'), /window\.agentrix\b(?!Dashboard)/, name);
  const imports = files.flatMap(name => [...fs.readFileSync(path.join(dashboardDir, name), 'utf8').matchAll(/from '(\.\.\/\.\.\/[^']+|\.\.\/[^']+)'/g)].map(match => match[1]));
  assert.deepEqual([...new Set(imports.filter(spec => !spec.startsWith('../../shared/')))], [], 'only src/shared is imported from outside the feature');
});
