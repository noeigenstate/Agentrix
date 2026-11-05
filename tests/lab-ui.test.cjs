require('./fixtures/lab-isolation.cjs');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

// The Virtual Lab page, tested without Electron: the pure modules (pass rule, totals, scales, form limits), the store against a stubbed bridge,
// the screens rendered to markup from fixture experiments, and the stylesheet, page and menu read as text. Sources are transpiled like the other UI tests do it.
const root = path.join(__dirname, '..');
const src = path.join(root, 'src');
const labDir = path.join(src, 'features', 'lab');

function makeLoader() {
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
      if (name.endsWith('.css')) return {};
      if (name === '@phosphor-icons/react') return new Proxy({}, { get: () => () => null });
      return name.startsWith('.') ? load(resolve(filename, name)) : original(name);
    };
    mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { fileName: filename, compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename);
    return mod.exports;
  }
  return relative => load(path.join(src, relative));
}

const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
before(() => { Object.defineProperty(globalThis, 'document', { configurable: true, value: { documentElement: { dataset: {}, lang: '' } } }); });
after(() => { if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument); else delete globalThis.document; });

const load = makeLoader();
const lab = name => load(`features/lab/${name}`);
const { applyLanguage } = load('shared/i18n.ts');
const zh = run => { applyLanguage('zh'); return run(); };
const html = element => renderToStaticMarkup(element);
const count = (text, pattern) => (text.match(pattern) ?? []).length;
const read = file => fs.readFileSync(file, 'utf8');
const css = () => read(path.join(labDir, 'lab.css')).replace(/\/\*[\s\S]*?\*\//g, '');

// ---- fixtures ------------------------------------------------------------------------------------------------------------
const task = (id, kind) => ({ id, source: 'history', title: `任务 ${id}`, text: 'text', commit: `c${id}`, base: `b${id}`, modules: ['a', 'b'], linesChanged: 40, hiddenTests: ['tests/x.test.cjs'], kind, why: '跨 2 个模块 · 改动 40 行' });
const ossTask = (id, repo = 'psf/requests', license = 'Apache-2.0') => ({ id: `oss-${id}`, source: 'oss', title: `问题 ${id}`, text: 'text', kind: 'core', why: '真实的开源问题', repo, commit: `c${id}`, language: 'python', upstream: null, license });
const aaTask = (id, category = 'software') => ({ id: `aa-${id}`, source: 'aa', title: `终端任务 ${id}`, text: 'text', kind: 'core', why: '终端任务', benchmark: 'terminal-bench-4', item: id, category });
const run = (taskId, arm, repeat, patch = {}) => ({
  id: `${taskId}-${arm}-${repeat}`, taskId, source: 'history', arm, repeat, state: 'passed', startedAt: 0, endedAt: 60000, activeModel: null,
  testsPassed: 4, testsTotal: 4, score: 1, reviewIssues: 1, costUsd: 0.5, outputTokens: 1000, rework: null, ...patch,
});
const phases = ms => [{ name: 'plan', ms: ms[0] }, { name: 'roundtable', ms: ms[1], count: 2 }, { name: 'build', ms: ms[2] }, { name: 'review', ms: ms[3], count: 3 }, { name: 'rework', ms: ms[4], count: 3 }];
const METRICS = { history: 'hidden-tests', oss: 'resolved', aa: 'tests' };
const lane = (source = 'history', patch = {}) => ({ source, state: 'done', scope: 'agentrix', metric: METRICS[source], review: source !== 'aa', budgetUsd: 20, spentUsd: 3, error: null, manifest: null, published: null, ...patch });
const info = (id, patch = {}) => ({ id, available: true, reason: null, metric: METRICS[id], review: id !== 'aa', size: { min: 1, max: 10, standard: 3 }, options: [], manifest: null, published: null, downloadBytes: null, keyStored: id === 'aa' ? false : null, ...patch });
function experiment({ tasks = [task('t1', 'core'), task('t2', 'frontend')], arms = ['orchestrated', 'opus'], repeats = 3, state = 'done', runs, lanes, patch = {} } = {}) {
  const made = runs ?? tasks.flatMap(item => arms.flatMap(arm => Array.from({ length: repeats }, (_, index) => run(item.id, arm, index + 1, { source: item.source }))));
  const laneList = lanes ?? [lane('history', { state })];
  return { id: 'e1', name: '实验一', createdAt: new Date(2026, 9, 28).getTime(), projectId: 'p1', projectName: 'agentrix', sources: laneList.map(item => item.source), lanes: laneList, tasks, arms, repeats, budgetUsd: 20, state, runs: made, spentUsd: 3, ...patch };
}
const actions = { minimize() {}, maximize() {}, close() {} };
const noopBridge = { sample: async () => ({ ok: true, value: [] }), estimate: async () => ({ ok: true, value: { runs: 1, minutes: 1, costUsd: 1, basis: 'default', sources: [] } }) };
const noopStore = { begin: async () => ({ ok: true, value: 'e1' }), refresh: async () => undefined, remove: async () => null, saveAaKey: async () => null, stopExperiment: async () => null };
const view = (state, initial) => html(React.createElement(lab('Lab.tsx').LabView, { state: { experiments: [], projects: [], sources: null, error: null, appearance: null, ...state }, store: noopStore, bridge: noopBridge, named: true, actions, initial }));

// ---- the pass rule and totals --------------------------------------------------------------------------------------------
test('a task passes for an approach when all its hidden tests pass in most of its repeats', () => zh(() => {
  const { taskPasses } = lab('results-math.ts');
  const states = states => experiment({ tasks: [task('t1', 'core')], arms: ['opus'], repeats: states.length, runs: states.map((state, index) => run('t1', 'opus', index + 1, { state })) });
  assert.equal(taskPasses(states(['passed', 'passed', 'failed']), 'opus', 't1'), true);
  assert.equal(taskPasses(states(['passed', 'failed', 'failed']), 'opus', 't1'), false);
  assert.equal(taskPasses(states(['passed', 'failed']), 'opus', 't1'), false, 'half is not most');
  assert.equal(taskPasses(states(['passed']), 'opus', 't1'), true);
  assert.equal(taskPasses(states(['passed', 'passed', 'queued']), 'opus', 't1'), true);
  assert.equal(taskPasses(states(['passed', 'error', 'stopped']), 'opus', 't1'), false, 'a run that did not finish or could not run counts against it');
}));

test('totals keep unknown numbers null and count unpriced runs rather than treating them as free', () => {
  const { armSummary } = lab('results-math.ts');
  const unknown = experiment({ arms: ['opus'], runs: [run('t1', 'opus', 1, { costUsd: null, reviewIssues: null, rework: null, startedAt: null, endedAt: null }), run('t2', 'opus', 1, { costUsd: null, reviewIssues: null, rework: null, startedAt: null, endedAt: null })], repeats: 1 });
  const none = armSummary(unknown, 'opus');
  assert.deepEqual([none.costUsd, none.reviewIssues, none.rework, none.ms], [null, null, null, null]);
  assert.equal(none.unpriced, 2);
  const some = armSummary(experiment({ arms: ['opus'], repeats: 1, runs: [run('t1', 'opus', 1), run('t2', 'opus', 1, { costUsd: null })] }), 'opus');
  assert.equal(some.costUsd, 0.5); assert.equal(some.unpriced, 1);
  const queued = armSummary(experiment({ arms: ['opus'], repeats: 1, runs: [run('t1', 'opus', 1, { state: 'queued', costUsd: null }), run('t2', 'opus', 1, { state: 'stopped', costUsd: null })] }), 'opus');
  assert.equal(queued.unpriced, 0, 'a run that never ran is not an unpriced run');
});

test('kind scores average the tasks of a repeat, then the repeats; one repeat has no spread to draw', () => {
  const { kindScore, spread } = lab('results-math.ts');
  assert.equal(spread([]), null);
  assert.deepEqual(spread([0.5]), { mean: 0.5, sd: 0, n: 1 });
  const both = spread([0.5, 1]); assert.equal(both.mean, 0.75); assert.ok(Math.abs(both.sd - Math.sqrt(0.125)) < 1e-9);
  const three = experiment({ tasks: [task('t1', 'core')], arms: ['opus'], repeats: 3, runs: [
    run('t1', 'opus', 1, { testsPassed: 4, testsTotal: 4 }), run('t1', 'opus', 2, { testsPassed: 2, testsTotal: 4, state: 'failed' }), run('t1', 'opus', 3, { state: 'error', testsPassed: null, testsTotal: null })] });
  const score = kindScore(three, 'core', 'opus');
  assert.equal(score.n, 2, 'an unmeasured run is left out, not scored 0'); assert.equal(score.mean, 0.75);
  assert.equal(kindScore(three, 'frontend', 'opus'), null);
});

test('the conclusion names the leader, a tie, or says there is not enough; the cost ratio needs fully priced costs', () => zh(() => {
  const { conclude } = lab('results-math.ts'), { conclusionText } = lab('Results.tsx');
  const tasks = [task('t1', 'core'), task('t2', 'core'), task('t3', 'core')];
  const runs = (arm, passing, cost) => tasks.flatMap((item, index) => [1, 2, 3].map(repeat => run(item.id, arm, repeat, { state: index < passing ? 'passed' : 'failed', costUsd: cost })));
  const lead = experiment({ tasks, arms: ['orchestrated', 'opus'], runs: [...runs('orchestrated', 3, 1), ...runs('opus', 2, 0.5)] });
  assert.deepEqual(conclude(lead), { kind: 'lead', leader: 'orchestrated', other: 'opus', leaderPassed: 3, otherPassed: 2, tasks: 3, costRatio: 2 });
  assert.equal(conclusionText(conclude(lead)), '编排在 3 个任务中通过 3 个，Opus 5.5 单独通过 2 个；成本为 Opus 5.5 的 2.0 倍。');
  const unpriced = experiment({ tasks, arms: ['orchestrated', 'opus'], runs: [...runs('orchestrated', 3, 1), ...runs('opus', 2, null)] });
  assert.equal(conclude(unpriced).costRatio, null);
  assert.doesNotMatch(conclusionText(conclude(unpriced)), /成本/);
  const tie = experiment({ tasks, arms: ['opus', 'sol'], runs: [...runs('opus', 2, 1), ...runs('sol', 2, 1)] });
  assert.equal(conclude(tie).kind, 'tie');
  assert.equal(conclusionText(conclude(tie)), 'Opus 5.5 单独与 GPT-6.1-Sol 单独在 3 个任务中都通过了 2 个。', 'a tie reads without stray spaces beside a name');
  assert.equal(conclusionText({ kind: 'tie', arms: ['orchestrated', 'opus'], passed: 2, tasks: 3 }), '编排与 Opus 5.5 单独在 3 个任务中都通过了 2 个。');
  assert.equal(conclude(experiment({ arms: ['opus', 'sol'], runs: [] })).kind, 'none');
}));

test('the orchestration flow shows the median orchestrated run, never the luckiest or the worst', () => {
  const { representativeRun, phaseTotal } = lab('results-math.ts');
  const runs = [[1, 1, 1, 1, 1], [5, 5, 5, 5, 5], [9, 9, 9, 9, 9], [3, 3, 3, 3, 3]].map((ms, index) => run('t1', 'orchestrated', index + 1, { phases: phases(ms.map(value => value * 1000)) }));
  const chosen = representativeRun(experiment({ tasks: [task('t1', 'core')], arms: ['orchestrated', 'opus'], repeats: 4, runs: [...runs, run('t1', 'opus', 1)] }));
  assert.equal(phaseTotal(chosen.phases), 15000, 'four runs: the lower middle one');
  assert.equal(representativeRun(experiment({ arms: ['orchestrated', 'opus'] })), null, 'no phases recorded');
});

test('progress counts finished runs and estimates what is left only once one has finished', () => {
  const { progress } = lab('results-math.ts');
  const base = experiment({ tasks: [task('t1', 'core')], arms: ['opus', 'sol'], repeats: 2, state: 'running', runs: [
    run('t1', 'opus', 1, { startedAt: 1000, endedAt: 61000 }), run('t1', 'opus', 2, { state: 'running', startedAt: 61000, endedAt: null }),
    run('t1', 'sol', 1, { state: 'queued', startedAt: null, endedAt: null }), run('t1', 'sol', 2, { state: 'queued', startedAt: null, endedAt: null })] });
  const pace = progress(base, 91000);
  assert.deepEqual([pace.count, pace.done, pace.share, pace.elapsedMs, pace.remainingMs], [4, 1, 0.25, 90000, 180000]);
  assert.equal(progress(experiment({ state: 'running', runs: [run('t1', 'opus', 1, { state: 'queued', startedAt: null, endedAt: null })] }), 5000).remainingMs, null);
});

// ---- plots and the form ----------------------------------------------------------------------------------------------------
test('chart math: round axis ticks, linear scales, clipped error bars, a shape per approach', () => {
  const { niceScale, linear, barEnds, shapePath, arc } = lab('chart-math.ts');
  assert.deepEqual(niceScale(13.6, 4), { max: 15, ticks: [0, 5, 10, 15] });
  assert.deepEqual(niceScale(0, 4), { max: 1, ticks: [0, 1] });
  assert.deepEqual(niceScale(100, 4).ticks, [0, 25, 50, 75, 100]);
  assert.equal(linear([0, 10], [100, 200])(5), 150); assert.equal(linear([3, 3], [100, 200])(3), 100);
  const upper = barEnds(0.9, 0.3), lower = barEnds(0.1, 0.3);
  assert.ok(Math.abs(upper[0] - 0.6) < 1e-12); assert.equal(upper[1], 1);
  assert.equal(lower[0], 0); assert.ok(Math.abs(lower[1] - 0.4) < 1e-12);
  assert.match(arc(10, 0.5), /^31\.42 62\.83$/); assert.match(arc(10, 2), /^62\.83 62\.83$/);
  const { SHAPES, ALL_ARMS } = lab('results-math.ts');
  assert.equal(new Set(ALL_ARMS.map(arm => shapePath(SHAPES[arm], 8, 8, 6))).size, 4, 'four approaches, four different outlines');
  assert.equal(new Set(Object.values(SHAPES)).size, 4);
});

test('the form needs a source, a scope and a task for each chosen source, two approaches and a budget before each step, naming the source that lacks something', () => zh(() => {
  const w = lab('wizard-math.ts'), { lackText } = lab('source-text.ts');
  const draft = { ...w.emptyDraft(), history: { projectId: 'p1', tasks: [task('t1', 'core')] }, budgetUsd: 10 };
  assert.equal(w.missing(1, w.emptyDraft()), null, 'history is chosen by default');
  assert.deepEqual(w.missing(1, { ...draft, sources: [] }), { need: 'sources' });
  assert.deepEqual(w.missing(2, w.emptyDraft()), { need: 'scope', source: 'history' });
  assert.deepEqual(w.missing(2, { ...draft, history: { projectId: 'p1', tasks: [] } }), { need: 'tasks', source: 'history' });
  assert.deepEqual(w.missing(3, { ...draft, arms: ['opus'] }), { need: 'arms' });
  assert.deepEqual(w.missing(4, { ...draft, budgetUsd: 0 }), { need: 'budget' });
  assert.equal(w.missing(4, draft), null);
  const both = { ...draft, sources: ['history', 'oss'] };
  assert.deepEqual(w.missing(2, both), { need: 'scope', source: 'oss' }, 'a chosen source with no repository stops the step and is named');
  assert.deepEqual(w.missing(2, { ...both, oss: { repos: ['psf/requests'], tasks: [] } }), { need: 'tasks', source: 'oss' });
  assert.equal(w.missing(2, { ...both, oss: { repos: ['psf/requests'], tasks: [ossTask('a')] } }), null);
  assert.equal(w.missing(2, { ...draft, sources: ['history', 'aa'], aa: { benchmark: '', tasks: [] } }).source, 'aa');
  assert.equal(w.missing(2, { ...draft, sources: ['history'], oss: { repos: [], tasks: [] } }), null, 'an unchosen source needs nothing');
  assert.equal(lackText({ need: 'scope', source: 'oss' }, false), '先选至少一个开源仓库。');
  assert.equal(lackText({ need: 'tasks', source: 'aa' }, true), 'AA 测试：这个基准还没有可用的任务。');
  assert.equal(lackText({ need: 'scope', source: 'history' }, false), '先选一个项目。');
  assert.equal(lackText({ need: 'sources' }, false), '先选至少一个任务来源。');
  assert.deepEqual(w.toggleArm(['opus', 'sol'], 'opus'), ['sol']); assert.deepEqual(w.toggleArm(['opus'], 'sonnet'), ['opus', 'sonnet']);
  assert.deepEqual(w.toggleSource(['aa'], 'history'), ['history', 'aa'], 'ticked out of order, kept in the fixed order'); assert.deepEqual(w.toggleSource(['history', 'aa'], 'aa'), ['history']);
  assert.deepEqual([w.clampSize(0), w.clampSize(0.4), w.clampSize(11), w.clampSize(4.4), w.clampSize(NaN)], [1, 1, 10, 4, 3]);
  assert.deepEqual([w.clampSize(30, { min: 1, max: 20, standard: 5 }), w.clampSize(NaN, { min: 1, max: 20, standard: 5 })], [20, 5], 'a source sets its own range');
  assert.deepEqual([w.clampRepeats(9), w.clampRepeats(-1), w.clampRepeats(0), w.clampRepeats(2), w.clampRepeats(NaN)], [5, 1, 1, 2, 3]);
  const estimate = costUsd => ({ runs: 1, minutes: 1, costUsd, basis: 'default', sources: [] });
  assert.equal(w.proposedBudget(estimate(0.2)), 5); assert.equal(w.proposedBudget({ ...estimate(35), basis: 'history' }), 55);
  assert.equal(w.taskTotal({ ...both, oss: { repos: ['r'], tasks: [ossTask('a'), ossTask('b')] } }), 3);
}));

test('the experiment is built from the chosen sources in the order history, oss, aa, naming tasks by id only', () => zh(() => {
  const w = lab('wizard-math.ts');
  const draft = { ...w.emptyDraft(), sources: ['aa', 'oss', 'history'], arms: ['opus', 'sol'], repeats: 2, budgetUsd: 12,
    history: { projectId: 'p1', tasks: [task('t1', 'core')] }, oss: { repos: ['psf/requests', 'pallets/flask'], tasks: [ossTask('a'), ossTask('b')] }, aa: { benchmark: 'terminal-bench-4', tasks: [aaTask('x')] } };
  assert.deepEqual(w.toInput(draft, 'n'), { name: 'n', arms: ['opus', 'sol'], repeats: 2, budgetUsd: 12, selections: [
    { source: 'history', projectId: 'p1', tasks: [{ id: 't1' }] },
    { source: 'oss', repos: ['psf/requests', 'pallets/flask'], tasks: [{ id: 'oss-a' }, { id: 'oss-b' }] },
    { source: 'aa', benchmark: 'terminal-bench-4', tasks: [{ id: 'aa-x' }] }] });
  assert.deepEqual(w.toInput({ ...draft, sources: ['oss'] }, 'n').selections.map(item => item.source), ['oss'], 'an unchosen source adds nothing');
  assert.equal(JSON.stringify(w.toInput(draft, 'n')).includes('hiddenTests'), false, 'no task body goes back to main');
  // The sample asked of each source carries that source's scope and size; the short-and-complex preference belongs to history only.
  assert.deepEqual(w.sampleQuery(draft, 'history', 4, ['x'], true), { source: 'history', projectId: 'p1', size: 4, preferShortComplex: true, exclude: ['x'] });
  assert.deepEqual(w.sampleQuery(draft, 'oss', 5, [], true), { source: 'oss', repos: ['psf/requests', 'pallets/flask'], size: 5, exclude: [] });
  assert.deepEqual(w.sampleQuery(draft, 'aa', 6, [], false), { source: 'aa', benchmark: 'terminal-bench-4', size: 6, exclude: [] });
  assert.equal(w.sampleQuery(w.emptyDraft(), 'oss', 5, [], false), null, 'no scope, no question');
  const infos = [{ id: 'oss', size: { min: 1, max: 20, standard: 5 } }];
  assert.deepEqual([w.sizeRange(infos, 'oss'), w.sizeRange(infos, 'aa'), w.sizeRange(null, 'oss')], [{ min: 1, max: 20, standard: 5 }, w.SIZE, w.SIZE]);
  assert.deepEqual(w.availableSources([{ id: 'history', available: true }, { id: 'oss', available: false }, { id: 'aa', available: true }]), ['history', 'aa']);
}));

// ---- the store -------------------------------------------------------------------------------------------------------------
test('the newest answer wins: a slow list never replaces a later push, and a failed call is an error message', async () => {
  const { createLabStore } = lab('lab-store.ts');
  let release; const slow = new Promise(resolve => { release = resolve; });
  let push = () => undefined;
  const fresh = experiment({ state: 'running' }), stale = experiment({ state: 'done' });
  const bridge = {
    list: () => slow, projects: async () => ({ ok: true, value: [{ id: 'p1', name: 'agentrix' }] }), sources: async () => ({ ok: true, value: [info('history')] }), appearance: async () => ({ ok: true, value: { theme: 'mono', language: 'zh', uiZoom: 1 } }),
    onChange: callback => { push = callback; return () => undefined; }, onAppearance: () => () => undefined,
    stop: async () => { throw new Error('boom'); }, remove: async () => ({ ok: false, error: 'busy' }), start: async () => ({ ok: true, value: 'e9' }),
  };
  const store = createLabStore(bridge);
  store.start();
  push([fresh]);
  release({ ok: true, value: [stale] });
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(store.getState().experiments[0].state, 'running', 'the push came after the list was asked for');
  assert.deepEqual(store.getState().projects, [{ id: 'p1', name: 'agentrix' }]);
  assert.equal(store.getState().appearance.language, 'zh');
  assert.deepEqual(store.getState().sources, [info('history')], 'the sources are read once with the rest');
  bridge.list = async () => ({ ok: true, value: [] });
  assert.equal(await store.stopExperiment('e1'), 'boom');
  assert.equal(await store.remove('e1'), 'busy');
  assert.deepEqual(await store.begin({}), { ok: true, value: 'e9' });
  store.stop();
});

// ---- the screens -----------------------------------------------------------------------------------------------------------
test('home: an empty state with one way forward, and a card per experiment with its chart; running ones cannot be deleted', () => zh(() => {
  const empty = view({ experiments: [] });
  assert.match(empty, /还没有实验/); assert.equal(count(empty, /新建实验/g), 1);
  assert.equal(count(empty, /class="mark"/g), 4, 'the four approach marks introduce the lab');
  const home = view({ experiments: [experiment(), experiment({ state: 'running', patch: { id: 'e2', name: '跑着的' } })] });
  assert.equal(count(home, /class="exp-card"/g), 2);
  assert.match(home, /task pass|任务通过率/);
  assert.match(home, /<button[^>]*disabled=""[^>]*>[^<]*<svg|<button[^>]*disabled=""/, 'the running experiment cannot be deleted');
  assert.match(view({ experiments: null }), /正在读取/);
  assert.match(view({ experiments: [], error: 'x' }), /读取数据失败：x/);
}));

test('the source step offers every source the bridge reports to be chosen together; a source that cannot run is disabled with its reason and never ticked', () => zh(() => {
  const steps = lab('WizardSteps.tsx'), infos = [info('history'), info('oss', { available: false, reason: 'Python 3 没有找到' }), info('aa')];
  const show = (chosen, sources = infos) => html(React.createElement(steps.SourceStep, { sources, chosen, onToggle() {} }));
  const one = show(['history']);
  assert.equal(count(one, /class="choice /g), 3);
  assert.equal(count(one, /disabled=""/g), 1); assert.match(one, /Python 3 没有找到/); assert.doesNotMatch(one, /下一轮/);
  assert.equal(count(one, /class="tick"/g), 1, 'only the chosen source carries a tick');
  const two = show(['history', 'aa']);
  assert.equal(count(two, /aria-pressed="true"/g), 2, 'sources are multi-select'); assert.equal(count(two, /class="tick"/g), 2);
  assert.equal(count(show(['oss']), /class="tick"/g), 0, 'a chosen source that cannot run shows no tick');
  assert.ok(two.indexOf('本项目的历史改动') < two.indexOf('知名开源项目') && two.indexOf('知名开源项目') < two.indexOf('AA 测试'), 'history, oss, aa');
  assert.ok(show([], [infos[2], infos[0]]).indexOf('本项目的历史改动') < show([], [infos[2], infos[0]]).indexOf('AA 测试'), 'the order is fixed whatever order the bridge answers in');
  assert.match(show([], null), /正在读取/);
  assert.equal(count(show(['aa'], [info('oss', { available: false, reason: null })]), /暂不可用/g), 1);
}));

test('the approach step shows a tick per chosen approach and asks for at least two', () => zh(() => {
  const steps = lab('WizardSteps.tsx');
  const arms = html(React.createElement(steps.ArmStep, { arms: ['orchestrated', 'sol'], onToggle() {} }));
  assert.equal(count(arms, /aria-pressed="true"/g), 2); assert.equal(count(arms, /aria-pressed="false"/g), 2);
  assert.equal(count(arms, /class="tick"/g), 2, 'a tick per chosen approach and none on the others');
  assert.match(arms, /<svg class="diagram"/);
  assert.doesNotMatch(arms, /至少选 2 个方案/);
  assert.match(html(React.createElement(steps.ArmStep, { arms: ['sol'], onToggle() {} })), /至少选 2 个方案做对比/);
}));

test('the estimate step shows runs, time and cost as large figures and one ring for the budget share, which is flagged when over', () => zh(() => {
  const { ScaleStep } = lab('WizardSteps.tsx');
  const draft = { ...lab('wizard-math.ts').emptyDraft(), history: { projectId: 'p1', tasks: [task('t1', 'core')] }, budgetUsd: 10 };
  const show = estimate => html(React.createElement(ScaleStep, { draft, infos: [], estimate, error: null, defaultName: 'agentrix · 10 月 28 日', onRepeats() {}, onBudget() {}, onName() {} }));
  const fine = show({ runs: 18, minutes: 111, costUsd: 8, basis: 'history', sources: [{ source: 'history', runs: 18, minutes: 111, costUsd: 8, basis: 'history', share: 1 }] });
  assert.equal(count(fine, /class="stat"/g), 3, 'runs, time and cost'); assert.equal(count(fine, /class="gauge /g), 1, 'one ring only');
  assert.match(fine, /<b class="figure">18<\/b>/); assert.match(fine, /<b class="figure">1 小时 51 分<\/b>/); assert.match(fine, /<b class="figure">\$8\.00<\/b>/); assert.match(fine, />80%</);
  assert.match(fine, /按你自己的运行记录估算/); assert.doesNotMatch(fine, /gauge over/);
  assert.match(show({ runs: 18, minutes: 111, costUsd: 12, basis: 'default', sources: [] }), /gauge over/);
  const waiting = show(null); assert.equal(count(waiting, /—/g), 4, 'no estimate yet: dashes, not zeros');
  assert.match(fine, /placeholder="agentrix · 10 月 28 日"/);
  assert.equal(count(fine, /class="control"/g), 3, 'the stepper and both inputs sit in one column of controls');
  assert.doesNotMatch(fine, /独立的工作树/, 'said once, in the form’s footer');
  assert.doesNotMatch(fine, /<table/, 'one history source needs no per-source rows');
}));

test('results: a ring card per approach, four figures, and no Artificial Analysis section for a history experiment', () => zh(() => {
  const tasks = [task('t1', 'core'), task('t2', 'frontend'), task('t3', 'frontend')];
  const arms = ['orchestrated', 'opus', 'sol', 'sonnet'];
  const runs = tasks.flatMap(item => arms.flatMap(arm => [1, 2, 3].map(repeat => run(item.id, arm, repeat, {
    state: arm !== 'orchestrated' && item.id === 't3' ? 'failed' : 'passed', testsPassed: arm !== 'orchestrated' && item.id === 't3' ? 1 : 4, costUsd: arm === 'orchestrated' ? 1 : 0.4,
    rework: arm === 'orchestrated' ? 2 : null, phases: arm === 'orchestrated' ? phases([60000, 120000, 300000, 90000, 60000]) : undefined }))));
  Object.assign(runs.find(item => item.taskId === 't1' && item.arm === 'orchestrated' && item.repeat === 3), { state: 'failed', testsPassed: 1 });
  const out = view({ experiments: [experiment({ tasks, arms, runs })] }, { kind: 'experiment', id: 'e1' });
  assert.equal(count(out, /class="arm-card /g), 4);
  assert.equal(count(out, /class="ring"/g), 4);
  for (const figure of ['能力比较', '质量 × 成本', '任务 × 方案', '编排协作流程']) assert.match(out, new RegExp(figure));
  assert.doesNotMatch(out, /Artificial Analysis|AA 参考|实测与 AA/);
  assert.equal(count(out, /<svg class="chart"/g), 3, 'one small plot per task kind (two) and the scatter');
  assert.match(out, /class="flow arm-orchestrated"/);
  assert.equal(count(out, /class="dot"/g), 8 + 4, 'a dot per approach in each of two kinds, and in the scatter');
  assert.equal(count(out, /class="bar"/g), 1, 'only the dot whose repeats differ has an error bar');
  assert.match(out, /编排在 3 个任务中通过 3 个/);
  assert.equal(count(out, /<details class="data"/g), 1);
  assert.equal(count(out, /role="region"/g), 3, 'the data table, the scatter’s table and the matrix scroll in labelled regions');
}));

test('quality × cost: no per-point labels (the legend and shapes name the approaches), the values in a table, one cost format, headroom above 100%', () => zh(() => {
  const arms = ['orchestrated', 'opus'], tasks = [task('t1', 'core'), task('t2', 'core')];
  const runs = tasks.flatMap(item => arms.flatMap(arm => [1, 2, 3].map(repeat => run(item.id, arm, repeat, { costUsd: arm === 'orchestrated' ? 1.2 : 0.6 }))));
  const out = view({ experiments: [experiment({ tasks, arms, runs })] }, { kind: 'experiment', id: 'e1' });
  const scatter = out.slice(out.indexOf('质量 × 成本'), out.indexOf('任务 × 方案'));
  assert.doesNotMatch(scatter, /class="end"/);
  assert.equal(count(scatter, /class="dot"/g), 2);
  assert.match(scatter, /<title>编排 · 完整路由 · \$7\.20 · 100%<\/title>/, 'the tooltip uses the same money() format as the cards');
  assert.match(scatter, /\$7\.20/); assert.match(scatter, /\$3\.60/); assert.doesNotMatch(scatter, /7\.2 美元|\$7\.2</);
  assert.match(scatter, /aria-label="各方案的成本与任务通过率"/);
  // The plot is drawn at its own width, so its 12px text is never scaled.
  assert.match(scatter, /<svg class="chart" width="560" height="\d+" viewBox="0 0 560 \d+"/);
  const { linear } = lab('chart-math.ts');
  assert.ok(linear([0, 1.1], [100, 10])(1) > 10, 'a marker at 100% sits below the top edge of the plot');
}));

test('times are written one way: seconds, minutes, then hours with minutes', () => zh(() => {
  const { duration, minutesLabel, DASH } = lab('format.ts');
  assert.deepEqual([duration(null), duration(0), duration(45000), duration(60000), duration(44 * 60000), duration(111 * 60000), duration(120 * 60000), duration(59.6 * 1000)], [DASH, '0 分', '45 秒', '1 分', '44 分', '1 小时 51 分', '2 小时', '1 分']);
  assert.equal(minutesLabel(112), '1 小时 52 分');
  const source = fs.readdirSync(labDir).filter(name => /\.tsx?$/.test(name)).map(name => read(path.join(labDir, name))).join('\n');
  assert.doesNotMatch(source, /padStart\(2/, 'no second, English-style time format');
}));

test('the orchestration flow writes each phase’s time inside its block, counts under the blocks, and evenly spaced ticks in whole minutes', () => zh(() => {
  const { timeTicks } = lab('chart-math.ts');
  assert.deepEqual(timeTicks(630000), [0, 120000, 240000, 360000, 480000, 600000]);
  assert.deepEqual(timeTicks(40000), [0, 10000, 20000, 30000]);
  const out = view({ experiments: [experiment({ arms: ['orchestrated', 'opus'], repeats: 1, runs: ['t1', 't2'].flatMap(id => ['orchestrated', 'opus'].map(arm => run(id, arm, 1, { phases: arm === 'orchestrated' ? phases([60000, 120000, 300000, 90000, 60000]) : undefined }))) })] }, { kind: 'experiment', id: 'e1' });
  const flow = out.slice(out.indexOf('class="flow arm-orchestrated"'));
  assert.equal(count(flow, /<div class="phase /g), 5);
  assert.match(flow, /<span>计划<\/span><b>1 分<\/b>/); assert.match(flow, /<span>编写<\/span><b>5 分<\/b>/);
  assert.equal(count(flow, /数量 \d/g), 3 + 3, 'the counts of three phases, once as a title and once under the block');
  assert.match(flow, /class="flow-axis"><span[^>]*>0 分<\/span><span[^>]*>2 分<\/span>/);
  assert.doesNotMatch(flow, /<svg/, 'laid out, not a scaled drawing');
}));

test('engine messages are shown in plain words with a next step, and other messages are translated as they are', () => zh(() => {
  const { friendlyError } = lab('format.ts');
  assert.match(friendlyError('worktree 创建失败'), /无法创建独立工作区。请重试/);
  assert.match(friendlyError('Git: fatal: not a git repository'), /无法创建独立工作区/);
  assert.equal(friendlyError('实验运行超时。'), '实验运行超时。');
assert.equal(friendlyError('worktree 创建失败\n测试日志：/x/tests.log'), friendlyError('worktree 创建失败') + '\n测试日志：/x/tests.log');
assert.doesNotMatch(friendlyError('实验运行超时。\n测试日志：/x/tests.log 工作区'), /无法创建独立工作区/);
  assert.equal(friendlyError('Secure lab execution is unavailable on this platform. No workers were started.'), '虚拟实验室目前只支持 macOS 和 Windows。');
  assert.equal(friendlyError('Reliable lab process isolation is unavailable on this platform.'), '虚拟实验室目前只支持 macOS 和 Windows。');
  assert.equal(friendlyError('虚拟实验室目前只支持 macOS 和 Windows。'), '虚拟实验室目前只支持 macOS 和 Windows。');
  applyLanguage('en');
  try {
    assert.match(friendlyError('worktree 创建失败'), /Could not create the separate workspace\. Try again/);
    assert.equal(friendlyError('Secure lab execution is unavailable on this platform.'), 'The Virtual Lab works on macOS and Windows for now.');
  } finally { applyLanguage('zh'); }
}));

test('the back button is one component with its chevron, the same on the form and on an experiment', () => zh(() => {
  const button = text => /<button type="button" class="button small back">.*?<\/button>/.exec(text)?.[0];
  const form = button(view({ experiments: [] }, { kind: 'new' })), experimentPage = button(view({ experiments: [experiment()] }, { kind: 'experiment', id: 'e1' }));
  assert.ok(form); assert.equal(form, experimentPage);
  assert.match(read(path.join(labDir, 'Marks.tsx')), /<CaretLeft size=\{12\} \/>\{t\('返回实验列表'\)\}/);
}));

test('home cards: no unlabelled footer, delete is a quiet icon action, and a running card charts each approach’s progress', () => zh(() => {
  const home = view({ experiments: [experiment(), experiment({ state: 'running', patch: { id: 'e2', name: '跑着的' }, runs: [run('t1', 'orchestrated', 1), run('t1', 'orchestrated', 2, { state: 'running' }), run('t1', 'opus', 1, { state: 'queued' })] })] });
  assert.doesNotMatch(home, /card-foot/);
  assert.equal(count(home, /class="icon-button card-delete"/g), 2);
  assert.match(home, /各方案的运行进度/); assert.match(home, /<b>1\/2<\/b>/); assert.match(home, /<b>0\/1<\/b>/);
  assert.match(home, /title="先停止实验" aria-label="先停止实验" disabled=""/);
  assert.equal(count(home, /class="button primary"/g), 1, 'one strong action on the page');
}));

test('a ring’s caption is outside the ring, so a figure like "通过 100%" never has to fit the hole', () => zh(() => {
  const out = view({ experiments: [experiment()] }, { kind: 'experiment', id: 'e1' });
  assert.match(out, /<div class="ring-text"><b class="figure">2\/2<\/b><\/div><\/div><p class="muted ring-caption">任务通过 100%<\/p>/);
}));

test('the running screen: a finished approach says 已完成, a live one without a model name is still live, and nothing blue stands for a model', () => zh(() => {
  const ended = (arm, id, repeat) => run(id, arm, repeat, { state: 'passed' });
  const runs = [ended('opus', 't1', 1), ended('opus', 't2', 1), run('t1', 'sol', 1, { state: 'running', activeModel: null }), run('t2', 'sol', 1, { state: 'queued' })];
  const out = view({ experiments: [experiment({ arms: ['opus', 'sol'], repeats: 1, state: 'running', runs })] }, { kind: 'experiment', id: 'e1' });
  assert.match(out, /data-active="false"[^]*?已完成/); assert.doesNotMatch(out, /等待中/);
  assert.equal(count(out, /data-active="true"/g), 1);
  assert.doesNotMatch(css(), /var\(--running\)/, 'the interface never borrows the running blue, which could read as an approach');
}));

test('results never show 0 for what is unknown, say unpriced runs, and mark an unfinished experiment', () => zh(() => {
  const noCost = experiment({ state: 'stopped', repeats: 1, runs: [run('t1', 'orchestrated', 1, { costUsd: null, reviewIssues: null, startedAt: null, endedAt: null }), run('t1', 'opus', 1, { costUsd: null, reviewIssues: null, startedAt: null, endedAt: null }),
    run('t2', 'orchestrated', 1, { state: 'stopped', testsPassed: null, testsTotal: null, costUsd: null }), run('t2', 'opus', 1, { state: 'stopped', testsPassed: null, testsTotal: null, costUsd: null })] });
  const out = view({ experiments: [noCost] }, { kind: 'experiment', id: 'e1' });
  assert.equal(count(out, /1 次运行未计价/g), 2, 'each approach reports its own unpriced run'); assert.doesNotMatch(out, /\$0\.00|\$0</);
  assert.match(out, /实验没有跑完/); assert.match(out, /没有记录到编排运行的阶段时间/);
  assert.match(out, /成本不完整，没有画出来/);
  assert.match(view({ experiments: [{ ...noCost, state: 'error', runs: [run('t1', 'opus', 1, { state: 'error', error: '起不来' })] }] }, { kind: 'experiment', id: 'e1' }), /实验出错：起不来/);
}));

test('one repeat draws the dot alone and says so', () => zh(() => {
  const out = view({ experiments: [experiment({ repeats: 1 })] }, { kind: 'experiment', id: 'e1' });
  assert.equal(count(out, /class="bar"/g), 0); assert.match(out, /1 次重复/); assert.match(out, /只重复了 1 次/);
}));

test('running: an overall ring, a card per approach naming the model working now, and a tile per run with a mark when it ended', () => zh(() => {
  const tasks = [task('t1', 'core'), task('t2', 'core')];
  const runs = ['orchestrated', 'sol'].flatMap(arm => tasks.flatMap(item => [1, 2].map(repeat => run(item.id, arm, repeat, { state: 'queued', startedAt: null, endedAt: null, costUsd: null }))));
  runs[0] = { ...runs[0], state: 'passed', startedAt: 1000, endedAt: 61000 };
  runs[1] = { ...runs[1], state: 'failed', startedAt: 1000, endedAt: 61000 };
  runs[2] = { ...runs[2], state: 'running', startedAt: 61000, activeModel: 'gpt-6.1-sol', endedAt: null };
  runs[4] = { ...runs[4], state: 'error', error: 'x' };
  const out = view({ experiments: [experiment({ tasks, arms: ['orchestrated', 'sol'], repeats: 2, state: 'running', runs })] }, { kind: 'experiment', id: 'e1' });
  assert.equal(count(out, /class="ring"/g), 3);
  assert.match(out, /gpt-6\.1-sol/); assert.match(out, /data-active="true"/); assert.match(out, /data-active="false"/);
  assert.equal(count(out, /class="tile (passed|failed|error|running|queued)"/g), 8 + 5, 'a tile per run, plus one per state in the key');
  assert.match(out, /class="tile passed" role="img" aria-label="通过"/);
  assert.match(out, />停止</); assert.match(out, /花到这个数就停止，不再开始新的运行，正在进行的运行也会在超出时停下/);
  assert.equal(count(out, /role="region"/g), 1);
}));

test('an experiment that cannot be found says so instead of drawing an empty page', () => zh(() => {
  assert.match(view({ experiments: [] }, { kind: 'experiment', id: 'gone' }), /找不到这个实验/);
}));

test('the title bar names the lab only once the main window’s language is known, and carries the window controls', () => zh(() => {
  const named = view({ experiments: [] }), unnamed = html(React.createElement(lab('Lab.tsx').LabView, { state: { experiments: [], projects: [], sources: null, error: null, appearance: null }, store: noopStore, bridge: noopBridge, named: false, actions }));
  assert.match(named, /class="lab-title">虚拟实验室</); assert.match(unnamed, /class="lab-title"><\/span>/);
  assert.equal(count(named, /class="icon-button/g), 3);
}));

// ---- several sources ------------------------------------------------------------------------------------------------------
const OPTIONS = { oss: [{ id: 'psf/requests', name: 'requests', detail: 'HTTP 客户端', tasks: 6, license: 'Apache-2.0' }, { id: 'pallets/flask', name: 'flask', detail: null, tasks: 4, license: 'BSD-3-Clause' }],
  aa: [{ id: 'terminal-bench-4', name: 'Terminal-Bench 4.0', detail: '66 个任务', tasks: 66, license: null }] };
const panel = (tasks, patch = {}) => ({ sample: { tasks, loading: false, error: null, exhausted: false }, size: 5, range: { min: 1, max: 20, standard: 5 }, onSize() {}, onShuffle() {}, onRetry() {}, ...patch });
const ok = value => ({ ok: true, value });
const published = (patch = {}) => ({ label: 'Terminal-Bench 4.0', url: 'https://artificialanalysis.ai/evaluations/terminal-bench', asOf: '2026-10-30', harness: 'Terminus 2', comparable: false, note: null, values: { opus: 0.52, sol: 0.61, orchestrated: 0.99 }, ...patch });

test('the source step is the first screen of the form: history ticked, the others offered, and the footer says which step', () => zh(() => {
  const out = view({ sources: [info('history'), info('oss'), info('aa', { available: false, reason: 'Docker 没有安装' })], projects: [{ id: 'p1', name: 'agentrix' }] }, { kind: 'new' });
  assert.equal(count(out, /class="tick"/g), 1); assert.match(out, /Docker 没有安装/); assert.match(out, /第 1 \/ 4 步/);
  assert.match(out, /<button type="button" class="button primary">下一步<\/button>/, 'a chosen source lets the owner go on');
  assert.match(view({ sources: null }, { kind: 'new' }), /正在读取/);
}));

test('the oss panel is a multi-select of repositories whose tasks carry the repository and licence; the sample shows only for a chosen repository', () => zh(() => {
  const { OssStep } = lab('SourcePanels.tsx'), tasks = [ossTask('a'), ossTask('b', 'pallets/flask', 'BSD-3-Clause'), { ...ossTask('c'), license: null }];
  const show = repos => html(React.createElement(OssStep, { options: OPTIONS.oss, repos, panel: panel(tasks), onRepos() {} }));
  const both = show(['psf/requests', 'pallets/flask']);
  assert.equal(count(both, /aria-pressed="true"/g), 2, 'repositories are multi-select'); assert.equal(count(both, /class="tick"/g), 2);
  assert.match(both, /默认 5，可选 1–20/, 'the range is the source’s own');
  assert.match(both, /<span class="tags"><span class="tag ">psf\/requests<\/span><span class="tag ">Apache-2\.0<\/span><\/span>/);
  assert.match(both, /<span class="tag ">pallets\/flask<\/span><span class="tag ">BSD-3-Clause<\/span>/);
  assert.equal(count(both, /未标明许可证/g), 1, 'a missing licence is said, not invented');
  assert.match(both, /SWE-bench Verified/); assert.match(both, /6 个任务/);
  const none = show([]);
  assert.equal(count(none, /aria-pressed="true"/g), 0); assert.doesNotMatch(none, /class="panel sample"/);
  assert.match(html(React.createElement(OssStep, { options: [], repos: [], panel: panel([]), onRepos() {} })), /还没有可选的内容/);
}));

test('the aa panel chooses a benchmark and holds the key field: a password input, 已保存 or 未保存, and a note that a subset is not the published number', () => zh(() => {
  const { AaStep } = lab('SourcePanels.tsx');
  const show = (keyStored, benchmark = 'terminal-bench-4') => html(React.createElement(AaStep, { info: info('aa', { options: OPTIONS.aa, keyStored }), benchmark, panel: panel([aaTask('x', 'software')]), onBenchmark() {}, async onKey() { return null; } }));
  const none = show(false), stored = show(true);
  assert.match(none, /<input class="input" type="password" autoComplete="off" spellCheck="false" aria-label="AA 密钥" value=""\/>/);
  assert.match(none, /未保存/); assert.doesNotMatch(none, /已保存/); assert.match(stored, /已保存/);
  assert.match(none, /<button type="button" class="button" disabled="">保存<\/button><button type="button" class="button" disabled="">清除<\/button>/, 'nothing typed and nothing stored: neither button works');
  assert.doesNotMatch(stored, /<button type="button" class="button" disabled="">清除/, 'a stored key can be cleared');
  assert.match(none, /分数不等于 AA 公布的成绩/); assert.match(none, /只显示本地得分/);
  assert.match(none, /<span class="tag ">software<\/span>/);
  assert.equal(count(show(false, ''), /class="panel sample"/g), 0, 'no benchmark, no sample');
  assert.match(html(React.createElement(AaStep, { info: undefined, benchmark: '', panel: panel([]), onBenchmark() {}, async onKey() { return null; } })), /未保存/, 'an unknown key state reads as not saved');
}));

test('the AA key is only passed through: the store never holds it, an error never repeats it, and the page never renders it into a label, title or log', async () => {
  const { createLabStore } = lab('lab-store.ts'), calls = [];
  let stored = false;
  const bridge = {
    list: async () => ok([]), projects: async () => ok([]), appearance: async () => ok({ theme: 'mono', language: 'zh', uiZoom: 1 }), onChange: () => () => undefined, onAppearance: () => () => undefined,
    sources: async () => ok([info('aa', { keyStored: stored })]),
    aaKey: async key => { calls.push(key); if (key === 'sk-leaky') return { ok: false, error: 'rejected sk-leaky' }; stored = key !== null; return ok(stored); },
  };
  const store = createLabStore(bridge), everything = () => JSON.stringify(store.getState());
  store.start(); await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(store.getState().sources[0].keyStored, false);
  assert.equal(await store.saveAaKey('sk-leaky'), 'rejected …', 'an error that echoes the key is scrubbed');
  assert.equal(everything().includes('sk-leaky'), false);
  assert.equal(await store.saveAaKey('sk-good'), null);
  assert.equal(store.getState().sources[0].keyStored, true, 'what the page shows is what main says is stored'); assert.equal(everything().includes('sk-good'), false);
  assert.equal(await store.saveAaKey(null), null); assert.equal(store.getState().sources[0].keyStored, false);
  assert.deepEqual(calls, ['sk-leaky', 'sk-good', null]);
  store.stop();
  const panels = read(path.join(labDir, 'SourcePanels.tsx'));
  assert.doesNotMatch(panels, /console\.|localStorage|sessionStorage/);
  for (const [, label] of panels.matchAll(/aria-label=\{([^}]*)\}/g)) assert.match(label, /^t\('/, 'a label is a fixed phrase, never the typed value');
  assert.doesNotMatch(panels, /title=/);
  assert.match(panels, /setValue\(''\); setBusy\(true\);\s*setFailure\(await onSave\(key\)\)/, 'the field is emptied before the key is handed over');
  for (const name of ['lab-store.ts', 'Wizard.tsx', 'Lab.tsx']) assert.doesNotMatch(read(path.join(labDir, name)), /localStorage|sessionStorage|console\./, name);
});

test('a source’s slice of an experiment has its own tasks, runs, budget, spend and state, so the single-source screens can draw it', () => {
  const { sliceExperiment, metricOf, scopeLabel } = lab('source-math.ts');
  const tasks = [task('t1', 'core'), ossTask('a')];
  const both = experiment({ tasks, arms: ['opus', 'sol'], repeats: 1, state: 'stopped', lanes: [lane('history', { state: 'done', budgetUsd: 12, spentUsd: 5, scope: 'agentrix' }), lane('oss', { state: 'stopped', budgetUsd: 8, spentUsd: 7.5, scope: 'psf/requests' })], patch: { budgetUsd: 20, spentUsd: 12.5 } });
  const oss = sliceExperiment(both, 'oss');
  assert.deepEqual([oss.tasks.map(item => item.id), oss.runs.every(item => item.source === 'oss'), oss.runs.length], [['oss-a'], true, 2]);
  assert.deepEqual([oss.budgetUsd, oss.spentUsd, oss.state, oss.sources, oss.lanes.length], [8, 7.5, 'stopped', ['oss'], 1]);
  assert.equal(sliceExperiment(both, 'history').state, 'done');
  assert.equal(sliceExperiment(experiment({ lanes: [lane('history', { state: 'running' })] }), 'history').state, 'running');
  assert.equal(sliceExperiment(experiment({ lanes: [lane('history', { state: 'queued' })] }), 'history').state, 'running', 'a queued lane is not finished');
  assert.deepEqual([metricOf(oss), metricOf(sliceExperiment(both, 'history')), metricOf({ lanes: [] })], ['resolved', 'hidden-tests', 'hidden-tests']);
  assert.equal(scopeLabel(experiment()), 'agentrix'); assert.equal(scopeLabel(both), 'agentrix · psf/requests');
  assert.equal(scopeLabel(experiment({ lanes: [lane('aa', { scope: 'Terminal-Bench 4.0' })], patch: { projectName: null } })), 'Terminal-Bench 4.0');
});

test('a source without test counts is graded by the score the engine recorded, and a null score stays unknown', () => zh(() => {
  const { runScore, matrixCell, kindScore } = lab('results-math.ts');
  assert.equal(runScore(run('oss-a', 'opus', 1, { source: 'oss', testsPassed: null, testsTotal: null, score: 0.5 })), 0.5);
  assert.equal(runScore(run('oss-a', 'opus', 1, { source: 'oss', testsPassed: null, testsTotal: null, score: null })), null, 'a passed run with no score is not invented as 1');
  assert.equal(runScore(run('t1', 'opus', 1, { score: null })), 1, 'a history run is still scored by its tests');
  const runs = [1, 2].map(repeat => run('oss-a', 'opus', repeat, { source: 'oss', testsPassed: null, testsTotal: null, score: repeat === 1 ? 0.5 : 1 })), lanes = [lane('oss')];
  const single = experiment({ tasks: [ossTask('a')], arms: ['opus'], repeats: 2, runs, lanes });
  assert.equal(matrixCell(single, 'opus', 'oss-a').share, 0.75);
  assert.equal(kindScore(single, 'core', 'opus').mean, 0.75);
  const out = view({ experiments: [single] }, { kind: 'experiment', id: 'e1' });
  assert.match(out, /<span class="celltext">75%<\/span>/, 'a cell without counts shows the share of its score');
  assert.match(out, /得分；打勾 = 多数次重复通过/); assert.doesNotMatch(out, /隐藏测试/, 'a single oss lane uses its own metric wording');
  const unknown = experiment({ tasks: [ossTask('a')], arms: ['opus'], repeats: 1, runs: [run('oss-a', 'opus', 1, { source: 'oss', state: 'error', testsPassed: null, testsTotal: null, score: null })], lanes });
  assert.equal(matrixCell(unknown, 'opus', 'oss-a').share, null);
  assert.match(view({ experiments: [unknown] }, { kind: 'experiment', id: 'e1' }), /<span class="celltext">—<\/span>/, 'an unknown score is a dash');
  const running = view({ experiments: [{ ...single, state: 'running', lanes: [lane('oss', { state: 'running' })] }] }, { kind: 'experiment', id: 'e1' });
  assert.match(running, /通过 = 已解决/); assert.doesNotMatch(running, /通过 = 隐藏测试全部通过/);
}));

const mixed = (patch = {}) => {
  const tasks = [task('t1', 'core'), task('t2', 'core'), ossTask('a'), ossTask('b')], arms = ['orchestrated', 'opus'];
  const runs = tasks.flatMap(item => arms.flatMap(arm => [1, 2, 3].map(repeat => run(item.id, arm, repeat, { source: item.source, state: item.source === 'history' && arm === 'opus' ? 'failed' : 'passed', testsPassed: item.source === 'history' && arm === 'opus' ? 1 : 4, score: item.source === 'history' && arm === 'opus' ? 0.25 : 1 }))));
  return experiment({ tasks, arms, runs, lanes: [lane('history'), lane('oss', { scope: 'psf/requests' })], ...patch });
};

test('several sources: a combined view first, then a section per source drawn from that source’s slice, and no source’s score is added to another’s', () => zh(() => {
  const out = view({ experiments: [mixed()] }, { kind: 'experiment', id: 'e1' });
  assert.equal(count(out, /class="lane"/g), 2); assert.equal(count(out, /综合对比/g), 1);
  assert.ok(out.indexOf('综合对比') < out.indexOf('class="lane"'), 'the combined view comes first');
  const [history, oss] = out.split('<section class="lane"').slice(1);
  assert.match(history, /本项目的历史改动<span class="hint">agentrix<\/span>/); assert.match(oss, /知名开源项目<span class="hint">psf\/requests<\/span>/);
  assert.match(history, /编排在 2 个任务中通过 2 个，Opus 5\.5 单独通过 0 个/); assert.match(oss, /与 Opus 5\.5 单独在 2 个任务中都通过了 2 个/);
  assert.equal(count(out, /class="arm-card /g), 4, 'two approaches in each of two sources');
  assert.match(oss, /可能已被模型训练见过/); assert.doesNotMatch(history, /可能已被模型训练见过/);
  assert.match(history, /隐藏测试通过数/); assert.match(oss, /得分；打勾/, 'each section speaks its own metric');
  assert.match(out, /已花 \$3\.00 \/ 预算 \$20\.00/);
  assert.match(out, /编排在 1\/2 个来源中领先/);
  assert.doesNotMatch(out, /总分|平均分|合计分|综合得分/, 'there is no combined score');
  const single = view({ experiments: [experiment()] }, { kind: 'experiment', id: 'e1' });
  assert.doesNotMatch(single, /class="lane"|综合对比|已花/, 'a single source draws exactly the page it always did');
}));

test('a source that failed shows its own banner beside the other source’s results, and a stopped one says it did not finish', () => zh(() => {
  const tasks = [task('t1', 'core'), ossTask('a')], arms = ['orchestrated', 'opus'];
  const runs = [...['orchestrated', 'opus'].map(arm => run('t1', arm, 1, { state: arm === 'opus' ? 'failed' : 'passed' })),
    ...arms.map(arm => run('oss-a', arm, 1, { source: 'oss', state: 'error', testsPassed: null, testsTotal: null, score: null, costUsd: null, error: 'pip 安装失败' }))];
  const out = view({ experiments: [experiment({ tasks, arms, repeats: 1, runs, state: 'error', lanes: [lane('history'), lane('oss', { state: 'error', error: 'pip 安装依赖失败' })] })] }, { kind: 'experiment', id: 'e1' });
  const [history, oss] = out.split('<section class="lane"').slice(1);
  assert.match(oss, /这个来源出错：pip 安装依赖失败/, 'the lane’s own error is the one shown'); assert.doesNotMatch(history, /这个来源|出错/);
  assert.match(history, /编排在 1 个任务中通过 1 个/, 'the other source’s results are all there');
  assert.match(oss, /class="tag tone-danger">出错/); assert.match(history, /class="tag tone-success">已完成/);
  assert.doesNotMatch(out, /实验出错/, 'the banner belongs to the source, not to the whole experiment');
  const stopped = view({ experiments: [experiment({ tasks, arms, repeats: 1, runs, state: 'stopped', lanes: [lane('history'), lane('oss', { state: 'stopped' })] })] }, { kind: 'experiment', id: 'e1' });
  assert.match(stopped.split('<section class="lane"')[2], /这个来源没有跑完：缺少的运行按未通过计算/);
  assert.match(stopped.split('<section class="lane"')[2], /class="tag tone-warning">已停止/);
}));

test('combine counts the sources each approach leads and sums cost and time over every run; no field adds or averages a score across sources', () => zh(() => {
  const { combine } = lab('source-math.ts'), e = mixed();
  const combined = combine(e);
  assert.equal(combined.sources, 2);
  for (const row of combined.rows) assert.deepEqual(Object.keys(row), ['arm', 'leads', 'costUsd', 'unpriced', 'ms'], 'cost, time and a count: no score, rate or total');
  assert.deepEqual(combined.rows.map(row => [row.arm, row.leads]), [['orchestrated', 1], ['opus', 0]], 'a tie in one source leads nowhere');
  assert.equal(combined.rows[0].costUsd, 6); assert.equal(combined.rows[0].ms, 12 * 60000);
  assert.deepEqual(Object.keys(combined), ['sources', 'rows']);
  const withUnpriced = combine(mixed({ runs: mixed().runs.map((item, index) => index === 0 ? { ...item, costUsd: null } : item) }));
  assert.equal(withUnpriced.rows[0].unpriced, 1); assert.equal(withUnpriced.rows[0].costUsd, 5.5, 'the known costs, with the unpriced run counted');
  const out = view({ experiments: [e] }, { kind: 'experiment', id: 'e1' }), table = out.slice(out.indexOf('<table class="wide">'), out.indexOf('</table>') + 8);
  assert.match(table, /<td class="num">1\/2<\/td><td class="num">\$6\.00<\/td><td class="num">12 分<\/td>/);
  assert.match(table, /<td class="num">0\/2<\/td><td class="num">\$6\.00<\/td>/);
  const both = view({ experiments: [mixed({ lanes: [lane('history'), lane('oss')], runs: mixed().runs.map(item => item.source === 'oss' && item.arm === 'opus' ? { ...item, state: 'failed', score: 0 } : item) })] }, { kind: 'experiment', id: 'e1' });
  assert.match(both, /编排在 2\/2 个来源中领先/);
  const draw = view({ experiments: [mixed({ runs: mixed().runs.map(item => ({ ...item, state: 'passed', score: 1, testsPassed: 4 })) })] }, { kind: 'experiment', id: 'e1' });
  assert.match(draw, /还没有足够的结果可以比较。/, 'no source has a leader, so none is claimed');
}));

test('the aa lane adds each approach’s accuracy with its 95% Wilson interval, and the published number with its date and harness, marked 仅供参考 unless comparable', () => zh(() => {
  const { wilson } = lab('source-math.ts');
  assert.equal(wilson(0, 0), null);
  const half = wilson(5, 10); assert.ok(Math.abs(half.low - 0.2366) < 1e-3 && Math.abs(half.high - 0.7634) < 1e-3);
  assert.equal(wilson(10, 10).high, 1); assert.equal(wilson(0, 10).low, 0); assert.ok(wilson(10, 10).low < 1 && wilson(0, 10).high > 0, 'a perfect score is still uncertain');
  const tasks = ['a', 'b', 'c', 'd', 'e'].map(id => aaTask(id)), arms = ['orchestrated', 'opus', 'sol'];
  const wins = { orchestrated: 4, opus: 3, sol: 5 };
  const runs = tasks.flatMap((item, index) => arms.map(arm => run(item.id, arm, 1, { source: 'aa', state: index < wins[arm] ? 'passed' : 'failed', testsPassed: null, testsTotal: null, score: index < wins[arm] ? 1 : 0 })));
  const show = published => view({ experiments: [experiment({ tasks, arms, repeats: 1, runs, lanes: [lane('aa', { published })] })] }, { kind: 'experiment', id: 'e1' });
  const out = show(published()), section = out.slice(out.indexOf('准确率与 AA 公布的分数'), out.indexOf('能力比较'));
  const interval = (s, n) => { const w = wilson(s, n); return `${Math.round(w.low * 100)}–${Math.round(w.high * 100)}%`; };
  assert.match(section, new RegExp(`<td class="num">60% <span class="muted">\\(3/5\\)</span></td><td class="num">${interval(3, 5)}</td><td class="num">52%</td>`), 'opus: accuracy, interval, published');
  assert.match(section, new RegExp(`<td class="num">100% <span class="muted">\\(5/5\\)</span></td><td class="num">${interval(5, 5)}</td><td class="num">61%</td>`));
  assert.match(section, new RegExp(`<td class="num">80% <span class="muted">\\(4/5\\)</span></td><td class="num">${interval(4, 5)}</td><td class="num">—</td>`), 'the orchestration never gets a published number');
  assert.doesNotMatch(section, /99%/);
  assert.match(section, /2026-10-30/); assert.match(section, /Terminus 2/); assert.match(section, /Artificial Analysis · Terminal-Bench 4\.0 · https:\/\/artificialanalysis\.ai\/evaluations\/terminal-bench/);
  assert.match(section, /仅供参考/); assert.match(section, /不能直接比较/); assert.doesNotMatch(section, /<a /, 'the address is text: the lab has no link to open');
  assert.match(section, /分数不等同于 AA 公布的成绩/);
  const comparable = show(published({ comparable: true, note: '同一批 66 个任务' }));
  assert.doesNotMatch(comparable, /仅供参考/); assert.match(comparable, /同一批 66 个任务/);
  assert.match(show(null), /没有 AA 公布的分数/); assert.doesNotMatch(show(null), /仅供参考/);
  assert.match(out, /通过 = 任务自带的测试全部通过|得分；打勾/, 'the lane keeps its own metric wording');
  assert.doesNotMatch(view({ experiments: [mixed()] }, { kind: 'experiment', id: 'e1' }), /准确率与 AA/, 'no aa lane, no aa section');
}));

test('running with several sources groups the cards and tiles by source, each with its own state, spend and pass rule', () => zh(() => {
  const tasks = [task('t1', 'core'), aaTask('x')], arms = ['orchestrated', 'opus'];
  const runs = [...arms.map(arm => run('t1', arm, 1, { state: 'passed' })), ...arms.map((arm, index) => run('aa-x', arm, 1, { source: 'aa', state: index ? 'queued' : 'running', startedAt: null, endedAt: null, activeModel: index ? null : 'claude-opus', testsPassed: null, testsTotal: null, score: null }))];
  const e = experiment({ tasks, arms, repeats: 1, state: 'running', runs, lanes: [lane('history', { state: 'done', spentUsd: 1 }), lane('aa', { state: 'running', spentUsd: 0, budgetUsd: 10, scope: 'Terminal-Bench 4.0' })] });
  const out = view({ experiments: [e] }, { kind: 'experiment', id: 'e1' });
  assert.equal(count(out, /class="lane"/g), 2); assert.equal(count(out, /class="panel overall"/g), 1, 'one overall ring and one stop button');
  assert.equal(count(out, />停止</g), 1);
  const [history, aa] = out.split('<section class="lane"').slice(1);
  assert.match(history, /本项目的历史改动/); assert.match(aa, /AA 测试<span class="hint">Terminal-Bench 4\.0<\/span>/);
  assert.match(history, /class="tag tone-success">已完成/); assert.match(aa, /class="tag tone-running">运行中/);
  assert.equal(count(history, /class="arm-card running-card/g), 2); assert.equal(count(aa, /class="arm-card running-card/g), 2);
  assert.match(history, /通过 = 隐藏测试全部通过/); assert.match(aa, /通过 = 任务自带的测试全部通过/); assert.doesNotMatch(aa, /隐藏测试/);
  assert.match(aa, /claude-opus/); assert.doesNotMatch(history, /claude-opus/, 'a model working is shown in its own source’s group');
  assert.match(aa, /已花 \$0\.00 \/ 预算 \$10\.00/);
  const queued = view({ experiments: [{ ...e, lanes: [e.lanes[0], { ...e.lanes[1], state: 'queued' }] }] }, { kind: 'experiment', id: 'e1' });
  assert.match(queued, /class="tag ">排队/);
}));

test('home: a card of several sources names every scope and charts the sources each approach leads, never a pass rate over different scales', () => zh(() => {
  const home = view({ experiments: [mixed(), experiment({ patch: { id: 'e2', name: '单来源' } })] });
  assert.match(home, /agentrix · psf\/requests · 4 个任务/);
  assert.match(home, /各方案领先的来源数/); assert.match(home, /<b>1\/2<\/b>/); assert.match(home, /<b>0\/2<\/b>/);
  assert.equal(count(home, /任务通过率/g), 2, 'the single source card keeps its pass-rate chart');
  assert.match(view({ experiments: [mixed()] }, { kind: 'experiment', id: 'e1' }), /class="lab-note" role="status">agentrix · psf\/requests</, 'the title bar names the scopes');
}));

test('the estimate lists each source with its runs, time, cost, share of the budget and download when more than one is chosen or the one is not history', () => zh(() => {
  const { ScaleStep } = lab('WizardSteps.tsx'), w = lab('wizard-math.ts'), draft = { ...w.emptyDraft(), sources: ['history', 'oss', 'aa'], history: { projectId: 'p1', tasks: [task('t1', 'core')] }, oss: { repos: ['r'], tasks: [ossTask('a'), ossTask('b')] }, aa: { benchmark: 'b', tasks: [aaTask('x')] }, budgetUsd: 20 };
  const row = (source, patch = {}) => ({ source, runs: 6, minutes: 30, costUsd: 4, basis: 'default', share: 0.4, ...patch });
  const estimate = { runs: 18, minutes: 90, costUsd: 12, basis: 'default', sources: [row('history'), row('oss', { share: 0.35 }), row('aa', { share: 0.25 })] };
  const infos = [info('history'), info('oss', { downloadBytes: 320e6 }), info('aa', { downloadBytes: 1.5e9 })];
  const out = html(React.createElement(ScaleStep, { draft, infos, estimate, error: null, defaultName: 'x', onRetry() {}, onRepeats() {}, onBudget() {}, onName() {} }));
  assert.equal(count(out, /<tr><td>/g), 3); assert.match(out, /aria-label="各来源的估算"/);
  assert.match(out, /<td>知名开源项目<\/td><td class="num">6<\/td><td class="num">30 分<\/td><td class="num">\$4\.00<\/td><td class="num">35%<\/td><td class="num">320 MB<\/td>/);
  assert.match(out, /<td class="num">25%<\/td><td class="num">1\.5 GB<\/td>/); assert.match(out, /<td class="num">40%<\/td><td class="num">—<\/td>/, 'a source with nothing to download says so with a dash');
  assert.match(out, /4 个问题 × 2 种方案 × 3 次/, 'the tasks of every chosen source are counted');
  const one = html(React.createElement(ScaleStep, { draft: { ...draft, sources: ['aa'] }, infos, estimate: { ...estimate, sources: [row('aa')] }, error: null, defaultName: 'x', onRetry() {}, onRepeats() {}, onBudget() {}, onName() {} }));
  assert.equal(count(one, /<tr><td>/g), 1, 'a single aa source still shows what it downloads');
}));

// ---- build and style rules -------------------------------------------------------------------------------------------------
test('the lab CSP allows its own assets and dev socket without external images or embedded pages, and the build lists three pages', () => {
  const policy = file => /Content-Security-Policy" content="([^"]+)"/.exec(read(path.join(root, file)))?.[1];
  assert.equal(policy('lab.html'), policy('dashboard.html'));
  assert.equal(policy('lab.html'), "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; font-src 'self'; connect-src 'self' ws://127.0.0.1:5178; object-src 'none'; base-uri 'none'; frame-src 'none'");
  const page = read(path.join(root, 'lab.html'));
  assert.match(page, /<script type="module" src="\/src\/features\/lab\/main\.tsx"><\/script>/); assert.doesNotMatch(page, /<script(?![^>]*\bsrc=)/, 'no inline script');
  const config = read(path.join(root, 'vite.config.ts'));
  assert.match(config, /input: \{ main: 'index\.html', dashboard: 'dashboard\.html', lab: 'lab\.html' \}/); assert.match(config, /entries: \['index\.html', 'dashboard\.html', 'lab\.html'\]/);
});

test('a source card that cannot run keeps its reason at the secondary text colour, and the three source cards stay equal in one row at any width', () => {
  const sheet = css();
  assert.match(sheet, /\.choice:disabled > :not\(\.reason\) \{ opacity: \.45; \}/, 'the card dims its icon and words');
  assert.match(sheet, /\.choice:disabled \.reason \{ opacity: 1; color: var\(--text-2\); \}/, 'the reason is not dimmed');
  assert.match(sheet, /\.choices\.three \{ grid-template-columns: repeat\(3, minmax\(0, 1fr\)\); \}/);
  const narrow = /@media \(max-width: 1000px\) \{([\s\S]*?)\n\}/.exec(sheet);
  assert.ok(narrow && !/\.choices\.three/.test(narrow[1]), 'the narrow window does not re-flow the source cards');
  assert.match(sheet, /\.steps li:not\(:last-child\)::after \{[^}]*flex: 1 1 0;/, 'every connector takes an equal share');
});

test('the lab stylesheet keeps the product scale and takes every colour from the theme tokens apart from the four approach colours', () => {
  const declarations = [...css().matchAll(/([^{}]+)\{([^}]*)\}/g)].flatMap(([, selector, body]) => body.split(';').map(item => item.trim()).filter(Boolean)
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
    if (name === 'font' && value !== 'inherit') { sizes.add(/(\d+)px/.exec(value)?.[1] + 'px'); weights.add(/^(\d+)/.exec(value)?.[1]); }
    if (name === 'border-radius') radii.add(value);
  }
  assert.deepEqual([...sizes].sort(), ['12px', '13px', '14px', '16px', '48px']); assert.deepEqual([...weights].sort(), ['400', '600']);
  assert.deepEqual([...radii].sort(), ['12px', '8px', '999px']);
  const literal = declarations.filter(({ name, value }) => /#[0-9a-f]{3,8}\b/i.test(value) && !/^--lab-arm-(orchestrated|opus|sol|sonnet)$/.test(name));
  assert.deepEqual(literal, [], 'colours come from the theme tokens; only --lab-arm-* are literal');
  assert.match(css(), /\.lab \{ --lab-arm-orchestrated: #009e73; --lab-arm-opus: #e69f00; --lab-arm-sol: #56b4e9; --lab-arm-sonnet: #cc79a7;/);
  assert.match(css(), /:root\[data-theme="light"\] \.lab \{ --lab-arm-orchestrated: #008a64; --lab-arm-opus: #b97800; --lab-arm-sol: #1f86c4; --lab-arm-sonnet: #b45c8c;/);
  assert.match(read(path.join(src, 'shared/styles/styles.css')), /\.button \{[^}]*height: 32px/);
  assert.equal(declarations.find(({ selector, name }) => selector === '.figure' && name === 'font-size').value, '48px', 'ring figures use the hero size');
  assert.equal(declarations.find(({ selector, name }) => selector === 'details.data summary' && name === 'height').value, '32px');
});

test('every scrolling region is labelled and focusable, and scrolling is only ever drawn through that one component', () => {
  const { ScrollRegion } = lab('Marks.tsx');
  assert.match(html(React.createElement(ScrollRegion, { label: '表' }, 'x')), /^<div class="scroll" role="region" aria-label="表" tabindex="0">x<\/div>$/);
  for (const name of fs.readdirSync(labDir).filter(file => /\.tsx$/.test(file) && file !== 'Marks.tsx')) assert.doesNotMatch(read(path.join(labDir, name)), /className="scroll"/, name);
  assert.ok(count(css(), /\.scroll:focus-visible/g) >= 1);
});

test('the page reads only the lab bridge and imports only src/shared; the main window’s menu opens the lab through openLab', () => {
  const files = fs.readdirSync(labDir).filter(name => /\.tsx?$/.test(name));
  for (const name of files) assert.doesNotMatch(read(path.join(labDir, name)), /window\.agentrix\b(?!Lab)/, name);
  const imports = files.flatMap(name => [...read(path.join(labDir, name)).matchAll(/from '(\.\.\/\.\.\/[^']+|\.\.\/[^']+)'/g)].map(match => match[1]));
  assert.deepEqual([...new Set(imports.filter(spec => !spec.startsWith('../../shared/')))], [], 'only src/shared is imported from outside the feature');
  const menu = read(path.join(src, 'features/titlebar/AppMenu.tsx'));
  assert.match(menu, /window\.agentrix\.openLab\(\)/); assert.match(menu, /label=\{t\('虚拟实验室'\)\} onSelect=\{\(\) => choose\(openLab\)\}/);
  assert.ok(menu.indexOf("t('设置')") < menu.indexOf("t('虚拟实验室')"), 'the lab entry sits next to Settings');
});

test('every lab phrase has an English translation and shape-bearing words are not hard-coded in English', () => {
  const en = JSON.parse(read(path.join(root, 'electron/locales/en.json')));
  const missing = [];
  for (const name of fs.readdirSync(labDir).filter(file => /\.tsx?$/.test(file))) {
    for (const match of read(path.join(labDir, name)).matchAll(/\bt\(\s*'((?:[^'\\]|\\.)*)'/g)) if (/[一-鿿]/.test(match[1]) && !(match[1] in en)) missing.push(`${name}: ${match[1]}`);
  }
  const engineDir = path.join(root, 'electron/features/lab');
  for (const name of fs.readdirSync(engineDir).filter(file => file.endsWith('.cjs'))) {
    for (const match of read(path.join(engineDir, name)).matchAll(/new Error\('([^']+)'/g)) if (/[一-鿿]/.test(match[1]) && !(match[1] in en)) missing.push(name + ': ' + match[1]);
  }
  // The two other sources speak through the context's translator and through errors; every phrase they use needs its English too.
  const sourceFiles = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? sourceFiles(path.join(dir, entry.name)) : entry.name.endsWith('.cjs') ? [path.join(dir, entry.name)] : []);
  for (const dir of ['lab-oss', 'lab-aa'].map(name => path.join(root, 'electron/features', name))) {
    for (const file of sourceFiles(dir)) for (const match of read(file).matchAll(/(?:new Error\(|\bt\()\s*'((?:[^'\\]|\\.)*)'/g)) if (/[一-鿿]/.test(match[1]) && !(match[1] in en)) missing.push(`${path.relative(root, file)}: ${match[1]}`);
  }
  assert.deepEqual(missing, []);
  assert.equal(en['虚拟实验室'], 'Virtual Lab');
});

test('English results translate persisted engine errors and sampling explanations', () => {
  applyLanguage('en');
  try {
    const failed = experiment({ state: 'error', runs: [run('t1', 'opus', 1, { state: 'error', error: '实验运行超时。' })] });
    assert.match(view({ experiments: [failed] }, { kind: 'experiment', id: 'e1' }), /The experiment failed: The experiment run timed out\./);
    const { ProjectStep } = lab('SourcePanels.tsx');
    const out = html(React.createElement(ProjectStep, { projects: [{ id: 'p1', name: 'agentrix' }], projectId: 'p1', preferShortComplex: true,
      panel: { sample: { tasks: [task('t1', 'core')], loading: false, error: null, exhausted: false }, size: 3, range: { min: 1, max: 10, standard: 3 }, onSize() {}, onShuffle() {}, onRetry() {} },
      onProject() {}, onPrefer() {} }));
    assert.match(out, /Across 2 modules · 40 lines changed/); assert.doesNotMatch(out, /跨 2 个模块/);
  } finally { applyLanguage('zh'); }
});

// ---- money, and starting on a current estimate ------------------------------------------------------------------------------
test('a cost is always dollars and cents; only an axis tick may drop the cents of a whole dollar', () => zh(() => {
  const { money, moneyTick, DASH } = lab('format.ts');
  assert.deepEqual([money(12.9), money(35), money(8.47), money(0), money(120), money(null)], ['$12.90', '$35.00', '$8.47', '$0.00', '$120.00', DASH]);
  assert.deepEqual([moneyTick(5), moneyTick(0), moneyTick(2.5)], ['$5', '$0', '$2.50']);
  const priced = ['t1', 't2'].flatMap(id => ['orchestrated', 'opus'].flatMap(arm => [1, 2, 3].map(repeat => run(id, arm, repeat, { costUsd: 2.15 }))));
  const results = view({ experiments: [experiment({ arms: ['orchestrated', 'opus'], runs: priced })] }, { kind: 'experiment', id: 'e1' });
  assert.match(results, /<dd>\$12\.90<\/dd>/, 'a card shows the cost with cents'); assert.match(results, /<td class="num">\$12\.90<\/td>/, 'and so does the table beside the scatter');
  assert.doesNotMatch(results, /\$12\.9</);
  const running = view({ experiments: [experiment({ state: 'running', patch: { spentUsd: 21.4, budgetUsd: 20 } })] }, { kind: 'experiment', id: 'e1' });
  assert.match(running, /已花 \$21\.40/); assert.match(running, /预算 \$20\.00/);
}));

test('the form starts only with a current, successful estimate for exactly the draft', () => zh(() => {
  const w = lab('wizard-math.ts'), estimate = { runs: 12, minutes: 30, costUsd: 5, basis: 'default', sources: [] };
  const answer = patch => ({ fresh: true, loading: false, value: estimate, error: null, ...patch });
  assert.deepEqual(w.currentEstimate(answer()), { value: estimate, error: null });
  assert.equal(w.currentEstimate(answer({ fresh: false })).value, null, 'an answer to an earlier draft (tasks, approaches or repeats changed) does not count');
  assert.equal(w.currentEstimate(answer({ loading: true })).value, null, 'one still on its way does not count');
  assert.deepEqual(w.currentEstimate(answer({ value: null, error: 'boom' })), { value: null, error: 'boom' });
  assert.equal(w.currentEstimate(answer({ fresh: false, value: null, error: 'old' })).error, null, 'a failure of an earlier draft is not shown for this one');
  assert.equal(w.canStart(null, estimate, false), true);
  assert.equal(w.canStart(null, null, false), false, 'no estimate yet, or a failed one');
  assert.equal(w.canStart({ need: 'budget' }, estimate, false), false); assert.equal(w.canStart(null, estimate, true), false);

  const wizard = read(path.join(labDir, 'Wizard.tsx'));
  assert.match(wizard, /disabled=\{!canStart\(lack, estimated, starting\)\}/); assert.match(wizard, /if \(!canStart\(lack, estimated, starting\)\) return;/);
  assert.match(wizard, /\[ready, JSON\.stringify\(selections\), draft\.arms\.join\(\), draft\.repeats\]/, 'the estimate is asked again when any of these changes');
  assert.match(wizard, /api\.estimate\(\{ selections, arms: draft\.arms, repeats: draft\.repeats \}\)/, 'and asked for the draft’s selections');
  assert.match(read(path.join(labDir, 'useSamples.ts')), /\[JSON\.stringify\(query\)\]/, 'a sample is asked again only when its own question changes');
  assert.match(read(path.join(labDir, 'useResult.ts')), /fresh: state\.answered === asked/);

  const { ScaleStep } = lab('WizardSteps.tsx'), draft = { ...w.emptyDraft(), history: { projectId: 'p1', tasks: [task('t1', 'core')] }, budgetUsd: 10 };
  const show = error => html(React.createElement(ScaleStep, { draft, infos: [], estimate: null, error, onRetry() {}, defaultName: 'x', onRepeats() {}, onBudget() {}, onName() {} }));
  const failed = show('boom');
  assert.match(failed, /估算失败：boom/); assert.match(failed, /<button type="button" class="button small">重试<\/button>/);
  assert.doesNotMatch(show(null), /估算失败/);
}));
