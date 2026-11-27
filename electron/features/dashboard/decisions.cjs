const path = require('node:path');
const { localModel } = require('../cli-adapters/registry.mjs');
const { modelKey } = require('./cost.cjs');
const { TASK_KINDS } = require('./records-routing.cjs');
const { readJsonlSync, READ_LIMIT } = require('./jsonl.cjs');

const STATES = ['open', 'adopted', 'dismissed'];
const boundedText = value => typeof value === 'string' && value.length > 0 && value.length <= 160 && !/[\x00-\x1f\x7f]/.test(value);
function validWeight(weight) {
  if (!weight || Array.isArray(weight) || Object.keys(weight).sort().join(',') !== 'from,kind,model,to' || !boundedText(weight.model)) return false;
  const model = localModel(weight.model);
  return (model === weight.model || model !== 'unreported') && /^[a-z0-9][a-z0-9.-]{0,63}$/.test(model) &&
    TASK_KINDS.includes(weight.kind) && Number.isFinite(weight.from) && weight.from >= 0 &&
    Number.isFinite(weight.to) && weight.to >= 0.3 && weight.to <= 1.5;
}
function validDecision(record) {
  return boundedText(record?.id) && STATES.includes(record.state) && (record.weight === undefined || validWeight(record.weight));
}
function latestDecisions(records) {
  const latest = new Map();
  for (const record of [...records].filter(validDecision).sort((a, b) => a.at - b.at)) {
    latest.delete(record.id); latest.set(record.id, record);
  }
  return latest;
}
function currentWeights(records) {
  const weights = new Map();
  for (const record of latestDecisions(records).values()) {
    if (record.state !== 'adopted' || !record.weight) continue;
    const weight = { ...record.weight, model: modelKey(record.weight.model) };
    weights.set(JSON.stringify([weight.model, weight.kind]), weight);
  }
  return [...weights.values()].sort((a, b) => a.model.localeCompare(b.model) || a.kind.localeCompare(b.kind));
}
const filesFor = userData => ['decisions.1.jsonl', 'decisions.checkpoint.jsonl', 'decisions.jsonl'].map(name => path.join(userData, 'dashboard', name));
// One extra line allows a full checkpoint followed by an update of an existing id.
const readOptions = { limit: READ_LIMIT + 1 };

// Weights the owner adopted on earlier dashboards stay in the files and keep reaching model routing.
function routingNote(userData) {
  const weights = currentWeights(filesFor(userData).flatMap(file => readJsonlSync(file, readOptions)));
  if (!weights.length) return '';
  const values = weights.map(weight => `${JSON.stringify(weight.model)} / ${weight.kind}: ${weight.to}`).join('; ');
  return `Owner-adopted routing weights (model / task kind): ${values}. Use these weights when choosing workers; other pairs keep the default weight of 1.`;
}

module.exports = { currentWeights, routingNote };
