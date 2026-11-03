const { TASK_KINDS } = require('../dashboard/records-routing.cjs');
const { estimateCost, modelKey } = require('../dashboard/cost.cjs');
const { LAB_ARMS: ARMS, LAB_SOURCES, TASK_ID } = require('./sources/contract.cjs');

const MODELS = Object.freeze({
  orchestrated: 'claude-opus-5-5', opus: 'claude-opus-5-5', sol: 'gpt-6.1-sol', sonnet: 'claude-sonnet-5-5',
});
const DEFAULTS = Object.freeze({
  opus: { minutes: 5, costUsd: 0.8 }, sol: { minutes: 5, costUsd: 0.5 }, sonnet: { minutes: 4, costUsd: 0.3 },
});
const REVIEWS = { opus: { minutes: 1, costUsd: 0.12 }, sonnet: { minutes: 1, costUsd: 0.06 } };
const validId = id => typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id);
const hash = value => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
const text = (value, limit = 160) => typeof value === 'string' &&
  value.trim().length > 0 && value.length <= limit && !/[\x00-\x1f\x7f]/.test(value);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const finite = value => Number.isFinite(value) && value >= 0;

function sourceScope(value) {
  if (value.source === 'history' && text(value.projectId)) return { source: 'history', projectId: value.projectId };
  if (value.source === 'oss' && Array.isArray(value.repos) && value.repos.length >= 1 && value.repos.length <= 20 &&
    value.repos.every(repo => text(repo, 240)) && new Set(value.repos).size === value.repos.length) {
    return { source: 'oss', repos: [...value.repos] };
  }
  if (value.source === 'aa' && value.benchmark === 'terminal-bench-4') return { source: 'aa', benchmark: value.benchmark };
  throw new Error('无效的实验来源。');
}

function sampleRequest(value) {
  if (!object(value) || !LAB_SOURCES.includes(value.source) || !Number.isInteger(value.size) || value.size < 1 || value.size > 66 ||
    value.source === 'history' && (value.size > 10 || typeof value.preferShortComplex !== 'boolean') ||
    value.exclude !== undefined && (!Array.isArray(value.exclude) || value.exclude.length > 100 ||
      value.exclude.some(id => typeof id !== 'string' || !TASK_ID.test(id)))) throw new Error('无效的实验采样条件。');
  return { ...sourceScope(value), size: value.size, exclude: [...(value.exclude || [])],
    ...(value.source === 'history' ? { preferShortComplex: value.preferShortComplex } : {}) };
}

function selection(value) {
  if (!object(value) || !Array.isArray(value.tasks) || !value.tasks.length || value.tasks.length > 66 ||
    value.tasks.some(task => !object(task) || typeof task.id !== 'string' || !TASK_ID.test(task.id) ||
      (value.source === 'history' ? !hash(task.id) : !task.id.startsWith(value.source + '-'))) ||
    new Set(value.tasks.map(task => task.id)).size !== value.tasks.length) throw new Error('无效的实验任务。');
  return { ...sourceScope(value), tasks: value.tasks.map(task => ({ id: task.id })) };
}

function experimentInput(value, estimate = false) {
  const sourcesValid = object(value) && Array.isArray(value.selections) && value.selections.length >= 1 && value.selections.length <= 3 &&
    value.selections.every(item => object(item) && LAB_SOURCES.includes(item.source)) &&
    new Set(value.selections.map(item => item.source)).size === value.selections.length;
  const armsValid = object(value) && Array.isArray(value.arms) && value.arms.length >= 2 && value.arms.length <= 4 &&
    value.arms.every(arm => ARMS.includes(arm)) && new Set(value.arms).size === value.arms.length;
  if (!sourcesValid || !armsValid ||
    !Number.isInteger(value.repeats) || value.repeats < 1 || value.repeats > 5 ||
    !estimate && (!finite(value.budgetUsd) || value.budgetUsd <= 0 || value.budgetUsd > 100000) ||
    value.name !== undefined && !text(value.name, 120)) throw new Error('无效的实验设置。');
  const selections = value.selections.map(selection);
  if (selections.reduce((n, item) => n + item.tasks.length, 0) * value.arms.length * value.repeats > 600) {
    throw new Error('实验运行次数不能超过 600。');
  }
  return {
    ...(value.name ? { name: value.name.trim() } : {}), selections, arms: [...value.arms], repeats: value.repeats,
    ...(estimate ? {} : { budgetUsd: value.budgetUsd }),
  };
}

function taskPasses(runs, repeats) {
  return runs.filter(run => run.testsTotal > 0 && run.testsPassed === run.testsTotal &&
    run.state !== 'stopped').length > repeats / 2;
}

function stageEstimate(arm, role, records, prices) {
  const matching = records.filter(run => run.source !== 'lab' && modelKey(run.model) === MODELS[arm] &&
    run.reason === 'exit' && run.exitCode === 0 && run.role === role && run.activeMs > 0 &&
    (arm !== 'sol' || run.fast === true)).slice(-50);
  const costs = matching.map(run => estimateCost(run, prices).usd).filter(finite);
  if (!matching.length || !costs.length) {
    return { ...(role === '审查' ? REVIEWS[arm] : DEFAULTS[arm]), basis: 'default' };
  }
  return {
    minutes: matching.reduce((sum, run) => sum + run.activeMs / 60000, 0) / matching.length,
    costUsd: costs.reduce((a, b) => a + b, 0) / costs.length, basis: 'history',
  };
}

function armEstimate(arm, records, prices, { experiments = [], projectId, source = 'history', defaults, review = true } = {}) {
  const observed = experiments.filter(experiment => !projectId || experiment.projectId === projectId)
    .flatMap(experiment => experiment.runs).filter(run => (run.source || 'history') === source && run.arm === arm &&
      ['passed', 'failed'].includes(run.state) && finite(run.costUsd) &&
      finite(run.startedAt) && finite(run.endedAt) && run.endedAt > run.startedAt).slice(-50);
  if (observed.length) return {
    minutes: observed.reduce((sum, run) => sum + (run.endedAt - run.startedAt) / 60000, 0) / observed.length,
    costUsd: observed.reduce((sum, run) => sum + run.costUsd, 0) / observed.length, basis: 'history',
  };
  if (defaults?.[arm]) return { ...defaults[arm], basis: 'default' };
  const evidence = source === 'history' ? records : [];
  const stages = arm === 'orchestrated' ? [
    stageEstimate('opus', '执行', evidence, prices), stageEstimate('sol', '执行', evidence, prices),
    stageEstimate('sonnet', '执行', evidence, prices), stageEstimate('opus', '审查', evidence, prices),
    stageEstimate('sonnet', '审查', evidence, prices),
  ] : [stageEstimate(arm, '执行', evidence, prices)];
  if (review) stages.push(stageEstimate('opus', '审查', evidence, prices));
  return {
    minutes: stages.reduce((sum, stage) => sum + stage.minutes, 0),
    costUsd: stages.reduce((sum, stage) => sum + stage.costUsd, 0),
    basis: stages.every(stage => stage.basis === 'history') ? 'history' : 'default',
  };
}

function estimateExperiment(input, records, prices, experiments = []) {
  const arms = input.arms.map(arm => armEstimate(arm, records, prices, { experiments, projectId: input.projectId }));
  const n = input.tasks.length * input.repeats;
  return {
    runs: n * arms.length, minutes: n * arms.reduce((sum, arm) => sum + arm.minutes, 0),
    costUsd: n * arms.reduce((sum, arm) => sum + arm.costUsd, 0),
    basis: arms.every(arm => arm.basis === 'history') ? 'history' : 'default',
  };
}

function upgradeExperiment(value) {
  if (Array.isArray(value.sources) && Array.isArray(value.lanes)) return value;
  const tasks = value.tasks.map(task => ({ ...task, source: 'history' }));
  const runs = value.runs.map(run => ({ ...run, source: 'history',
    score: Number.isInteger(run.testsTotal) && run.testsTotal > 0 && finite(run.testsPassed) && run.testsPassed <= run.testsTotal
      ? run.testsPassed / run.testsTotal : null }));
  const { source, ...old } = value;
  return { ...old, projectId: value.projectId ?? null, projectName: value.projectName ?? null,
    sources: ['history'], tasks, runs, lanes: [{ source: 'history', state: value.state === 'running' ? 'running' : value.state,
      scope: value.projectName || '', metric: 'hidden-tests', review: true, budgetUsd: value.budgetUsd ?? 0,
      spentUsd: value.spentUsd ?? 0, error: null, manifest: null, published: null }] };
}

module.exports = {
  ARMS, MODELS, DEFAULTS, TASK_KINDS, validId, hash, text, finite,
  sampleRequest, experimentInput, taskPasses, armEstimate, estimateExperiment, upgradeExperiment,
};
