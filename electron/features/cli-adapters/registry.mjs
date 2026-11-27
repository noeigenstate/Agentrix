import claude from './manifests/claude.mjs';
import agy from './manifests/agy.mjs';
import codex from './manifests/codex.mjs';

// Specific model matches precede the fallback. Both processes use these same adapter declarations.
const registered = Object.freeze([claude, agy, codex].map(manifest => Object.freeze({ manifest })));

export const adapters = () => registered;
export const agentIds = () => registered.map(({ manifest }) => manifest.id);
export const adapterOf = id => registered.find(({ manifest }) => manifest.id === id);
export const adapterLabeled = label => registered.find(({ manifest }) => manifest.label === label);
export const adapterOfModel = model => registered.find(({ manifest }) => manifest.models?.match.test(model));
export const agentOfModel = model => adapterOfModel(model).manifest.id;

const stripPrefix = (model, prefix) => prefix && model.startsWith(prefix) ? model.slice(prefix.length) : model;
export const localModel = model => stripPrefix(model, adapterOfModel(model).manifest.models.prefix);

export function modelKey(model, { id, models: { prefix } }) {
  // A CLI ID that starts with the reserved prefix needs it escaped too.
  return prefix && (model.startsWith(prefix) || agentOfModel(model) !== id) ? prefix + model : model;
}

export function canonicalModelId(model) {
  const { manifest } = adapterOfModel(model);
  const local = stripPrefix(model, manifest.models.prefix);
  return local === model ? model : modelKey(local, manifest);
}
