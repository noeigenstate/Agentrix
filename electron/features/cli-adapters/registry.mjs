import claude from './manifests/claude.mjs';
import codex from './manifests/codex.mjs';

// Specific model matches precede the fallback. Both processes use these same adapter declarations.
const registered = Object.freeze([claude, codex].map(manifest => Object.freeze({ manifest })));

export const adapters = () => registered;
export const adapterOf = id => registered.find(({ manifest }) => manifest.id === id);
export const adapterOfModel = model => registered.find(({ manifest }) => manifest.models.match.test(model));
export const agentOfModel = model => adapterOfModel(model).manifest.id;
