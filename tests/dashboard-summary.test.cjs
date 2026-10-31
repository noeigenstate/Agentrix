const { test } = require('node:test');
const assert = require('node:assert/strict');
const { summarize } = require('../electron/features/dashboard/summary.cjs');
const prices = require('../electron/features/dashboard/prices.json');

const DAY = 86400000, now = new Date(2026, 9, 31, 12).getTime();
const sol = 'gpt-6.1-sol', sonnet = 'claude-sonnet-5-5';
const projects = [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }];
const query = { projectId: null, range: '7d' };
const run = (id, extra = {}) => ({ id, at: now - 1000, projectId: 'a', project: 'Alpha', model: sol, agent: 'codex',
  role: '执行', kind: 'core', meeting: null, reason: 'exit', exitCode: 0, outOfScope: 0,
  activeMs: 1000, outputTokens: 20, totalOutputTokens: 30, inputTokens: 40, cachedTokens: 10, ...extra });
const journal = entries => [{ projectId: 'a', project: 'Alpha', entries }];
const entry = (type, meeting, extra = {}) => ({ type, meeting, time: now - 500, ...extra });
const summary = (extra = {}) => summarize({ now, query, projects, prices, ...extra });
const model = (result, name = sol) => result.models.find(row => row.model === name);

test('empty dashboard preserves unknown rates, costs, times and previous-round averages', () => {
  const result = summary();
  assert.deepEqual(result.kpis, { firstPassRate: null, runs: 0, runsPrevious: 0, incidents: 0, quota: null,
    reworkPerRound: null, reworkPerRoundPrevious: null, rounds: 0, roundtableFirstConfirm: null, findingsPerRound: null, findingFixRate: null });
  for (const key of ['models', 'kinds', 'speed', 'incidents', 'rounds', 'findings', 'suggestions', 'weights']) assert.deepEqual(result[key], [], key);
  assert.deepEqual(result.prices, { updated: prices.updated, unpriced: [] });
});

test('worker first pass requires exit zero in scope and no finding against its author', () => {
  const runs = [run('clean'), run('exit', { exitCode: 1 }), run('scope', { outOfScope: 2 }),
    run('error', { reason: 'error' }), run('finding', { meeting: 'reviewed' }), run('unknown', { exitCode: null }),
    run('reviewer', { role: '审查', kind: 'review' })];
  const result = summary({ records: { runs }, journals: journal([
    entry('finding', 'reviewed', { author: sol, category: 'correctness', fixed: true }),
    entry('finding', 'reviewed', { author: sonnet, category: 'ui', fixed: false }),
  ]) });
  assert.equal(model(result).firstPassRate, 1 / 5);
  assert.equal(result.kpis.firstPassRate, 1 / 5);
  assert.equal(model(result).outOfScope, 2);
  assert.equal(model(result).findingsPerRun, 1 / 7);
  assert.equal(result.kinds.find(row => row.kind === 'review').firstPassRate, null);
  assert.equal(result.kpis.findingFixRate, 0.5);
});

test('rework follows review completion and explicit review follow-ups, with author and kind isolation', () => {
  const runs = [
    run('build', { meeting: 'r', startedAt: now - 900, endedAt: now - 800, activeMs: 100 }),
    run('other-kind', { meeting: 'r', kind: 'frontend', startedAt: now - 900, endedAt: now - 700, activeMs: 200 }),
    run('review', { meeting: 'r', role: '审查', kind: 'review', startedAt: now - 700, endedAt: now - 600, activeMs: 50 }),
    run('repair', { meeting: 'r', startedAt: now - 550, endedAt: now - 500, activeMs: 30 }),
    run('skip', { skipMeeting: 'review follow-up', activeMs: 10 }),
  ];
  const ends = runs.slice(0, 4).map(value => entry('end', 'r', { ...value, time: value.endedAt }));
  const result = summary({ records: { runs }, journals: journal([
    entry('end', 'r', { id: 'table', role: '圆桌', activeMs: 25, time: now - 1000 }), ...ends,
    entry('consolidate', 'r', { time: now - 400 }),
  ]) });
  assert.equal(result.kinds.find(row => row.kind === 'core').firstPassRate, 0);
  assert.equal(result.kinds.find(row => row.kind === 'frontend').firstPassRate, 1);
  assert.deepEqual(result.rounds[0].phases, { roundtable: 25, build: 300, review: 50, rework: 30 });
  assert.equal(result.rounds[0].tasks, 2); assert.equal(result.rounds[0].rework, 1);
  assert.equal(result.rounds[0].durationMs, 600, 'journal ends and app run records are not counted twice');
  assert.equal(result.rounds[0].questions, null);
});

test('a build already running when review ends is not rework', () => {
  const runs = [run('build', { meeting: 'r', startedAt: now - 900, endedAt: now - 300 }),
    run('review', { meeting: 'r', role: '审查', kind: 'review', startedAt: now - 700, endedAt: now - 500 })];
  const result = summary({ records: { runs }, journals: journal([entry('consolidate', 'r')]) });
  assert.equal(result.rounds[0].rework, 0); assert.equal(model(result).firstPassRate, 1);
});

test('every session must have its first confirmation confirmed, and later confirmation cannot repair it', () => {
  const meeting = (round, session, status, phase, time) => entry('meeting', round, { session, agent: 'codex', status, time,
    ...(phase === 'understanding' ? { understanding: { goal: 'task' } } : { confirmation: { status, questions: [] } }) });
  const result = summary({ journals: journal([
    meeting('ok', 'one', 'understood', 'understanding', now - 900), meeting('ok', 'one', 'confirmed', 'confirmation', now - 800),
    meeting('ok', 'two', 'confirmed', 'confirmation', now - 700),
    meeting('retry', 'one', 'open', 'confirmation', now - 900), meeting('retry', 'one', 'confirmed', 'confirmation', now - 700),
    meeting('missing', 'one', 'understood', 'understanding', now - 900),
    meeting('invalid', 'one', 'invalid', 'confirmation', now - 900),
  ]) });
  assert.equal(result.rounds.find(round => round.meeting === 'ok').firstConfirmed, true);
  for (const round of result.rounds.filter(round => round.meeting !== 'ok')) assert.equal(round.firstConfirmed, false);
  assert.equal(result.kpis.roundtableFirstConfirm, 0.25);
});

test('lead deliveries belong to the graded session model and only first submissions determine first pass', () => {
  const grades = [
    { at: now - 900, projectId: 'a', agent: 'claude', model: 'claude-opus-5-5', sessionId: 'lead', submission: 1, outcome: 'sent-back' },
    { at: now - 800, projectId: 'a', agent: 'claude', model: 'claude-opus-5-5', sessionId: 'lead', submission: 2, outcome: 'passed' },
    { at: now - 700, projectId: 'a', agent: 'claude', model: 'claude-opus-5-5', sessionId: 'lead', submission: 1, outcome: 'passed' },
  ];
  const result = summary({ records: { runs: [run('worker')], grades } });
  assert.equal(model(result, 'claude-opus-5-5').runs, 0);
  assert.equal(model(result, 'claude-opus-5-5').firstPassRate, 0.5);
  assert.equal(model(result, 'claude-opus-5-5').sentBack, 1);
  assert.equal(model(result).firstPassRate, 1);
  assert.equal(result.kpis.firstPassRate, 2 / 3);
});

test('range and project filtering use adjacent equal previous windows and retain complete round evidence', () => {
  const current = run('now', { at: now });
  const boundary = run('boundary', { at: now - 7 * DAY });
  const previous = run('previous', { at: now - 14 * DAY });
  const outside = run('outside', { at: now - 14 * DAY - 1 });
  const future = run('future', { at: now + 1 });
  const beta = run('beta', { projectId: 'b', project: 'Beta', meeting: 'current' });
  const result = summary({ query: { ...query, projectId: 'a' }, records: { runs: [current, boundary, previous, outside, future, beta] },
    journals: [
      ...journal([entry('end', 'old', { time: now - 8 * DAY, role: '执行', activeMs: 10 }), entry('consolidate', 'old', { time: now - 8 * DAY + 1 }),
        entry('meeting', 'current', { time: now - 8 * DAY, session: 's', agent: 'codex', status: 'confirmed', confirmation: { status: 'confirmed' } }),
        entry('issues', 'current', { time: now - 8 * DAY, issues: [] }), entry('consolidate', 'current', { time: now - DAY })]),
      { projectId: 'b', entries: [entry('incident', 'current', { model: sol, kind: 'core', cause: 'Beta only' })] },
    ] });
  assert.equal(result.kpis.runs, 2); assert.equal(result.kpis.runsPrevious, 1);
  assert.equal(result.kpis.rounds, 1); assert.equal(result.kpis.reworkPerRoundPrevious, 0);
  assert.equal(result.kpis.incidents, 0); assert.equal(result.rounds[0].firstConfirmed, true);
  assert.equal(result.rounds[0].questions, 0);
  const all = summary({ query: { projectId: null, range: 'all' }, records: { runs: [current, boundary, previous, outside, future, beta] } });
  assert.equal(all.kpis.runs, 5); assert.equal(all.kpis.runsPrevious, null); assert.equal(all.kpis.reworkPerRoundPrevious, null);
  assert.equal(summary({ query: { projectId: null, range: '30d' }, records: { runs: [outside] } }).kpis.runs, 1);
});

test('project filters include only their grades and journal, even when meetings have the same name', () => {
  const result = summary({ query: { ...query, projectId: 'a' }, records: { runs: [run('one', { meeting: 'same' })], grades: [
    { at: now, projectId: 'b', model: sol, agent: 'codex', outcome: 'sent-back', submission: 1 },
  ] }, journals: [...journal([entry('consolidate', 'same')]), { projectId: 'b', entries: [
    entry('finding', 'same', { author: sol, category: 'correctness', fixed: false }), entry('consolidate', 'same'),
  ] }] });
  assert.equal(model(result).firstPassRate, 1); assert.equal(model(result).sentBack, 0); assert.equal(result.findings.length, 0);
});

test('daily speed weights the same timed replies and uses the local calendar day', () => {
  const morning = new Date(2026, 9, 31, 0, 1).getTime(), evening = new Date(2026, 9, 30, 23, 59).getTime();
  const result = summary({ records: { runs: [run('short', { at: morning, activeMs: 1000, outputTokens: 10 }),
    run('long', { at: morning + 1, activeMs: 3000, outputTokens: 90 }),
    run('untimed', { at: morning + 2, activeMs: null, outputTokens: 90000 }),
    run('yesterday', { at: evening, activeMs: 1000, outputTokens: 0 })] } });
  assert.deepEqual(result.speed, [
    { day: '2026-10-30', model: sol, tokensPerSecond: 0 }, { day: '2026-10-31', model: sol, tokensPerSecond: 25 },
  ]);
  assert.equal(model(result).tokensPerSecond, 20);
  assert.equal(model(result).avgActiveMs, 5000 / 3);
});

test('quota uses the latest reading per provider and its longest window, without adding different account scopes', () => {
  const quota = [
    { at: now - 800, provider: 'codex', scope: 'old-host', windows: [{ minutes: 10080, percent: 99 }] },
    { at: now - 700, provider: 'codex', scope: 'new-host', windows: [{ minutes: 300, percent: 90 }, { minutes: 10080, percent: 15 }] },
    { at: now - 600, provider: 'claude', windows: [{ minutes: 10080, percent: 0 }] },
    { at: now + 1, provider: 'codex', windows: [{ minutes: 10080, percent: 100 }] },
  ];
  const result = summary({ records: { runs: [run('sol'), run('sonnet', { model: sonnet, agent: 'claude' })], quota } });
  assert.equal(model(result).quotaPercent, 15); assert.equal(model(result, sonnet).quotaPercent, 0);
  assert.deepEqual(result.kpis.quota, { provider: 'claude', percent: 0, minutes: 10080 });
  const unknown = summary({ records: { runs: [run('one')], quota: [...quota, { at: now, provider: 'codex', windows: [{ minutes: null, percent: 5 }] }] } });
  assert.equal(model(unknown).quotaPercent, null);
});

test('costs distinguish partial prices, fast rows, unpriced models and a reported zero', () => {
  const result = summary({ records: { runs: [run('priced', { fast: true, inputTokens: 1e6, cachedTokens: 1e6, totalOutputTokens: 1e6 }),
    run('partial', { inputTokens: null }), run('zero', { reportedCostUsd: 0, inputTokens: null }),
    run('custom', { model: 'custom-model', inputTokens: null })] } });
  assert.equal(model(result).costedRuns, 2); assert.equal(model(result).costUsd, 24.2);
  assert.equal(model(result, 'custom-model').costUsd, null);
  assert.deepEqual(result.prices.unpriced, ['custom-model']);
});

test('unreported values remain null and duplicate dispatch ends do not inflate runs', () => {
  const unknown = run('one', { exitCode: null, activeMs: null, inputTokens: null, model: null });
  const result = summary({ records: { runs: [unknown, unknown] } });
  assert.equal(result.kpis.runs, 1);
  const row = model(result, 'unreported');
  for (const key of ['firstPassRate', 'avgActiveMs', 'tokensPerSecond', 'costUsd', 'quotaPercent']) assert.equal(row[key], null, key);
  assert.equal(result.speed[0].tokensPerSecond, null);
});

test('latest issues snapshots distinguish zero from historical absence and supply changed-plan suggestions', () => {
  const issues = [{ issue: 'old plan', raisedBy: sol, answer: 'split module', result: 'changed the plan' }];
  const result = summary({ journals: journal([
    entry('issues', 'r', { time: now - 900, issues: [] }), entry('issues', 'r', { time: now - 800, issues }),
    entry('consolidate', 'r'), entry('consolidate', 'old'),
  ]) });
  assert.equal(result.rounds.find(round => round.meeting === 'r').questions, 1);
  assert.equal(result.rounds.find(round => round.meeting === 'old').questions, null);
  assert.ok(result.suggestions.some(suggestion => suggestion.title === '保留开工前的圆桌确认'));
});

test('weights are global, use the lowest adopted kind on a model row, and survive project and date filtering', () => {
  const decisions = [
    { id: 'one', state: 'adopted', at: now - 100 * DAY, weight: { model: sol, kind: 'core', from: 1, to: 0.8 } },
    { id: 'two', state: 'adopted', at: now - 100 * DAY, weight: { model: sol, kind: 'frontend', from: 1, to: 1.2 } },
  ];
  const result = summary({ query: { ...query, projectId: 'a' }, records: { runs: [run('one')] }, decisions });
  assert.equal(model(result).weight, 0.8); assert.equal(result.weights.length, 2);
});

test('suggestions use all project and date evidence while displayed metrics follow the query', () => {
  const terra = 'gpt-6.1-terra';
  const runs = Array.from({ length: 5 }, (_, i) => [
    run(`pass-${i}`, { at: now - 40 * DAY }),
    run(`fail-${i}`, { projectId: 'b', model: terra, at: now - 10 * DAY, exitCode: 1 }),
  ]).flat();
  const journals = journal([entry('incident', 'old', { time: now - 40 * DAY, model: sol, kind: 'core',
    weight: { kind: 'core', from: 1, to: 0.8 } }), entry('issues', 'old', { time: now - 40 * DAY,
    issues: [{ issue: 'scope', raisedBy: sol, answer: 'split', result: 'changed the plan' }] })]);
  const options = { records: { runs }, journals };
  const first = summary(options);
  assert.equal(first.kpis.runs, 0); assert.equal(first.suggestions.length, 3);
  for (const projectId of [null, 'a', 'b']) for (const range of ['7d', '30d', 'all']) {
    assert.deepEqual(summary({ ...options, query: { projectId, range } }).suggestions, first.suggestions);
  }
  const suggestion = first.suggestions.find(value => value.weight?.model === terra);
  const decisions = [{ id: suggestion.id, state: 'adopted', at: now, weight: suggestion.weight }];
  runs.push(run('one-more', { model: terra, exitCode: 1, projectId: 'b' }));
  const next = summary({ ...options, decisions });
  assert.equal(next.suggestions.length, first.suggestions.length);
  assert.deepEqual(next.weights, [suggestion.weight]);
  assert.equal(next.suggestions.find(value => value.id === suggestion.id).state, 'adopted');
});

test('first-pass sample thresholds exclude runs without an observed outcome on either model', () => {
  for (const unknownModel of [sol, sonnet]) {
    const runs = Array.from({ length: 5 }, (_, i) => [run(`good-${i}`), run(`bad-${i}`, { model: sonnet, agent: 'claude', exitCode: 1 })]).flat();
    const unknown = runs.find(value => value.model === unknownModel);
    unknown.exitCode = null;
    runs.push(run('review', { model: unknownModel, role: '审查', kind: 'core' }));
    const result = summary({ records: { runs } });
    assert.equal(result.kpis.runs, 11);
    assert.equal(result.kinds.find(row => row.model === unknownModel).runs, 4);
    assert.deepEqual(result.suggestions, []);
    unknown.exitCode = unknownModel === sol ? 0 : 1;
    assert.equal(summary({ records: { runs } }).suggestions.length, 1);
  }
});

test('worktrees sharing one common journal count once globally and remain selectable per project', () => {
  const entries = [entry('consolidate', 'shared')];
  const journals = [{ projectId: 'a', key: 'common', entries }, { projectId: 'b', key: 'common', entries }];
  assert.equal(summary({ journals }).rounds.length, 1);
  const beta = summary({ journals, query: { ...query, projectId: 'b' } });
  assert.equal(beta.rounds.length, 1); assert.equal(beta.rounds[0].project, 'Beta');
});

test('shared worktree journals apply author findings to runs from every associated project', () => {
  const entries = [entry('finding', 'shared', { author: sol, category: 'correctness', fixed: true }), entry('consolidate', 'shared')];
  const journals = [{ projectId: 'a', key: 'common', entries }, { projectId: 'b', key: 'common', entries }];
  const result = summary({ journals, records: { runs: [run('beta', { projectId: 'b', meeting: 'shared' })] } });
  assert.equal(result.rounds.length, 1); assert.equal(model(result).firstPassRate, 0);
});

test('incident suggestion ids survive a sliding journal tail and reordered project aliases', () => {
  const incident = entry('incident', 'r', { model: sol, kind: 'core', cause: 'same evidence', fix: 'same fix', weight: { kind: 'core', from: 1, to: 0.8 } });
  const prior = entry('consolidate', 'old', { time: now - 100 * DAY });
  const first = summary({ journals: [{ projectId: 'a', key: 'common', entries: [prior, incident] }, { projectId: 'b', key: 'common', entries: [prior, incident] }] });
  const next = summary({ journals: [{ projectId: 'b', key: 'common', entries: [incident] }, { projectId: 'a', key: 'common', entries: [incident] }] });
  assert.equal(first.suggestions[0].id, next.suggestions[0].id);
});

test('malformed journal issue and weight fields stay unavailable instead of creating suggestions', () => {
  const result = summary({ journals: journal([
    entry('issues', 'r', { issues: [null] }), entry('consolidate', 'r'),
    entry('incident', 'r', { model: sol, kind: 'core', weight: { kind: 'core', from: 1, to: null } }),
  ]) });
  assert.equal(result.rounds[0].questions, null); assert.equal(result.incidents[0].weight, null);
  assert.deepEqual(result.suggestions, []);
});

test('summary is pure and never changes caller records or journal arrays', () => {
  const input = { now, query, projects, prices, records: { runs: [run('one', { meeting: 'r' })] }, journals: journal([
    entry('skip', 'r', { id: 'one', reason: 'review follow-up' }), entry('consolidate', 'r'),
  ]) };
  const before = JSON.stringify(input);
  const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } };
  freeze(input);
  assert.deepEqual(summarize(input), summarize(input)); assert.equal(JSON.stringify(input), before);
});
