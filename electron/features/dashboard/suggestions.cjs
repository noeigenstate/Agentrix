const { createHash } = require('node:crypto');
const { translate } = require('../../i18n.cjs');
const { currentWeights, latestDecisions } = require('./decisions.cjs');
const { keyOf, nonnegative } = require('./summary-values.cjs');
const { TASK_KINDS } = require('./records-routing.cjs');

const stableId = (rule, evidence) => createHash('sha256').update(JSON.stringify([rule, evidence])).digest('hex').slice(0, 32);
const clamp = value => Math.max(0.3, Math.min(1.5, Math.round(value * 100) / 100));

function suggestions({ incidents = [], kinds = [], rounds = [], evidence = [], decisions = [], t = (source, values) => translate('zh', source, values) }) {
  const result = [], latest = latestDecisions(decisions), weights = currentWeights(decisions);
  const add = (rule, keys, title, source, values, weight = null) => {
    const id = stableId(rule, keys), previous = latest.get(id);
    const proposed = previous?.weight || weight;
    result.push({ id, kind: weight ? 'weight' : 'mechanism', title: t(title),
      text: t(source, proposed ? { ...values, from: proposed.from, to: proposed.to } : values),
      weight: proposed, state: previous?.state || 'open' });
  };
  for (const { row, key } of incidents) {
    if (!row.weight) continue;
    add('incident-weight', key, '根据事故调整任务权重',
      '{model} 在 {kind} 任务中发生事故：{cause}。建议将权重从 {from} 调整为 {to}。',
      { model: row.model, kind: row.weight.kind, cause: row.cause, from: row.weight.from, to: row.weight.to }, row.weight);
  }
  for (const row of kinds) {
    if (row.runs < 5 || row.firstPassRate === null || !TASK_KINDS.includes(row.kind)) continue;
    const best = kinds.filter(other => other.kind === row.kind && other.model !== row.model && other.runs >= 5 && other.firstPassRate !== null)
      .sort((a, b) => b.firstPassRate - a.firstPassRate || a.model.localeCompare(b.model))[0];
    if (!best || best.firstPassRate - row.firstPassRate < 0.3 - 1e-9) continue;
    const from = weights.find(weight => weight.model === row.model && weight.kind === row.kind)?.to ?? 1;
    const weight = { model: row.model, kind: row.kind, from, to: clamp(from - 0.2) };
    const keys = evidence.filter(value => value.kind === row.kind && [row.model, best.model].includes(value.model)).map(value => value.key).sort();
    add('first-pass-gap', [row.kind, row.model, best.model, row.firstPassRate, best.firstPassRate, keys], '降低低首过率模型的任务权重',
      '{model} 的 {kind} 任务首过率为 {rate}%，低于 {best} 的 {bestRate}%；两者均至少有 5 次运行。建议将权重从 {from} 调整为 {to}。',
      { model: row.model, kind: row.kind, rate: Math.round(row.firstPassRate * 100), best: best.model,
        bestRate: Math.round(best.firstPassRate * 100), from, to: weight.to }, weight);
  }
  const timed = rounds.filter(round => nonnegative(round.row.phases.build) && (round.row.rework === 0 || nonnegative(round.row.phases.rework)));
  const build = timed.reduce((sum, round) => sum + round.row.phases.build + (round.row.phases.rework || 0), 0);
  const rework = timed.reduce((sum, round) => sum + (round.row.phases.rework || 0), 0);
  if (timed.length >= 2 && build > 0 && rework / build > 0.2) {
    add('fresh-review-followups', timed.map(round => keyOf(round.key, round.row.phases)).sort(), '审查后的返工使用新会话',
      '{rounds} 轮协作中，返工占总构建活跃时间的 {percent}%。建议将审查后的返工交给新会话。',
      { rounds: timed.length, percent: Math.round(rework / build * 100) });
  }
  const changed = rounds.flatMap(round => (round.issues || []).filter(issue => typeof issue?.result === 'string' && /changed the plan|改变.*(?:计划|分工)|调整.*(?:计划|分工)/i.test(issue.result))
    .map(issue => keyOf(round.key, issue.issue, issue.answer, issue.result))).sort();
  if (changed.length) add('keep-roundtable', changed, '保留开工前的圆桌确认',
    '有 {count} 个圆桌问题改变了计划；建议保留开工前的圆桌确认。', { count: changed.length });
  return [...new Map(result.map(value => [value.id, value])).values()].sort((a, b) => a.id.localeCompare(b.id));
}

module.exports = { suggestions };
