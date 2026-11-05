// No clock, filesystem, credentials or Electron: the helper uses this same decision.
function choosePath({ agent, claudePath = 'api-then-terminal', apiState = {} }) {
  if (agent === 'codex') return { path: 'native', reason: null };
  if (claudePath === 'terminal-only') return { path: 'terminal', reason: 'terminal_selected' };
  const reason = apiState.reason || (apiState.status === 'ready' ? null : apiState.status || 'no_key');
  if (!reason) return { path: 'api', reason: null };
  return { path: claudePath === 'api-only' ? null : 'terminal', reason };
}
module.exports = { choosePath };
