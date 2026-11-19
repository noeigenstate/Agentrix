// Fallbacks for model IDs and efforts the provider catalog does not describe.
export const BASE_EFFORTS = {
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  codex: ['low', 'medium', 'high', 'xhigh'],
};

const MODEL_ID = /^[A-Za-z0-9][\w.:@+/[\]-]*$/;
export const EFFORT = /^[a-z][a-z0-9-]{0,31}$/;
export const validModel = model => typeof model === 'string' && model.length <= 160 && MODEL_ID.test(model);
export const familyOf = model => /^(opus|sonnet|haiku|fable|claude-)/.test(model) ? 'claude' : 'codex';
export const rankByName = model => /(^|[-_.])(haiku|mini|nano|lite)([-_.]|$)/.test(model) ? 1 : /(^|[-_.])sonnet([-_.]|$)/.test(model) ? 2 : 3;
export const unsupportedEffort = family => `Unsupported ${family} effort.`;

export const BACKGROUND_MODEL_ENV = 'ANTHROPIC_DEFAULT_HAIKU_MODEL';
export const SUBAGENT_MODEL_ENV = 'CLAUDE_CODE_SUBAGENT_MODEL';
const OPERATION_ENV = [BACKGROUND_MODEL_ENV, SUBAGENT_MODEL_ENV];
export const operationEnv = env => Object.fromEntries(OPERATION_ENV.flatMap(name =>
  Object.hasOwn(env || {}, name) && validModel(env[name]) ? [[name, env[name]]] : []));
