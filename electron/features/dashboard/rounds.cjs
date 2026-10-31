const { nonnegative, text, modelOf, keyOf, execution, review, roundtable, reviewFollowup, startAt, endAt, sumActive } = require('./summary-values.cjs');
const { validWeight } = require('./decisions.cjs');

const CATEGORIES = ['correctness', 'security', 'performance', 'boundary', 'ui'];
const TYPES = ['meeting', 'skip', 'end', 'consolidate', 'incident', 'finding', 'issues'];

function journalEntries(journals, projects, projectId, now) {
  const seen = new Set(), entries = [], scopes = new Map();
  const selected = journals.filter(journal => journal && (projectId === null || journal.projectId === projectId) && Array.isArray(journal.entries));
  for (const journal of selected) {
    const key = journal.key || journal.projectId;
    if (!scopes.has(key)) scopes.set(key, []);
    scopes.get(key).push(journal.projectId);
  }
  for (const journal of selected) {
    const identity = journal.key || journal.projectId;
    if (seen.has(identity)) continue;
    seen.add(identity);
    const project = text(projects.find(value => value.id === journal.projectId)?.name || journal.project, 240) || journal.projectId;
    for (const entry of journal.entries) {
      const at = entry?.time ?? entry?.at;
      if (!TYPES.includes(entry?.type) || !nonnegative(at) || at > now) continue;
      entries.push({ ...entry, at, projectId: journal.projectId, project, projectIds: scopes.get(identity), journalKey: identity,
        model: modelOf(entry.model), author: modelOf(entry.author),
        key: keyOf(identity, entry.type, entry.id || keyOf(entry.model, entry.kind, entry.cause, entry.fix, entry.weight, entry.author, entry.category, entry.title), at) });
    }
  }
  return entries.sort((a, b) => a.at - b.at);
}

function firstConfirmed(entries) {
  const sessions = new Map();
  for (const entry of entries.filter(value => value.type === 'meeting')) {
    const key = keyOf(entry.agent, entry.session || entry.id || entry.title);
    if (!sessions.has(key)) sessions.set(key, []);
    sessions.get(key).push(entry);
  }
  return sessions.size > 0 && [...sessions.values()].every(history => {
    const first = history.find(entry => entry.confirmation);
    return first?.status === 'confirmed' && first.confirmation.status === 'confirmed';
  });
}

function completeContext(context) {
  const indexed = new Map(context.runs.filter(run => run.id).map(run => [run.id, run]));
  const ends = context.entries.filter(entry => entry.type === 'end').map(entry => {
    const run = indexed.get(entry.id); indexed.delete(entry.id);
    return run ? { ...entry, ...run, at: entry.at, activeMs: nonnegative(entry.activeMs) ? entry.activeMs : run.activeMs } : entry;
  });
  const journalIds = new Set(ends.map(run => run.id).filter(Boolean));
  context.events = [...ends, ...context.runs.filter(run => !run.id || !journalIds.has(run.id))];
  context.firstReview = Math.min(...context.events.filter(review).map(endAt));
  context.isRework = run => execution(run) && (reviewFollowup(run) || startAt(run) >= context.firstReview);
  context.reworkAuthors = new Set(context.events.filter(context.isRework).map(run => keyOf(modelOf(run.model), run.kind || 'unreported')));
  context.findingAuthors = new Set(context.entries.filter(entry => entry.type === 'finding').map(entry => entry.author));
  context.issues = context.entries.findLast(entry => entry.type === 'issues' && Array.isArray(entry.issues) && entry.issues.length <= 100 &&
    entry.issues.every(issue => issue && ['issue', 'raisedBy', 'answer', 'result'].every(key => typeof issue[key] === 'string')));
}

function roundRow(context) {
  const { entries, events, isRework } = context;
  const times = entries.map(entry => entry.at);
  const phases = {
    roundtable: sumActive(events.filter(roundtable)),
    build: sumActive(events.filter(run => execution(run) && !isRework(run))),
    review: sumActive(events.filter(review)),
    rework: sumActive(events.filter(isRework)),
  };
  return { project: context.project, meeting: context.meeting,
    at: entries.findLast(entry => entry.type === 'consolidate')?.at ?? Math.max(...times),
    tasks: events.filter(run => execution(run) && !isRework(run)).length,
    questions: context.issues ? context.issues.issues.length : null,
    findings: entries.filter(entry => entry.type === 'finding').length,
    rework: events.filter(isRework).length,
    outOfScope: events.reduce((sum, run) => sum + (nonnegative(run.outOfScope) ? run.outOfScope : 0), 0),
    incidents: entries.filter(entry => entry.type === 'incident').length,
    durationMs: times.length > 1 ? Math.max(...times) - Math.min(...times) : null,
    firstConfirmed: firstConfirmed(entries), phases };
}

function roundData(entries, runs) {
  const contexts = new Map();
  const contextFor = (projectId, meeting, project) => {
    const key = keyOf(projectId, meeting);
    if (!contexts.has(key)) contexts.set(key, { key, projectId, meeting, project, entries: [], runs: [] });
    return contexts.get(key);
  };
  const skips = new Map(entries.filter(entry => entry.type === 'skip' && entry.id).map(entry => [entry.id, entry.reason]));
  for (const entry of entries) if (text(entry.meeting, 64)) {
    const context = contextFor(entry.projectId, entry.meeting, entry.project);
    context.entries.push(entry);
    for (const id of entry.projectIds) contexts.set(keyOf(id, entry.meeting), context);
  }
  for (const run of runs) {
    run.skipMeeting ||= skips.get(run.id) || null;
    if (run.meeting) contextFor(run.projectId, run.meeting, run.project).runs.push(run);
  }
  const rounds = [];
  for (const context of new Set(contexts.values())) {
    completeContext(context);
    if (context.entries.length) rounds.push({ row: roundRow(context), key: keyOf(context.entries[0].journalKey, context.meeting), issues: context.issues?.issues ?? null });
  }
  return { contexts, rounds };
}

function incidentOf(entry) {
  const supplied = entry.weight && nonnegative(entry.weight.from) && nonnegative(entry.weight.to) &&
    { model: entry.model, kind: entry.weight.kind, from: entry.weight.from, to: Math.max(0.3, Math.min(1.5, entry.weight.to)) };
  return { at: entry.at, project: entry.project, meeting: text(entry.meeting, 64) || null,
    model: entry.model, kind: text(entry.kind, 32) || 'unreported', cause: text(entry.cause, 240), fix: text(entry.fix, 240),
    lead: ['missed', 'copied'].includes(entry.lead) ? entry.lead : null,
    weight: validWeight(supplied) ? supplied : null };
}

module.exports = { journalEntries, roundData, incidentOf, CATEGORIES };
