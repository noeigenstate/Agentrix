const { acceptDispatch } = require('./dispatch-events.cjs');

const DISPATCH_EVENTS = ['dispatch-start', 'dispatch-routing', 'dispatch-rate', 'dispatch-end', 'dispatch-receipt'];

// Main's intake for the dispatch-* events a session's event pipe carries, and the Codex account reports dispatched
// workers send. `deps` is the app shell (main.cjs), read on every call so its late values are current; these
// functions are among its members and reach each other through it too.
function createDispatchIntake(deps) {
  // Per local project, the newest account and quota a dispatched Codex worker's own app-server reported, as a limits
  // payload; it outlives the worker. SSH workers' accounts belong to their host's channel. Only this module writes it.
  const dispatchAccounts = new Map();

  // True when the event is a dispatch event, which ends its handling, whether or not the gate accepted it.
  function acceptDispatchEvent(s, project, event) {
    const { callsOf, send, broadcast, rememberClaudeSource } = deps;
    if (event.type === 'dispatch-account') {
      // An account report changes nothing the window state shows; the pane is told to read usage again. Only a call the
      // session knows can report.
      if (acceptDispatch(s, event, callsOf(s, project), payload => observeDispatchAccount(project, payload))) {
        send('agents:usage-changed', { projectId: project.id });
      }
      return true;
    }
    if (!DISPATCH_EVENTS.includes(event.type)) return false;
    if (acceptDispatch(s, event, callsOf(s, project))) {
      if (event.type === 'dispatch-start' && event.agent === 'claude' && event.unconfirmed !== true) rememberClaudeSource(event.sessionId, 'dispatch');
      broadcast();
    }
    return true;
  }
  function observeDispatchAccount(project, payload) {
    if (project.kind === 'ssh' || payload.observedAtMs < (dispatchAccounts.get(project.id)?.observedAtMs ?? -Infinity)) return false;
    dispatchAccounts.set(project.id, payload); return true;
  }
  // A planner in a terminal has no Codex session, so a dispatched worker's report is the pane's Codex reading — but only
  // where the project has none of its own: no running Codex session, and no account the project's read named, unless the
  // report names that same account. Another account's report never displaces the project's. Old reports read as stale.
  function dispatchReading(projectId, account, staleAfterMs) {
    const { liveHost } = deps;
    const payload = dispatchAccounts.get(projectId), named = account?.connection?.scopeId;
    if (!payload || liveHost(projectId, 'codex') || named && payload.accountScopeId !== named) return null;
    if (payload.state !== 'ready' || Date.now() - payload.observedAtMs <= staleAfterMs) return payload;
    return Object.defineProperty({ ...payload, state: 'stale' }, 'accountConnection', { value: payload.accountConnection });
  }
  function clearDispatchAccount(projectId) { dispatchAccounts.delete(projectId); }

  return { acceptDispatchEvent, dispatchAccounts, dispatchReading, clearDispatchAccount };
}

module.exports = { createDispatchIntake };
