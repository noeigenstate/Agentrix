const { readJson, writeJson } = require('./storage.cjs');
const defaults = { claudePath: 'api-then-terminal', codexView: 'native', monthlyBudgetUsd: null };
function validSettings(value, partial = false) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !Object.hasOwn(defaults, key))) return false;
  return (partial && value.claudePath === undefined || ['api-then-terminal', 'api-only', 'terminal-only'].includes(value.claudePath)) &&
    (partial && value.codexView === undefined || ['native', 'terminal'].includes(value.codexView)) &&
    (partial && value.monthlyBudgetUsd === undefined || value.monthlyBudgetUsd === null || Number.isFinite(value.monthlyBudgetUsd) && value.monthlyBudgetUsd >= 0 && value.monthlyBudgetUsd <= 1e6);
}
function createSettings(file) {
  let value = readJson(file, defaults, { validate: validSettings });
  return { get: () => ({ ...value }), set(patch) {
    if (!validSettings(patch, true)) throw new Error('无效的运行方式设置。');
    const next = { ...value, ...patch }; writeJson(file, next); value = next; return { ...value };
  } };
}
module.exports = { createSettings, validSettings };
