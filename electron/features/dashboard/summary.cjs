const { adapterOf } = require('../cli-adapters/registry.cjs');
const { nonnegative, text, modelOf, keyOf, ratio, localDay } = require('./summary-values.cjs');

// The dashboard answers one question: of the tasks each model was handed, how many came back with their tests passed.
// - A task is one dispatched role run. The lead's own turns and in-process sub-agents report no checks and are left out.
// - Unfinished: the run did not end cleanly (an error, a stop, no confirmed start, a capacity end, files out of scope).
// - Otherwise the role's own checks decide (finish_role verification): any failed check fails the task, else any passed
//   check passes it; no checks, only skipped ones, or a record from before checks were kept is untested.
// - The pass rate is passed over all tasks, so an untested or unfinished task counts against a model.
// - Fewer than MIN_TASKS tasks is a small sample: it is marked and ranked after the models with enough tasks.
// - The trend's daily point is the pass rate of the seven days ending that day; a weekly point is its own week.
const DAY = 86_400_000, MIN_TASKS = 5, WEEKLY_AFTER_DAYS = 60, ROLLING_DAYS = 7;
const OUTCOMES = ['passed', 'failed', 'untested', 'unfinished'];

function outcomeOf(run) {
  if (!['exit', 'permission'].includes(run.reason) || run.exitCode !== 0 || run.outOfScope > 0) return 'unfinished';
  return run.checks?.failed > 0 ? 'failed' : run.checks?.passed > 0 ? 'passed' : 'untested';
}

function tasksOf(records, now) {
  const unique = new Map();
  for (const [index, record] of records.entries()) {
    if (!nonnegative(record?.at) || record.at > now || (record.source ?? 'dispatch') !== 'dispatch' || !adapterOf(record.agent)) continue;
    unique.set(record.usageRecordId ? keyOf('usage', record.usageRecordId) : keyOf(record.projectId, record.id || index), {
      at: record.at, projectId: record.projectId, agent: record.agent, model: modelOf(record.model, record.agent),
      kind: text(record.kind, 32) || 'unreported', outcome: outcomeOf(record) });
  }
  return [...unique.values()].sort((a, b) => a.at - b.at);
}

function groupBy(tasks, key) {
  const groups = new Map();
  for (const task of tasks) {
    const name = key(task);
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(task);
  }
  return groups;
}

function tally(tasks) {
  const counts = Object.fromEntries(OUTCOMES.map(outcome => [outcome, 0]));
  for (const task of tasks) counts[task.outcome]++;
  return { tasks: tasks.length, ...counts, passRate: ratio(counts.passed, tasks.length), small: tasks.length < MIN_TASKS };
}

// A week starts on Monday; both kinds of bucket are named by their first local day, yyyy-mm-dd.
function bucketOf(at, unit) {
  const date = new Date(at);
  date.setHours(12, 0, 0, 0);
  if (unit === 'week') date.setDate(date.getDate() - (date.getDay() + 6) % 7);
  return localDay(date.getTime());
}

function trendOf(tasks, start, now) {
  const first = tasks.length && start === null ? tasks[0].at : start ?? now;
  const unit = (now - first) / DAY > WEEKLY_AFTER_DAYS ? 'week' : 'day';
  const date = new Date(`${bucketOf(first, unit)}T12:00:00`), last = bucketOf(now, unit), buckets = [];
  // Calendar steps keep local days apart across daylight-saving changes.
  for (let bucket = localDay(date.getTime()); bucket <= last; bucket = localDay(date.getTime())) {
    buckets.push(bucket);
    date.setDate(date.getDate() + (unit === 'week' ? 7 : 1));
  }
  // A day's point covers the seven days ending with it: a model has a task or two a day, and one task alone reads only 0% or 100%.
  const span = unit === 'day' ? ROLLING_DAYS : 1, points = [];
  for (const [model, group] of groupBy(tasks, task => task.model)) {
    const at = group.map(task => buckets.indexOf(bucketOf(task.at, unit)));
    buckets.forEach((bucket, index) => {
      const window = group.filter((_, task) => at[task] <= index && at[task] > index - span);
      if (!window.length) return;
      const { tasks: count, passed, passRate } = tally(window);
      points.push({ bucket, model, tasks: count, passed, passRate });
    });
  }
  points.sort((a, b) => a.bucket.localeCompare(b.bucket) || a.model.localeCompare(b.model));
  return { unit, buckets, points };
}

// Models with enough tasks first, then by pass rate, then by how many tasks back it.
const byReliability = (a, b) => a.small - b.small || b.passRate - a.passRate || b.tasks - a.tasks || a.model.localeCompare(b.model);

function projectList(projects, records) {
  const list = new Map(projects.filter(project => text(project?.id)).map(project => [project.id, { id: project.id, name: text(project.name, 240) || project.id }]));
  for (const record of records) if (text(record?.projectId) && !list.has(record.projectId)) {
    list.set(record.projectId, { id: record.projectId, name: text(record.project, 240) || record.projectId });
  }
  return [...list.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

function summarize({ runs = [], projects = [], query = { projectId: null, range: '30d' }, now = 0 } = {}) {
  const start = query.range === 'all' ? null : now - (query.range === '7d' ? 7 : 30) * DAY;
  const tasks = tasksOf(runs, now).filter(task => (start === null || task.at >= start) && (query.projectId === null || task.projectId === query.projectId));
  const models = [...groupBy(tasks, task => task.model)].map(([model, group]) => ({ model, agent: group.at(-1).agent, ...tally(group) }))
    .sort(byReliability);
  const kinds = [...groupBy(tasks, task => keyOf(task.kind, task.model))].map(([key, group]) => {
    const [kind, model] = JSON.parse(key);
    return { kind, model, ...tally(group) };
  }).sort((a, b) => a.kind.localeCompare(b.kind) || byReliability(a, b));
  return { generatedAt: now, query: { ...query }, projects: projectList(projects, runs), minTasks: MIN_TASKS,
    models, kinds, trend: trendOf(tasks, start, now) };
}

module.exports = { summarize, outcomeOf, MIN_TASKS };
