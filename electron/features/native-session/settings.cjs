const { readJson, writeJson } = require('./storage.cjs');
const defaults = { claudePath: 'api-then-terminal', codexAutoReset: false };
function validSettings(value, partial = false) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !Object.hasOwn(defaults, key))) return false;
  return (partial && value.claudePath === undefined || ['api-then-terminal', 'api-only', 'terminal-only'].includes(value.claudePath)) &&
    (value.codexAutoReset === undefined || typeof value.codexAutoReset === 'boolean');
}
function createSettings(file) {
  const current = stored => {
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return stored;
    return Object.fromEntries(Object.entries(stored).filter(([key]) => Object.hasOwn(defaults, key)));
  };
  let value = { ...defaults, ...current(readJson(file, defaults, { validate: stored => validSettings(current(stored), true) })) };
  return { get: () => ({ ...value }), set(patch) {
    if (!validSettings(patch, true)) throw new Error('无效的运行方式设置。');
    const next = { ...value, ...patch }; writeJson(file, next); value = next; return { ...value };
  } };
}
module.exports = { createSettings, validSettings };
