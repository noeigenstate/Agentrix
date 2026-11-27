const { modelKey } = require('./cost.cjs');
const { adapterOf, agentOfModel, modelKey: providerModelKey } = require('../cli-adapters/registry.mjs');

const nonnegative = value => Number.isFinite(value) && value >= 0;
const text = (value, limit = 160) => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, limit) : '';
function modelOf(value, agent) {
  const model = modelKey(text(value)) || 'unreported';
  const manifest = adapterOf(agent)?.manifest;
  return manifest?.models.prefix && agentOfModel(model) !== agent ? providerModelKey(model, manifest) : model;
}
const keyOf = (...parts) => JSON.stringify(parts);
const ratio = (value, count) => count ? value / count : null;
function localDay(at) {
  const date = new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

module.exports = { nonnegative, text, modelOf, keyOf, ratio, localDay };
