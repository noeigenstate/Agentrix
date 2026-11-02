const { estimateCost } = require('./cost.cjs');
const { keyOf, localDay, sumActive, timedRate } = require('./summary-values.cjs');

function calendarDays(start, now) {
  const date = new Date(start), last = localDay(now), days = [];
  date.setHours(0, 0, 0, 0);
  // Calendar arithmetic keeps local midnight and daylight-saving transitions in the same bins.
  while (localDay(date.getTime()) <= last) {
    days.push(localDay(date.getTime()));
    date.setDate(date.getDate() + 1);
  }
  return days;
}

function runSeries(runs, passes, prices, models, start, now) {
  const groups = new Map();
  for (const run of runs) {
    const key = keyOf(localDay(run.at), run.model);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(run);
  }
  const daily = [], speed = [];
  for (const day of calendarDays(start, now)) for (const model of models) {
    const group = groups.get(keyOf(day, model)) || [];
    const costs = group.map(run => estimateCost(run, prices).usd).filter(value => value !== null);
    daily.push({ day, model, runs: group.length, firstPass: group.filter(run => passes.get(run) === true).length,
      costUsd: group.length && !costs.length ? null : costs.reduce((sum, value) => sum + value, 0),
      activeMs: group.length ? sumActive(group) : 0 });
    if (group.length) speed.push({ day, model, tokensPerSecond: timedRate(group) });
  }
  return { daily, speed };
}

function trends(runs, models, now) {
  const first = new Date(now);
  first.setHours(0, 0, 0, 0); first.setDate(first.getDate() - 13);
  const days = calendarDays(first.getTime(), now), counts = new Map();
  for (const run of runs) {
    if (run.at < first.getTime()) continue;
    const key = keyOf(localDay(run.at), run.model);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return new Map(models.map(model => [model, days.map(day => counts.get(keyOf(day, model)) || 0)]));
}

module.exports = { runSeries, trends };
