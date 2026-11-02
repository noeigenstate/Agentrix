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
const trend = (...tail) => [...Array(14 - tail.length).fill(0), ...tail];
const row = (model, agent, patch = {}) => ({ model, agent, runs: 10, firstPassRate: 0.8, avgActiveMs: 600000, tokensPerSecond: 90, findingsPerRun: 1.2, sentBack: 1, outOfScope: 0, incidents: 0,
  quotaPercent: 20, costUsd: 3.2, costedRuns: 10, weight: 1, trend: trend(0, 2, 1, 3), ...patch });
const live = (id, model, patch = {}) => ({ id, project: 'p1', agent: 'Codex', model, title: 'Refactor the grid', role: '执行', startedAt: at(10, 31, 13), tokensPerSecond: 96.4, ...patch });
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
    daily: [
      { day: '2026-10-29', model: 'gpt-6.1-sol', runs: 3, firstPass: 2, costUsd: 1.2, activeMs: 600000 },
      { day: '2026-10-30', model: 'gpt-6.1-sol', runs: 5, firstPass: 4, costUsd: null, activeMs: null },
      { day: '2026-10-30', model: 'claude-sonnet-5-5', runs: 2, firstPass: 1, costUsd: 0.5, activeMs: 300000 },
      { day: '2026-10-31', model: 'gpt-6.1-terra', runs: 4, firstPass: 3, costUsd: 0.8, activeMs: 400000 },
    ],
    live: { running: [live('dispatch:a', 'gpt-6.1-sol'), live('agent:b', 'claude-sonnet-5-5', { project: 'p2', agent: 'Claude Code', title: 'Check the colours', role: '审查', startedAt: null, tokensPerSecond: null })], at: at(10, 31, 14) },
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
  models: [], modelRuns: [], kinds: [], speed: [], daily: [], live: { running: [], at: 0 }, incidents: [], rounds: [], findings: [], suggestions: [], weights: [], prices: { updated: '2026-10-31', unpriced: [] } });

// The page's clock is the moment the fixture was generated, so elapsed times and the age of the numbers are fixed.
const view = (props = {}) => {
  const { DashboardView } = dashboard('Dashboard.tsx');
  return renderToStaticMarkup(React.createElement(DashboardView, { summary: fixture(), query: { projectId: null, range: '30d' }, error: null, now: at(10, 31, 14), tab: 'models', named: true,
    onTab() {}, onQuery() {}, decide: async () => null, actions: { minimize() {}, maximize() {}, close() {} }, ...props }));
};
const count = (html, pattern) => (html.match(pattern) ?? []).length;
const rowOf = (html, text) => html.split('<tr').slice(1).map(part => part.slice(0, part.indexOf('</tr>'))).find(part => part.includes(text));

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
  assert.deepEqual(['sonnet', 'Opus', 'haiku'].map(f.modelShort), ['Sonnet', 'Opus', 'Haiku'], 'an alias is written like the full id');
  assert.deepEqual(['sonnet', 'claude-sonnet-5-5'].map(f.modelLabel), ['Sonnet', 'Sonnet 5.5']);
  assert.deepEqual(['core', 'ui-check', 'review', 'odd'].map(f.kindLabel), ['复杂代码', '界面验收', '审查', 'odd']);
  assert.equal(f.weightChange(weight), '测试 1.0 → 0.7 ↓ 降权');
  assert.equal(f.weightChange({ ...weight, to: 1.2 }), '测试 1.0 → 1.2 ↑ 升权');
  assert.equal(f.weightChange({ ...weight, to: 1 }), '测试 1.0 → 1.0');
  assert.equal(f.dayLabel('2026-10-30'), '10-30'); assert.equal(f.dateLabel(at(3, 4)), '03-04');
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
  // labels beside points: only neighbours in x are spread, a far point keeps its y
  const near = m.spreadNearby([{ x: 575, y: 100 }, { x: 587, y: 100 }, { x: 350, y: 101 }], 88, 16, 20, 200);
  assert.ok(Math.abs(near[0] - near[1]) >= 16, 'two points at one spot get labels a line apart'); assert.equal(near[2], 101, 'a point far to the left keeps its label where it was');
  assert.deepEqual(m.spreadNearby([{ x: 10, y: 50 }], 88, 16, 20, 200), [50]); assert.deepEqual(m.spreadNearby([], 88, 16, 20, 200), []);
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
  assert.deepEqual(m.summaryModels({ models: [{ model: 'a' }], daily: [{ model: 'b' }], kinds: [{ model: 'c' }], speed: [{ model: 'd' }], live: { running: [{ model: 'e' }] } }), ['a', 'b', 'c', 'd', 'e']);
});

test('speed rows and kind groups are built from the records, nulls kept', () => {
  const m = dashboard('chart-math.ts'), data = fixture();
  const days = m.speedByDay(data.speed);
  assert.deepEqual(days.map(item => item.day), ['2026-10-28', '2026-10-29', '2026-10-30']);
  assert.equal(days[1].values['claude-sonnet-5-5'], null); assert.equal(days[2].values['gpt-6.1-sol'], 101);
  assert.deepEqual(m.speedByDay([{ day: '2026-10-30', model: 'a', tokensPerSecond: 1 }, { day: '2026-10-28', model: 'a', tokensPerSecond: 2 }]).map(item => item.day), ['2026-10-28', '2026-10-30']);
  assert.deepEqual(m.kindGroups(data.kinds).map(item => item.kind), ['core', 'frontend', 'test', 'docs'], 'usual order of the task kinds');
  assert.deepEqual(m.kindGroups([{ kind: 'zzz', model: 'a', runs: 1, firstPassRate: 1 }, { kind: 'aaa', model: 'a', runs: 1, firstPassRate: 1 }, { kind: 'core', model: 'a', runs: 1, firstPassRate: 1 }]).map(item => item.kind), ['core', 'aaa', 'zzz']);
  assert.deepEqual([...m.modelsWithSpeed(data.speed)].sort(), ['claude-sonnet-5-5', 'gpt-6.1-sol', 'gpt-6.1-terra']);
  const shares = m.phaseShares({ roundtable: 1, build: 2, review: 1, rework: null });
  assert.deepEqual(shares, { roundtable: 0.25, build: 0.5, review: 0.25, rework: 0 });
  assert.deepEqual(Object.values(m.phaseShares({ a: null, b: null })), [0, 0]);
});

test('daily runs group by local day with the confirmed passes, and the last fourteen days end today', () => {
  const m = dashboard('chart-math.ts'), days = m.runsByDay(fixture().daily);
  assert.deepEqual(days.map(day => [day.day, day.total, day.passes]), [['2026-10-29', 3, 2], ['2026-10-30', 7, 5], ['2026-10-31', 4, 3]]);
  assert.deepEqual(days[1].runs, { 'gpt-6.1-sol': 5, 'claude-sonnet-5-5': 2 });
  assert.deepEqual(m.runsByDay([{ day: '2026-10-30', model: 'a', runs: 1, firstPass: 0, costUsd: null, activeMs: null }, { day: '2026-10-28', model: 'a', runs: 2, firstPass: 1, costUsd: null, activeMs: null }]).map(day => day.day), ['2026-10-28', '2026-10-30'], 'oldest first');
  assert.deepEqual(m.runsByDay([]), []);
  assert.equal(m.localDay(at(3, 4, 23)), '2026-03-04');
  const recent = m.recentDays(at(3, 2), 14);
  assert.equal(recent.length, 14); assert.equal(recent.at(-1), '2026-03-02'); assert.equal(recent[0], '2026-02-17', 'across the month end, oldest first');
});

test('heat steps: a rate spans 45%..100% over five steps and a count spans 0..the largest', () => {
  const m = dashboard('chart-math.ts');
  assert.deepEqual([0.3, 0.45, 0.46, 0.6, 0.8, 0.9, 1].map(m.rateStep), [1, 1, 1, 2, 4, 5, 5]);
  assert.deepEqual([0, 1, 3, 6, 9].map(count => m.countStep(count, 9)), [1, 1, 2, 4, 5]);
  assert.equal(m.countStep(0, 0), 1, 'no findings at all is the lightest step, not a division by zero');
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

test('a read in flight is loading, the refresh button reads the current query again, and a failed read stops loading', async () => {
  const pending = [], bridge = stubBridge({ summary: query => new Promise(resolve => pending.push(() => resolve({ ok: true, value: { ...fixture(), query } }))) });
  const store = newStore(bridge);
  assert.equal(store.getState().loading, false);
  store.start(); assert.equal(store.getState().loading, true);
  pending[0](); await settle(); assert.equal(store.getState().loading, false);
  store.setQuery({ projectId: 'p1' }); store.refresh();
  assert.equal(pending.length, 3, 'refresh asks again for the same query');
  assert.equal(store.getState().loading, true);
  pending[2](); await settle(); assert.equal(store.getState().loading, false);
  pending[1](); await settle(); assert.equal(store.getState().summary.query.projectId, 'p1', 'the older read does not clear or replace the newer one');
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
test('the model page shows the fixture numbers: one hero figure, the tiles with their small charts, the comparison table and the cost wording', () => zh(() => {
  const html = view();
  assert.equal(count(html, /class="kpi hero"/g), 1);
  assert.match(html, /<div class="label">一次通过率<\/div><div class="hero-split"><div><div class="value">80%<\/div><div class="delta">审查和你都没退回<\/div>/);
  assert.match(html, /<div class="label">子任务<\/div><div class="value">50<\/div><div class="delta">▲ 12 · 上 30 天 38<\/div>/);
  assert.match(html, /<div class="label">额度消耗<\/div><div class="value">68%<\/div><div class="delta">Codex · 7 天额度窗口<\/div><div class="meter" role="img" aria-label="额度已用 68%"><b style="width:68%">/);
  assert.equal(count(html, /class="spark"/g), 3, 'the first-pass, run and incident tiles each carry small bars');
  // four units of width per day: the three days of the daily series, then the fourteen days of the run and incident trends
  for (const [label, width] of [['每天一次通过的子任务数', 12], ['近 14 天每天子任务', 56], ['近 14 天每天事故', 56]]) assert.match(html, new RegExp(`<svg class="spark" viewBox="0 0 ${width} 24" preserveAspectRatio="none" role="img" aria-label="${label}">`));
  assert.match(html, /aria-label="各模型一次通过率"/);
  assert.match(html, /<span class="who"><svg[^>]*>[^]*?<\/svg>Opus<\/span><i><b style="width:0%;background:var\(--m-0\)"><\/b><\/i><span>—<\/span>/, 'a model without a measured rate has an empty bar and a dash, never 0');
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

test('the charts name every model in words, have a text alternative and a data table, and share one colour per model', () => zh(() => {
  const html = view();
  assert.equal(count(html, /<svg class="chart"/g), 3, 'cost and speed, runs per day, speed per day');
  for (const label of ['成本与速度散点图，数据见模型对比表', '每天子任务，数据见下方数据表', '每天输出速度，数据见下方数据表', '各模型子任务占比']) assert.match(html, new RegExp(`role="img" aria-label="${label}"`));
  assert.equal(count(html, /<details class="data"><summary>查看数据表<\/summary>/g), 2);
  assert.equal(count(html, /class="legend"/g), 2);
  for (const [name, value] of [['Sol', 101], ['Sonnet', 72], ['Terra', 141]]) assert.match(html, new RegExp(`<text class="end"[^>]*>${name} ${value}</text>`), 'a line is named at its end');
  // lines: Sol and Terra have three readings (one polyline each), Sonnet's two readings are lone marks around its gap
  assert.equal(count(html, /<polyline class="line"/g), 2);
  for (const slot of [1, 2, 3]) assert.match(html, new RegExp(`stroke="var\\(--m-${slot}\\)"`), `model slot ${slot} draws in its own colour`);
  assert.match(html, /<polygon/); assert.match(html, /<circle/);
  assert.equal(count(html, /fill="url\(#/g), 0, 'no textures: a model is told apart by colour and mark, and named beside them');
  // bubbles: cost per run against speed; Opus has neither, so it is named under the chart instead of drawn at zero
  assert.equal(count(html, /class="bubble"/g), 3);
  assert.match(html, /没有价格或速度的模型不画：Opus/);
  // the stacked daily bars: the days of the daily series as axis labels, the 2px gap made by a shorter segment
  assert.match(html, />10-29</); assert.match(html, />10-31</);
  assert.equal(count(html, /class="seg /g), 4);
  // the run share: one arc per model that ran, the total in the middle
  assert.match(html, /<title>Sol · gpt-6\.1-sol · 18 次 · 36%<\/title>/); assert.match(html, /class="centre"[^>]*>50<\/text>/);
  // the data table of the daily bars lists the days newest first, with zeros for idle days
  const day = html.split('<tr').find(part => part.includes('<td>10-30</td>') && part.includes('class="num"'));
  assert.match(day, /<td class="num">5<\/td><td class="num">2<\/td><td class="num muted">0<\/td>/);
}));

test('the first-pass heat map shades each model-kind cell on five steps, says the number in every cell and shows a dash for no record', () => zh(() => {
  const html = view();
  assert.match(html, /<table class="heat narrow">/); assert.match(html, /<th>任务类型<\/th>/);
  assert.match(html, /<td class="cell step-1" title="测试 · Sol：55%（5 次）">55<\/td>/);
  assert.match(html, /<td class="cell step-3" title="复杂代码 · Sol：70%（10 次）">70<\/td>/);
  assert.match(html, /<td class="cell step-5" title="前端 · Terra：90%（4 次）">90<\/td>/);
  const docs = rowOf(html, '<td>文档</td>');
  assert.match(docs, /<td class="cell na" title="没有记录">—<\/td>/); assert.match(docs, /<td class="num muted">2 次<\/td>/, 'the sample column counts the runs even when no rate is known');
  assert.match(html, /<div class="scale"><span>45%<\/span><span class="ramp"><i class="step-1"><\/i>.*<i class="step-5"><\/i><\/span><span>100%<\/span><span>· 无记录显示为 —<\/span><\/div>/);
}));

test('there is no limit to the models drawn: a fourth model gets its own colour, mark and end label', () => zh(() => {
  const data = fixture();
  data.speed.push({ day: '2026-10-30', model: 'claude-opus-5-5', tokensPerSecond: 58 });
  data.kinds.push({ kind: 'review', model: 'claude-opus-5-5', runs: 7, firstPassRate: 1 });
  const html = view({ summary: data });
  assert.match(html, /<text class="end"[^>]*>Opus 58<\/text>/); assert.match(html, /stroke="var\(--m-0\)"/);
  assert.doesNotMatch(html, /另有/);
  assert.ok(html.split('<tr').some(part => part.includes('<td>10-30</td>') && part.includes('>58<')), 'and a row of the speed data table');
  assert.match(rowOf(html, '<td>审查</td>'), /title="审查 · Opus：100%（7 次）">100<\/td>/);
}));

test('picking a model in the key dims every other model across the page, and picking it again lifts the dimming', () => zh(() => {
  const h = hooks(), loader = makeLoader({ react: h.api });
  loader('shared/i18n.ts').applyLanguage('zh');
  const { ModelKey } = loader('features/dashboard/ModelKey.tsx'), { ModelPageProvider } = loader('features/dashboard/model-look.tsx'), { modelLooks } = loader('features/dashboard/chart-math.ts');
  const models = fixture().models, picked = [], looks = modelLooks(models.map(item => item.model));
  const chips = focus => { ModelPageProvider._currentValue = { looks, focus }; return elements(h.render(() => ModelKey({ models, onFocus: model => picked.push(model) }))).filter(node => node.type === 'button'); };
  assert.deepEqual(chips(null).map(node => node.props['aria-pressed']), [false, false, false, false]);
  chips(null)[1].props.onClick(); chips('claude-sonnet-5-5')[1].props.onClick();
  assert.deepEqual(picked, ['claude-sonnet-5-5', null], 'the second click on the same chip lifts it');
  assert.deepEqual(chips('claude-sonnet-5-5').map(node => node.props['aria-pressed']), [false, true, false, false]);
  const { useModels } = loader('features/dashboard/model-look.tsx');
  const dim = model => { ModelPageProvider._currentValue = { looks, focus: 'claude-sonnet-5-5' }; return h.render(() => useModels().of(model).dim); };
  assert.deepEqual(['claude-sonnet-5-5', 'gpt-6.1-sol'].map(dim), ['', 'dim']);
  const html = view();
  assert.doesNotMatch(html, /class="dim"/, 'with nothing picked nothing is dim');
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
  assert.match(html, /<th>作者<\/th><th class="num">正确性<\/th><th class="num">安全<\/th><th class="num">性能<\/th><th class="num">边界\/规范<\/th><th class="num">界面<\/th><th class="num">合计<\/th>/);
  assert.match(html, /Sol<\/span><\/td><td class="cell step-5" title="Sol · 正确性：9 条">9<\/td><td class="cell step-2" title="Sol · 安全：3 条">3<\/td><td class="cell step-1" title="Sol · 性能：0 条">0<\/td><td class="cell step-1"[^>]*>0<\/td><td class="cell step-1"[^>]*>0<\/td><td class="num muted">12 条<\/td>/,
    'findings are shaded by count, a known zero is a 0 on the lightest step');
  assert.match(html, /<i class="swatch rework"><\/i>返工（斜纹）/); assert.match(first, /<i class="rework" style="width:14\.\d+%"><\/i>/, 'rework is the hatched step of the phase bar');
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
  assert.match(html, /role="status">近 30 天 · 全部项目<\/span>/);
  assert.match(view({ query: { projectId: 'p2', range: '7d' } }), /role="status">近 7 天 · site<\/span>/);
}));

test('the live strip lists the running workers with their elapsed time and speed, filtered by project, and says when none run', () => zh(() => {
  const html = view();
  assert.match(html, /<h2>正在运行<span class="hint"><span class="tag run"><i class="live-dot"><\/i>2 个子任务<\/span> 来自活动面板里调用的模型<\/span><\/h2>/);
  assert.equal(count(html, /class="live-item /g), 2);
  assert.match(html, /<div class="l1">[^]*?Sol<\/span><span class="tag">执行<\/span><\/div><div class="r1">已运行 <span>1:00:00<\/span><\/div><div class="l2" title="Refactor the grid">Refactor the grid<\/div><div class="r2"><b>96 tok\/s<\/b><\/div>/);
  assert.match(html, /Check the colours<\/div><div class="r2"><b>—<\/b><\/div>/); assert.match(html, /已运行 <span>—<\/span>/, 'a start the records do not give is a dash, not 0:00');
  const onlyP2 = view({ summary: fixture({ query: { projectId: 'p2', range: '30d' } }) });
  assert.match(onlyP2, /Check the colours/); assert.doesNotMatch(onlyP2, /Refactor the grid/);
  const none = view({ summary: fixture({ live: { running: [], at: 0 } }) });
  assert.match(none, /现在没有子任务在运行/); assert.doesNotMatch(none, /class="live-item /);
  assert.match(view({ now: at(10, 31, 14) + 61_000 }), /已运行 <span>1:01:01<\/span>/, 'the clock moves with the page clock');
}));

test('a running worker named by an alias reads and looks like the same model in the key', () => zh(() => {
  const html = view({ summary: fixture({ live: { running: [live('agent:b', 'sonnet', { title: 'Plan it', role: '规划' }), live('agent:c', 'unreported')], at: at(10, 31, 14) } }) });
  const strip = html.slice(html.indexOf('class="live-list"'), html.indexOf('class="live-list"') + 1700), key = html.slice(html.indexOf('class="keybar"'), html.indexOf('class="keybar"') + 1500);
  assert.match(strip, /<span title="Sonnet">Sonnet<\/span>/, 'the model name, not the lowercase alias');
  const fillBefore = (text, word) => [...text.slice(0, text.indexOf(word)).matchAll(/class="mk"[^>]*fill="([^"]+)"/g)].at(-1)[1];
  assert.equal(fillBefore(strip, '</svg><span title="Sonnet">'), fillBefore(key, '</svg>Sonnet'), 'the same colour as the key chip');
  assert.match(strip, /<svg class="mk"[^>]*fill="var\(--text-3\)"[^>]*><circle[^]*?unreported/, 'unreported is a neutral grey, not a model colour');
  const picked = view({ summary: fixture({ live: { running: [live('agent:b', 'sonnet')], at: at(10, 31, 14) } }) });
  assert.match(picked, /class="live-item "/, 'with nothing picked nothing is dim');
}));

test('two points on one spot get labels a line apart tied back by a thin line; a lone point has none', () => zh(() => {
  const crowded = fixture();
  crowded.models[0] = row('gpt-6.1-sol', 'codex', { runs: 18, tokensPerSecond: 71, costUsd: 11 * 1.0, costedRuns: 11 });
  crowded.models[1] = row('claude-sonnet-5-5', 'claude', { runs: 11, tokensPerSecond: 71, costUsd: 11 * 1.0, costedRuns: 11 });
  const html = view({ summary: crowded })
  const ys = [...html.matchAll(/<text class="end" x="[\d.]+" y="([\d.]+)" text-anchor="\w+">(Sol|Sonnet)<\/text>/g)].map(match => [match[2], Number(match[1])]);
  assert.equal(ys.length, 2); assert.ok(Math.abs(ys[0][1] - ys[1][1]) >= 16, 'the labels do not overlap');
  assert.equal(count(html, /<line class="leader"/g), 1, 'the pushed label is tied to its point');
  assert.equal(count(view(), /<line class="leader"/g), 0, 'labels that meet nothing stay where they were');
}));

test('the freshness chip says live, refreshing or stale with the age of the numbers, and the button reads again', () => zh(() => {
  const html = view();
  assert.match(html, /<div class="fresh" data-state="live"><span class="state"><i class="live-dot is-live"><\/i><b role="status">实时<\/b><span class="muted">更新于 刚刚<\/span><\/span><button type="button" class="refresh" aria-label="立即刷新">刷新<\/button><\/div>/);
  assert.match(view({ now: at(10, 31, 14) + 30_000 }), /更新于 30 秒前/); assert.match(view({ now: at(10, 31, 14) + 90_000 }), /更新于 1 分钟前/);
  const refreshing = view({ loading: true });
  assert.match(refreshing, /data-state="refetch"[^]*?刷新中…/); assert.match(refreshing, /<button type="button" class="refresh" aria-label="立即刷新" disabled="">/); assert.match(refreshing, /class="dash-main is-refetch"/);
  assert.match(view({ now: at(10, 31, 14) + 121_000 }), /data-state="stale"[^]*?已过期[^]*?更新于 2 分钟前/, 'no change and no minute tick for two minutes');
  assert.match(view({ error: 'boom' }), /data-state="stale"/); assert.doesNotMatch(view({ summary: null }), /class="fresh"/, 'nothing to be fresh about before the first read');
  const chip = dashboard('FreshnessChip.tsx'), refreshed = [];
  const button = elements(chip.FreshnessChip({ generatedAt: 0, now: 1000, loading: false, failed: false, onRefresh: () => refreshed.push('now') })).find(node => node.type === 'button');
  button.props.onClick(); assert.deepEqual(refreshed, ['now']);
  assert.deepEqual([[0, 119_999, false, false], [0, 120_000, false, false], [0, 1, true, false], [0, 1, false, true], [0, 500_000, true, false]].map(args => chip.freshness(...args)), ['live', 'stale', 'refetch', 'stale', 'refetch']);
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
    assert.match(html, /Codex · 7 days limit window/); assert.match(html, /previous 30 days: 38/); assert.match(html, /Last 30 days · All projects</);
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
    useEffect() {}, useLayoutEffect() {}, useContext: context => context._currentValue,
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
    const items = () => elements(h.render(() => AppMenu(props))).filter(node => node.props.label !== undefined);
    assert.deepEqual(items().map(node => node.props.label), ['新建项目', '返回项目', '全屏', '设置', '虚拟实验室', '数据看板', '重启并安装更新']);
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
  const literal = declarations.filter(({ name, value }) => /#[0-9a-f]{3,8}\b/i.test(value) && !/^--(m-[0-5]|r[1-5]|rework)$/.test(name));
  assert.deepEqual(literal, [], 'colours come from the theme tokens; only the six model colours, the five-step slate ramp and the rework red are literal');
  assert.match(css, /\.dash \{ --m-0: #3987e5; --m-1: #d95926; --m-2: #199e70; --m-3: #c98500; --m-4: #d55181; --m-5: #9085e9;/);
  assert.match(css, /:root\[data-theme="light"\] \.dash \{ --m-0: #2a78d6; --m-1: #eb6834; --m-2: #1baf7a; --m-3: #eda100; --m-4: #e87ba4; --m-5: #6250d6;/);
  assert.doesNotMatch(css, /--chart-[123]|dash-pattern|pattern-ink/, 'the three-series colours and the bar textures are gone');
  assert.equal(declarations.find(({ selector, name }) => selector === 'details.data summary' && name === 'height').value, '32px', 'the data-table toggle is a 32px control');
  assert.match(fs.readFileSync(path.join(src, 'shared/styles/styles.css'), 'utf8'), /\.button \{[^}]*height: 32px/);
});

// WCAG contrast of the page's own colours, from the stylesheet and the base tokens of themes.css (the dashboard window is outside the workbench).
test('every heat step has an ink that reads on it at 4.5:1 in both themes, and the model colours hold 3:1 in dark', () => {
  const css = fs.readFileSync(path.join(dashboardDir, 'dashboard.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const luminance = hex => { const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const ratio = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
  const block = selector => css.slice(css.indexOf(selector) + selector.length, css.indexOf('}', css.indexOf(selector)));
  const tokens = { dark: { 'text-1': '#f2f2f2', 'bg-app': '#181818', 'bg-card': '#262626' }, light: { 'text-1': '#24272d', 'bg-app': '#f8f9fb', 'bg-card': '#ffffff' } };
  const themes = { dark: block('.dash {'), light: block(':root[data-theme="light"] .dash {') };
  const value = (theme, name) => themes[theme].match(new RegExp(`--${name}: ([^;]+);`))?.[1] ?? (theme === 'light' ? value('dark', name) : undefined);
  const hex = (theme, name) => { const raw = value(theme, name); return raw.startsWith('var(') ? tokens[theme][raw.slice(6, -1)] : raw; };
  for (const theme of ['dark', 'light']) for (const step of [1, 2, 3, 4, 5]) {
    assert.ok(ratio(hex(theme, `r${step}`), hex(theme, `r-ink-${step}`)) >= 4.5, `${theme} step ${step} ink ${ratio(hex(theme, `r${step}`), hex(theme, `r-ink-${step}`)).toFixed(2)}`);
  }
  for (let slot = 0; slot < 6; slot++) assert.ok(ratio(hex('dark', `m-${slot}`), tokens.dark['bg-card']) >= 3, `dark model colour ${slot} on the card`);
  // On white, green, yellow and pink fall under 3:1, which is why no chart relies on colour alone: each carries a mark and the name, and has a data table.
  assert.deepEqual([0, 1, 2, 3, 4, 5].filter(slot => ratio(hex('light', `m-${slot}`), tokens.light['bg-card']) < 3), [2, 3, 4]);
});

test('the page reads only the dashboard bridge and never the main window’s', () => {
  const files = fs.readdirSync(dashboardDir).filter(name => /\.tsx?$/.test(name));
  for (const name of files) assert.doesNotMatch(fs.readFileSync(path.join(dashboardDir, name), 'utf8'), /window\.agentrix\b(?!Dashboard)/, name);
  const imports = files.flatMap(name => [...fs.readFileSync(path.join(dashboardDir, name), 'utf8').matchAll(/from '(\.\.\/\.\.\/[^']+|\.\.\/[^']+)'/g)].map(match => match[1]));
  assert.deepEqual([...new Set(imports.filter(spec => !spec.startsWith('../../shared/')))], [], 'only src/shared is imported from outside the feature');
});

test('the page keeps time with the shared clock hook, not a copy of its own', () => {
  assert.equal(fs.existsSync(path.join(dashboardDir, 'use-now.ts')), false, 'the duplicate hook is gone');
  const asked = [], clockLoad = makeLoader({ '../../shared/useNow': { useNow: initial => { asked.push(initial); return at(10, 31, 14); } } });
  const { DashboardView } = clockLoad('features/dashboard/Dashboard.tsx');
  zh(() => renderToStaticMarkup(React.createElement(DashboardView, { summary: fixture(), query: { projectId: null, range: '30d' }, error: null, tab: 'models', named: true,
    onTab() {}, onQuery() {}, decide: async () => null, actions: { minimize() {}, maximize() {}, close() {} } })));
  assert.deepEqual(asked, [Date.now], 'the page starts the shared clock at Date.now');
});

// ---- round r7 acceptance: labels clear of marks, whole cells, an opaque key -----------------------------------------------------
test('the speed chart writes every end label in a gutter right of the plot, level with a tail to its line, clear of every mark and line', () => zh(() => {
  const html = view(), chart = html.slice(html.lastIndexOf('<svg class="chart"'), html.lastIndexOf('</svg>') + 6);
  const labels = [...chart.matchAll(/<text class="end"[^>]*x="([\d.]+)" y="([\d.]+)"[^>]*>([^<]+)<\/text>/g)].map(match => ({ x: +match[1], y: +match[2], text: match[3] }));
  assert.equal(labels.length, 3, 'Sol, Sonnet and Terra each named once');
  const width = 640, plotRight = width - 120;
  assert.deepEqual([...new Set(labels.map(label => label.x))], [plotRight + 24], 'one column, 24px past the plot');
  // every mark (circle, square or polygon) and every line stays inside the plot plus the mark's radius; no label reaches back over them
  const xs = [...chart.matchAll(/(?:cx|x)="([\d.]+)"|points="([^"]+)"/g)].flatMap(match => match[1] ? [+match[1]] : match[2].split(' ').map(point => +point.split(',')[0]));
  const markXs = xs.filter(x => x < plotRight + 24 - 4);
  assert.ok(Math.max(...markXs) + 5 < plotRight + 24, 'the right-most mark ends before the gutter');
  const ys = labels.map(label => label.y).sort((p, q) => p - q);
  for (let i = 1; i < ys.length; i++) assert.ok(ys[i] - ys[i - 1] >= 14, 'labels a line apart');
  const tails = [...chart.matchAll(/<polyline class="tail" points="([^"]+)"/g)].map(match => match[1].split(' ').map(point => point.split(',').map(Number)));
  assert.equal(tails.length, 3, 'a tail from each line\'s last mark');
  for (const tail of tails) {
    assert.equal(tail.length, 3); assert.equal(tail[0][1], tail[1][1], 'level with the mark first');
    assert.ok(tail[2][0] < plotRight + 24 && tail[2][0] > tail[1][0], 'then into the gutter, short of the text');
  }
  assert.ok(labels.every(label => label.text.length <= 16), 'a long name is cut');
  const chartMath = fs.readFileSync(path.join(dashboardDir, 'SpeedChart.tsx'), 'utf8');
  assert.match(chartMath, /const clip = \(name: string\) => name\.length > NAME_MAX/, 'with an ellipsis');
  assert.match(fs.readFileSync(path.join(dashboardDir, 'dashboard.css'), 'utf8'), /\.chart \.tail \{ fill: none; stroke-width: 1; stroke-dasharray: 2 3;/);
}));

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
  const css = fs.readFileSync(path.join(dashboardDir, 'dashboard.css'), 'utf8');
  assert.match(css, /\.sticky \.is-cut \{ color: transparent; \}\s*\.sticky \.is-cut \* \{ visibility: hidden; \}/, 'its cells keep their lines and show no value');
});

test('the key is opaque to the top of the scroll area: the page has no top padding to show through, and the key carries the 16px', () => {
  const css = fs.readFileSync(path.join(dashboardDir, 'dashboard.css'), 'utf8');
  assert.match(css, /\.dash-main \{[^}]*padding: 0 16px 16px;/, 'a sticky box stops at the padding, so there is none above it');
  assert.match(css, /\.dash-main > :first-child \{ margin-top: 16px; \}/, 'the toolbar keeps its 16px as a margin');
  assert.match(css, /\.keybar \{ position: sticky; top: 0;[^}]*margin-top: -16px; padding: 24px 0 8px; background: var\(--bg-app\); \}/, 'its own top padding covers what scrolls under it, up to its top edge');
});
