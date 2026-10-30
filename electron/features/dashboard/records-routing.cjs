const TASK_KINDS = Object.freeze(['core', 'frontend', 'test', 'ui-check', 'docs', 'small', 'review', 'investigate', 'roundtable']);
const taskKind = (options, roundtable = false) => options.kind || (roundtable ? 'roundtable'
  : ({ 审查: 'review', 调查: 'investigate', 圆桌: 'roundtable' }[options.role] || null));

function routingVerdict(actual, declared) {
  const known = key => actual[key] != null;
  if (declared && ['model', 'effort', 'fast'].some(key => known(key) && actual[key] !== declared[key])) return 'mismatch';
  return known('model') ? 'ok' : 'unverified';
}

module.exports = { TASK_KINDS, taskKind, routingVerdict };
