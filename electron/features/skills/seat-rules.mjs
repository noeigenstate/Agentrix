import { adapterOfModel, agentOfModel } from '../cli-adapters/registry.mjs';

// Terminal bootstrap still reads the previous export.
export { adapterOfModel, agentOfModel, agentOfModel as familyOf };

const MODEL_ID = /^[A-Za-z0-9][\w.:@+/[\]-]*$/;
export const EFFORT = /^[a-z][a-z0-9-]{0,31}$/;
export const validModel = model => typeof model === 'string' && model.length <= 160 && MODEL_ID.test(model);
export const allowsUltracode = (model, isLead) => isLead && adapterOfModel(model).manifest.models.ultracodeLead === true;
export const rankByName = model => /(^|[-_.])(haiku|mini|nano|lite)([-_.]|$)/.test(model) ? 1 : /(^|[-_.])sonnet([-_.]|$)/.test(model) ? 2 : 3;
export const unsupportedEffort = family => `Unsupported ${family} effort.`;
