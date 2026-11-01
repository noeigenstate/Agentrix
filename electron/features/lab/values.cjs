const { TASK_KINDS } = require('../dashboard/records-routing.cjs');
const { estimateCost, modelKey } = require('../dashboard/cost.cjs');

const ARMS = Object.freeze(['orchestrated', 'opus', 'sol', 'sonnet']);
const MODELS = Object.freeze({ orchestrated: 'claude-opus-5-5', opus: 'claude-opus-5-5', sol: 'gpt-6.1-sol', sonnet: 'claude-sonnet-5-5' });
const DEFAULTS = Object.freeze({ orchestrated: { minutes: 15, costUsd: 2.5 }, opus: { minutes: 5, costUsd: 0.8 },
  sol: { minutes: 5, costUsd: 0.5 }, sonnet: { minutes: 4, costUsd: 0.3 } });
const validId = id => typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id);
const hash = value => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
const text = (value, limit = 160) => typeof value === 'string' && value.trim().length > 0 && value.length <= limit && !/[\x00-\x1f\x7f]/.test(value);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const finite = value => Number.isFinite(value) && value >= 0;

function sampleRequest(value) {
  if (!object(value) || !text(value.projectId) || !Number.isInteger(value.size) || value.size < 1 || value.size > 10 ||
    typeof value.preferShortComplex !== 'boolean' || value.exclude !== undefined && (!Array.isArray(value.exclude) ||
      value.exclude.length > 100 || value.exclude.some(id => !hash(id)))) throw new Error('无效的实验采样条件。');
  return { projectId: value.projectId, size: value.size, preferShortComplex: value.preferShortComplex, exclude: value.exclude || [] };
}

function experimentInput(value, estimate = false) {
  if (!object(value) || !text(value.projectId) || value.source !== 'history' || !Array.isArray(value.tasks) ||
    value.tasks.length < 1 || value.tasks.length > 10 || value.tasks.some(task => !object(task) || !hash(task.commit)) ||
    new Set(value.tasks.map(task => task.commit)).size !== value.tasks.length || !Array.isArray(value.arms) ||
    value.arms.length < 2 || value.arms.length > 4 || value.arms.some(arm => !ARMS.includes(arm)) ||
    new Set(value.arms).size !== value.arms.length || !Number.isInteger(value.repeats) || value.repeats < 1 || value.repeats > 5 ||
    !estimate && (!finite(value.budgetUsd) || value.budgetUsd <= 0 || value.budgetUsd > 100000) ||
    value.name !== undefined && !text(value.name, 120)) throw new Error('无效的实验设置。');
  return { ...(value.name ? { name: value.name.trim() } : {}), projectId: value.projectId, source: 'history',
    tasks: value.tasks.map(task => ({ commit: task.commit })), arms: [...value.arms], repeats: value.repeats,
    ...(estimate ? {} : { budgetUsd: value.budgetUsd }) };
}

// A tie, a stopped repeat or an unavailable grade cannot count as a majority pass.
function taskPasses(runs, repeats) {
  return runs.filter(run => run.testsTotal > 0 && run.testsPassed === run.testsTotal && run.state !== 'stopped').length > repeats / 2;
}

function armEstimate(arm, records, prices) {
  const model = MODELS[arm], matching = records.filter(run => modelKey(run.model) === model && run.reason === 'exit' && run.exitCode === 0 &&
    run.role === '执行' && run.activeMs > 0 && (arm !== 'sol' || run.fast === true)).slice(-50);
  const costs = matching.map(run => estimateCost(run, prices).usd).filter(finite);
  if (!matching.length || !costs.length) return { ...DEFAULTS[arm], basis: 'default' };
  const multiplier = arm === 'orchestrated' ? 3 : 1;
  return { minutes: matching.reduce((sum, run) => sum + run.activeMs / 60000, 0) / matching.length * multiplier,
    costUsd: costs.reduce((a, b) => a + b, 0) / costs.length * multiplier, basis: 'history' };
}

function estimateExperiment(input, records, prices) {
  const arms = input.arms.map(arm => armEstimate(arm, records, prices)), n = input.tasks.length * input.repeats;
  return { runs: n * arms.length, minutes: n * arms.reduce((sum, arm) => sum + arm.minutes, 0),
    costUsd: n * arms.reduce((sum, arm) => sum + arm.costUsd, 0), basis: arms.every(arm => arm.basis === 'history') ? 'history' : 'default' };
}

module.exports = { ARMS, MODELS, DEFAULTS, TASK_KINDS, validId, hash, text, finite, sampleRequest, experimentInput, taskPasses, armEstimate, estimateExperiment };
