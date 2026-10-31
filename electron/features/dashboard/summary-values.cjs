const { modelKey } = require('./cost.cjs');

const nonnegative = value => Number.isFinite(value) && value >= 0;
const text = (value, limit = 160) => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, limit) : '';
const modelOf = value => modelKey(text(value)) || 'unreported';
const keyOf = (...parts) => JSON.stringify(parts);
const execution = run => ['执行', 'execution'].includes(run.role);
const review = run => ['审查', 'review'].includes(run.role) || run.kind === 'review';
const roundtable = run => ['圆桌', 'roundtable'].includes(run.role) || run.kind === 'roundtable';
const reviewFollowup = run => execution(run) && /review|follow[ -]?up|审查|复审|复核|返工/i.test(run.skipMeeting || '');
const endAt = run => nonnegative(run.endedAt) ? run.endedAt : run.at;
const startAt = run => nonnegative(run.startedAt) ? run.startedAt : run.at;
const ratio = (value, count) => count ? value / count : null;
const average = values => ratio(values.reduce((sum, value) => sum + value, 0), values.length);
function sumActive(runs) {
  if (!runs.length || runs.some(run => !nonnegative(run.activeMs))) return null;
  return runs.reduce((sum, run) => sum + run.activeMs, 0);
}
function timedRate(runs) {
  const timed = runs.filter(run => nonnegative(run.outputTokens) && nonnegative(run.activeMs) && run.activeMs > 0);
  const active = timed.reduce((sum, run) => sum + run.activeMs, 0);
  return active ? timed.reduce((sum, run) => sum + run.outputTokens, 0) * 1000 / active : null;
}
function localDay(at) {
  const date = new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

module.exports = { nonnegative, text, modelOf, keyOf, execution, review, roundtable, reviewFollowup, endAt, startAt,
  ratio, average, sumActive, timedRate, localDay };
