const { estimateCost, priceOf } = require('./cost.cjs');
const { currentWeights } = require('./decisions.cjs');
const { suggestions } = require('./suggestions.cjs');
const { journalEntries, roundData, incidentOf, CATEGORIES } = require('./rounds.cjs');
const { nonnegative, text, modelOf, keyOf, execution, reviewFollowup, ratio, average, timedRate, localDay } = require('./summary-values.cjs');

// Definitions shared by both pages:
// - Worker first pass: exit/0, no out-of-scope files, no finding against its author in the meeting, and no rework of
//   that author's task kind. A rework invocation is never a first pass. Lead deliveries pass only at submission 1.
// - Rework: execution starting after the meeting's first review ended, or an explicitly skipped review follow-up.
// - Phases: sums of active time; build excludes rework. The round's duration is its journal timestamp span.
// - First confirmation: every meeting session's first confirmation was confirmed (a later confirmation cannot fix it).
// - Speed: summed timed output / the same replies' active time, grouped by local day. Quota: latest provider reading,
//   longest window. Previous periods are adjacent, equally long windows; all has no previous period.
const DAY = 24 * 60 * 60 * 1000;

function normalizeRuns(records, now) {
  const unique = new Map();
  for (const [index, record] of records.entries()) {
    if (!nonnegative(record?.at) || record.at > now || !['codex', 'claude'].includes(record.agent)) continue;
    const run = { ...record, model: modelOf(record.model), kind: text(record.kind, 32) || 'unreported' };
    unique.set(keyOf(record.projectId, record.id || index), run);
  }
  return [...unique.values()].sort((a, b) => a.at - b.at);
}

function workerPass(run, contexts) {
  if (!execution(run) || !Number.isInteger(run.exitCode) || !nonnegative(run.outOfScope) || !text(run.reason, 32)) return null;
  if (run.reason !== 'exit' || run.exitCode !== 0 || run.outOfScope !== 0 || reviewFollowup(run)) return false;
  const context = contexts.get(keyOf(run.projectId, run.meeting));
  return !context || !context.isRework(run) && !context.findingAuthors.has(run.model) && !context.reworkAuthors.has(keyOf(run.model, run.kind));
}

function quotaData(records) {
  const latest = new Map();
  for (const record of records) {
    if (!['codex', 'claude'].includes(record.provider) || !Array.isArray(record.windows)) continue;
    // The newest reading replaces the older one even when its window duration is unreported.
    latest.set(record.provider, record);
  }
  const providers = new Map();
  for (const [provider, record] of latest) {
    const window = record.windows.filter(value => nonnegative(value?.minutes) && nonnegative(value?.percent))
      .sort((a, b) => b.minutes - a.minutes)[0];
    if (window) providers.set(provider, { provider, percent: window.percent, minutes: window.minutes, at: record.at });
  }
  const recent = [...providers.values()].sort((a, b) => b.at - a.at || a.provider.localeCompare(b.provider))[0];
  return { providers, latest: recent ? { provider: recent.provider, percent: recent.percent, minutes: recent.minutes } : null };
}

function projectList(projects, records) {
  const list = new Map(projects.filter(project => text(project?.id)).map(project => [project.id, { id: project.id, name: text(project.name, 240) || project.id }]));
  for (const record of records) if (text(record?.projectId) && !list.has(record.projectId)) {
    list.set(record.projectId, { id: record.projectId, name: text(record.project, 240) || record.projectId });
  }
  return [...list.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

function kindRates(runs, passes) {
  const groups = new Map();
  for (const run of runs) {
    const key = keyOf(run.kind, run.model);
    if (!groups.has(key)) groups.set(key, { kind: run.kind, model: run.model, outcomes: [] });
    const outcome = passes.get(run);
    if (outcome !== null) groups.get(key).outcomes.push(outcome);
  }
  return [...groups.values()].map(({ kind, model, outcomes }) => ({ kind, model, runs: outcomes.length,
    firstPassRate: ratio(outcomes.filter(Boolean).length, outcomes.length) }))
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.model.localeCompare(b.model));
}

function summarize({ records = {}, journals = [], projects = [], prices = {}, decisions = [], query = { projectId: null, range: '30d' }, now = 0, t } = {}) {
  const length = query.range === 'all' ? null : (query.range === '7d' ? 7 : 30) * DAY;
  const start = length === null ? 0 : now - length;
  const selected = record => nonnegative(record?.at) && record.at >= start && record.at <= now;
  const inProject = record => query.projectId === null || record.projectId === query.projectId;
  const globalRuns = normalizeRuns(records.runs || [], now);
  const globalEntries = journalEntries(journals, projects, null, now);
  const globalRounds = roundData(globalEntries, globalRuns);
  const passes = new Map(globalRuns.map(run => [run, workerPass(run, globalRounds.contexts)]));
  const allRuns = globalRuns.filter(inProject);
  const allGrades = (records.grades || []).filter(grade => nonnegative(grade?.at) && grade.at <= now && inProject(grade) &&
    ['codex', 'claude'].includes(grade.agent) && ['passed', 'sent-back'].includes(grade.outcome)).map(grade => ({ ...grade, model: modelOf(grade.model) }));
  const entries = query.projectId === null ? globalEntries : journalEntries(journals, projects, query.projectId, now);
  const allRounds = query.projectId === null ? globalRounds.rounds : roundData(entries, allRuns).rounds;
  const runs = allRuns.filter(selected), grades = allGrades.filter(selected);
  const rounds = allRounds.filter(round => selected(round.row)).sort((a, b) => b.row.at - a.row.at || a.key.localeCompare(b.key));
  const incidents = entries.filter(entry => entry.type === 'incident' && selected(entry)).map(entry => ({ row: incidentOf(entry), key: entry.key }));
  const findings = entries.filter(entry => entry.type === 'finding' && selected(entry) && CATEGORIES.includes(entry.category) && entry.author !== 'unreported');
  const weights = currentWeights(decisions), quota = quotaData((records.quota || []).filter(selected).sort((a, b) => a.at - b.at));
  const leadPasses = grades.filter(grade => grade.submission === 1);
  const observations = runs.map(run => passes.get(run)).filter(value => value !== null).concat(leadPasses.map(grade => grade.outcome === 'passed'));
  const modelNames = [...new Set([...runs, ...grades].map(value => value.model))].sort();
  const models = modelNames.map(model => {
    const modelRuns = runs.filter(run => run.model === model), modelGrades = grades.filter(grade => grade.model === model);
    const agent = modelRuns[0]?.agent || modelGrades[0].agent;
    const outcomes = modelRuns.map(run => passes.get(run)).filter(value => value !== null)
      .concat(modelGrades.filter(grade => grade.submission === 1).map(grade => grade.outcome === 'passed'));
    const costs = modelRuns.map(run => estimateCost(run, prices).usd).filter(value => value !== null);
    const modelWeights = weights.filter(weight => weight.model === model);
    return { model, agent, runs: modelRuns.length, firstPassRate: ratio(outcomes.filter(Boolean).length, outcomes.length),
      avgActiveMs: average(modelRuns.map(run => run.activeMs).filter(nonnegative)), tokensPerSecond: timedRate(modelRuns),
      findingsPerRun: ratio(findings.filter(finding => finding.author === model).length, modelRuns.length),
      sentBack: modelGrades.filter(grade => grade.outcome === 'sent-back').length,
      outOfScope: modelRuns.reduce((sum, run) => sum + (nonnegative(run.outOfScope) ? run.outOfScope : 0), 0),
      incidents: incidents.filter(incident => incident.row.model === model).length,
      quotaPercent: quota.providers.get(agent)?.percent ?? null,
      costUsd: costs.length ? costs.reduce((sum, cost) => sum + cost, 0) : null, costedRuns: costs.length,
      weight: modelWeights.length ? Math.min(...modelWeights.map(weight => weight.to)) : 1 };
  });
  const groupedSpeed = new Map(), findingCells = new Map();
  for (const run of runs) {
    const day = keyOf(localDay(run.at), run.model);
    if (!groupedSpeed.has(day)) groupedSpeed.set(day, []);
    groupedSpeed.get(day).push(run);
  }
  const kinds = kindRates(runs, passes);
  const speed = [...groupedSpeed.values()].map(group => ({ day: localDay(group[0].at), model: group[0].model, tokensPerSecond: timedRate(group) }))
    .sort((a, b) => a.day.localeCompare(b.day) || a.model.localeCompare(b.model));
  for (const finding of findings) {
    const key = keyOf(finding.author, finding.category);
    const cell = findingCells.get(key) || { author: finding.author, category: finding.category, count: 0 };
    cell.count++; findingCells.set(key, cell);
  }
  const previous = length === null ? null : allRounds.filter(round => round.row.at >= start - length && round.row.at < start);
  const knownFixes = findings.filter(finding => typeof finding.fixed === 'boolean');
  return { generatedAt: now, query: { ...query }, projects: projectList(projects, [...(records.runs || []), ...(records.grades || [])]),
    kpis: { firstPassRate: ratio(observations.filter(Boolean).length, observations.length), runs: runs.length,
      runsPrevious: length === null ? null : allRuns.filter(run => run.at >= start - length && run.at < start).length,
      incidents: incidents.length, quota: quota.latest,
      reworkPerRound: average(rounds.map(round => round.row.rework)),
      reworkPerRoundPrevious: previous === null ? null : average(previous.map(round => round.row.rework)), rounds: rounds.length,
      roundtableFirstConfirm: ratio(rounds.filter(round => round.row.firstConfirmed).length, rounds.length),
      findingsPerRound: ratio(rounds.reduce((sum, round) => sum + round.row.findings, 0), rounds.length),
      findingFixRate: ratio(knownFixes.filter(finding => finding.fixed).length, knownFixes.length) },
    models, kinds, speed, incidents: incidents.map(incident => incident.row).sort((a, b) => b.at - a.at), rounds: rounds.map(round => round.row),
    findings: [...findingCells.values()].sort((a, b) => a.author.localeCompare(b.author) || a.category.localeCompare(b.category)),
    suggestions: suggestions({ incidents: globalEntries.filter(entry => entry.type === 'incident').map(entry => ({ row: incidentOf(entry), key: entry.key })),
      kinds: kindRates(globalRuns, passes), rounds: globalRounds.rounds, decisions, t }),
    weights, prices: { updated: prices.updated || '', unpriced: [...new Set(runs.filter(run => !priceOf(run.model, prices)).map(run => run.model))].sort() } };
}

module.exports = { summarize };
