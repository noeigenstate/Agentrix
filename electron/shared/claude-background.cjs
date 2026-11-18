// Parallel work goes through visible sub-agents, so a Claude Code process Agentrix starts runs without background tasks
// unless Settings allows them. A copy of the environment: process.env is never changed, and an inherited value cannot
// leak in when the switch is on.
const VARIABLE = 'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS';
function claudeBackgroundEnvironment(env, allow = false) {
  const copy = { ...env };
  for (const name of Object.keys(copy)) if (name.toUpperCase() === VARIABLE) delete copy[name];
  if (!allow) copy[VARIABLE] = '1';
  return copy;
}
module.exports = { claudeBackgroundEnvironment };
