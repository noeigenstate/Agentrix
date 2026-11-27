const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { summarize, outcomeOf, MIN_TASKS } = require('../electron/features/dashboard/summary.cjs');

const DAY = 86400000, now = new Date(2026, 9, 31, 12).getTime();
const sol = 'gpt-6.1-sol', sonnet = 'claude-sonnet-5-5', gemini = 'gemini-3.8-flash';
const projects = [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }];
const query = { projectId: null, range: '30d' };
const checks = (passed, failed = 0, skipped = 0) => ({ checks: { passed, failed, skipped } });
const run = (id, extra = {}) => ({ id, at: now - 1000, projectId: 'a', project: 'Alpha', model: sol, agent: 'codex', source: 'dispatch',
  role: '执行', kind: 'core', reason: 'exit', exitCode: 0, outOfScope: 0, ...extra });
const summary = (runs, extra = {}) => summarize({ runs, now, query, projects, ...extra });
const counts = row => [row.tasks, row.passed, row.failed, row.untested, row.unfinished];

test('a task passes on its own passed checks, fails on any failed one, is untested without any that ran and unfinished when it did not end cleanly', () => {
  assert.equal(outcomeOf(run('p', checks(3))), 'passed');
  assert.equal(outcomeOf(run('f', checks(3, 1))), 'failed');
  assert.equal(outcomeOf(run('s', checks(0, 0, 2))), 'untested');
  assert.equal(outcomeOf(run('n')), 'untested', 'a record from before checks were kept is untested');
  assert.equal(outcomeOf(run('permission', { reason: 'permission', ...checks(1) })), 'passed', 'a refused action still returned the work');
  for (const [reason, extra] of [['error', { exitCode: 1 }], ['killed', {}], ['unconfirmed', {}], ['capacity', {}], ['scope', { outOfScope: 2 }], ['exit', { exitCode: 2 }]]) {
    assert.equal(outcomeOf(run(reason, { reason, ...extra, ...checks(4) })), 'unfinished', reason);
  }
  assert.equal(outcomeOf(run('out', { outOfScope: 1, ...checks(1) })), 'unfinished');
});

test('the pass rate is passed over all tasks, each model is counted from its own runs and the three CLIs appear side by side', () => {
  const runs = [run('1', checks(2)), run('2', checks(1, 1)), run('3'), run('4', { reason: 'error', exitCode: 1 }),
    ...[5, 6, 7, 8, 9].map(index => run(`c${index}`, { agent: 'claude', model: sonnet, ...checks(1) })),
    run('agy', { agent: 'agy', model: gemini, ...checks(1) })];
  const result = summary(runs);
  assert.deepEqual(result.models.map(row => [row.model, row.agent, ...counts(row), row.passRate, row.small]), [
    [sonnet, 'claude', 5, 5, 0, 0, 0, 1, false],
    [gemini, 'agy', 1, 1, 0, 0, 0, 1, true],
    [sol, 'codex', 4, 1, 1, 1, 1, 0.25, true],
  ]);
  assert.equal(result.minTasks, MIN_TASKS);
});

test('a small sample is marked and ranked after every model with enough tasks, even at 100%', () => {
  const enough = Array.from({ length: MIN_TASKS }, (_, index) => run(`s${index}`, index < 2 ? checks(1) : {}));
  const result = summary([...enough, run('tiny-1', { model: sonnet, agent: 'claude', ...checks(1) }), run('tiny-2', { model: sonnet, agent: 'claude', ...checks(1) })]);
  assert.deepEqual(result.models.map(row => [row.model, row.passRate, row.small]), [[sol, 0.4, false], [sonnet, 1, true]]);
  const ranked = summary([...enough, ...Array.from({ length: MIN_TASKS }, (_, index) => run(`c${index}`, { model: sonnet, agent: 'claude', ...checks(1) }))]);
  assert.deepEqual(ranked.models.map(row => row.model), [sonnet, sol], 'among enough tasks the higher pass rate leads');
});

test('only dispatched role runs are tasks; duplicates collapse, future, foreign and unknown-provider records are ignored', () => {
  const runs = [run('one', checks(1)), run('one', checks(1)), run('lead', { source: 'native' }), run('child', { source: 'subagent', agent: 'claude', model: sonnet }),
    run('legacy', { source: undefined }), run('later', { at: now + 1 }), run('mystery', { agent: 'other' }),
    run('usage-1', { usageRecordId: 'u' }), run('usage-2', { usageRecordId: 'u' })];
  assert.deepEqual(summary(runs).models.map(row => [row.model, row.tasks]), [[sol, 3]]);
});

test('the range and project filters select tasks, and the project list keeps every known project', () => {
  const runs = [run('old', { at: now - 10 * DAY }), run('beta', { projectId: 'b', project: 'Beta' }), run('gone', { projectId: 'c', project: 'Closed' })];
  assert.equal(summary(runs, { query: { projectId: null, range: '7d' } }).models[0].tasks, 2);
  assert.equal(summary(runs, { query: { projectId: 'b', range: 'all' } }).models[0].tasks, 1);
  assert.deepEqual(summary(runs).projects, [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }, { id: 'c', name: 'Closed' }]);
  assert.deepEqual(summary([], { query: { projectId: 'a', range: '7d' } }).models, []);
});

test('a daily trend point is the pass rate of the seven days ending that day, from a model’s first task on', () => {
  const day = back => now - back * DAY;
  const result = summary([run('a', { at: day(2), ...checks(1) }), run('b', { at: day(2) }), run('c', { at: day(0), ...checks(1) }),
    run('d', { at: day(1), model: sonnet, agent: 'claude', ...checks(0, 1) }), run('e', { at: day(20), ...checks(1) })], { query: { projectId: null, range: '30d' } });
  assert.equal(result.trend.unit, 'day');
  assert.equal(result.trend.buckets.length, 31); assert.equal(result.trend.buckets.at(-1), '2026-10-31');
  const of = model => result.trend.points.filter(point => point.model === model).map(point => [point.bucket.slice(5), point.tasks, point.passRate]);
  assert.deepEqual(of(sol), [...['10-11', '10-12', '10-13', '10-14', '10-15', '10-16', '10-17'].map(bucket => [bucket, 1, 1]),
    ['10-29', 2, 0.5], ['10-30', 2, 0.5], ['10-31', 3, 2 / 3]], 'a week with no task has no point; the window rolls over the newer tasks');
  assert.deepEqual(of(sonnet), [['10-30', 1, 0], ['10-31', 1, 0]]);
});

test('a range longer than sixty days is bucketed by weeks that start on Monday', () => {
  const result = summary([run('first', { at: now - 90 * DAY }), run('last', { at: now, ...checks(1) })], { query: { projectId: null, range: 'all' } });
  assert.equal(result.trend.unit, 'week');
  assert.ok(result.trend.buckets.every(bucket => new Date(`${bucket}T12:00:00`).getDay() === 1));
  assert.equal(result.trend.buckets.at(-1), '2026-10-26');
  assert.deepEqual(result.trend.points.map(point => [point.bucket, point.passRate]), [[result.trend.buckets[0], 0], ['2026-10-26', 1]]);
  assert.equal(summary([run('recent', { at: now - 3 * DAY })], { query: { projectId: null, range: 'all' } }).trend.unit, 'day');
});

test('model × kind cells count each pair on its own, mark small pairs and keep unreported kinds', () => {
  const runs = [...Array.from({ length: MIN_TASKS }, (_, index) => run(`core${index}`, checks(index ? 1 : 0, index ? 0 : 1))),
    run('ui', { kind: 'frontend', ...checks(1) }), run('blank', { kind: null }), run('c', { kind: 'frontend', model: sonnet, agent: 'claude' })];
  const cells = summary(runs).kinds.map(cell => [cell.kind, cell.model, cell.tasks, cell.passRate, cell.small]);
  assert.deepEqual(cells, [['core', sol, 5, 0.8, false], ['frontend', sol, 1, 1, true], ['frontend', sonnet, 1, 0, true], ['unreported', sol, 1, 0, true]]);
});

test('trend buckets follow local calendar days across a daylight-saving transition', () => {
  const script = `const { summarize } = require('./electron/features/dashboard/summary.cjs');
    const now = new Date(2026, 2, 9, 12).getTime();
    const runs = [7, 8, 9].map(day => ({ id: String(day), agent: 'codex', model: 'test', source: 'dispatch', reason: 'exit', exitCode: 0,
      at: new Date(2026, 2, day, 0, 30).getTime() }));
    process.stdout.write(JSON.stringify(summarize({ runs, now, query: { projectId: null, range: '7d' } }).trend));`;
  const trend = JSON.parse(execFileSync(process.execPath, ['-e', script], { cwd: path.resolve(__dirname, '..'),
    env: { SystemRoot: process.env.SystemRoot, TZ: 'America/New_York' }, windowsHide: true, encoding: 'utf8' }));
  assert.equal(new Set(trend.buckets).size, trend.buckets.length);
  assert.deepEqual(trend.buckets.slice(-3), ['2026-03-07', '2026-03-08', '2026-03-09']);
  assert.deepEqual(trend.points.map(point => point.bucket), ['2026-03-07', '2026-03-08', '2026-03-09']);
});
