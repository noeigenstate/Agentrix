// Each task kind with the Chinese name the owner reads (translated through en.json like every interface phrase).
const KIND_NAMES = Object.freeze({ core: '复杂代码', frontend: '前端', test: '测试', 'ui-check': '界面验收', docs: '文档', small: '小任务',
  review: '审查', investigate: '调查', roundtable: '圆桌' });
const TASK_KINDS = Object.freeze(Object.keys(KIND_NAMES));
const taskKind = (options, roundtable = false) => options.kind || (roundtable ? 'roundtable'
  : ({ 审查: 'review', 调查: 'investigate', 圆桌: 'roundtable' }[options.role] || null));

function routingVerdict(actual, declared) {
  const known = key => actual[key] != null;
  if (declared && ['model', 'effort', 'fast'].some(key => known(key) && actual[key] !== declared[key])) return 'mismatch';
  return known('model') ? 'ok' : 'unverified';
}

module.exports = { TASK_KINDS, KIND_NAMES, taskKind, routingVerdict };
