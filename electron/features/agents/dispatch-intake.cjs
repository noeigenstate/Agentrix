const { acceptDispatch, dispatchDirectory } = require('./dispatch-events.cjs');
const { DispatchInbox } = require('./dispatch-inbox.cjs');
const fs = require('node:fs');
const path = require('node:path');

const DISPATCH_EVENTS = ['dispatch-declared', 'dispatch-notice', 'dispatch-start', 'dispatch-routing', 'dispatch-rate', 'dispatch-end', 'dispatch-receipt', 'dispatch-input'];

// Main's intake for the dispatch-* events a session's event pipe carries, and the Codex account reports dispatched
// workers send. `deps` is the app shell (main.cjs), read on every call so its late values are current; these
// functions are among its members and reach each other through it too.
function createDispatchIntake(deps) {
  // Per local project, the newest account and quota a dispatched Codex worker's own app-server reported, as a limits
  // payload; it outlives the worker. SSH workers' accounts belong to their host's channel. Only this module writes it.
  const dispatchAccounts = new Map();
  const inboxes = new Map();

  // Main binds this before launch, rebinds it on a terminal restart, and disposes it only when that terminal is removed.
  // A signed wake can also establish it. The periodic sweep does not depend on a surviving helper or wake.
  function bindDispatchInbox(s, project) {
    let entry = inboxes.get(s.terminalId);
    if (!entry) {
      entry = { session: s, project, key: s.sessionKey };
      entry.inbox = new DispatchInbox({ directory: project.kind !== 'ssh' && s.bootstrapFile ? dispatchDirectory(s.bootstrapFile) : null,
        projectId: s.terminalId, sessionKey: s.sessionKey,
        apply: (event, key) => applyDispatchEvent(entry.session, entry.project, { ...event, sessionKey: key }, key),
        refused: value => deps.dispatchRefused?.(value) });
      inboxes.set(s.terminalId, entry);
    } else if (entry.key !== s.sessionKey) {
      entry.key = s.sessionKey; void entry.inbox.rotate(s.sessionKey);
    }
    entry.session = s; entry.project = project;
    const calls = deps.callsOf?.(s, project);
    if (calls) {
      calls.dispatchReplay = () => entry.inbox.sweep();
      calls.dispatchEnded = () => deps.replayCompletion?.(entry.project, deps.sessions.get(s.terminalId));
    }
    return entry.inbox;
  }
  function disposeDispatchInbox(terminalId) {
    const entries = terminalId === undefined ? [...inboxes.values()] : [inboxes.get(terminalId)].filter(Boolean);
    for (const { inbox } of entries) {
      inbox.dispose();
      if (!inbox.directory) continue;
      try {
        const parent = path.dirname(inbox.directory), root = fs.realpathSync(path.dirname(parent));
        const folder = fs.realpathSync(inbox.directory), expected = path.join(root, 'dispatch-outbox', path.basename(inbox.directory));
        if (path.basename(parent) === 'dispatch-outbox' && !path.relative(expected, folder)
          && !fs.lstatSync(parent).isSymbolicLink() && !fs.lstatSync(inbox.directory).isSymbolicLink()) fs.rmSync(folder, { recursive: true, force: true });
      } catch (error) { if (error.code !== 'ENOENT') inbox.refuse(null, 'dispatch.outbox_unreadable'); }
    }
    if (terminalId === undefined) inboxes.clear(); else inboxes.delete(terminalId);
  }

  // True when the event is a dispatch event, which ends its handling, whether or not the gate accepted it.
  function acceptDispatchEvent(s, project, event, acknowledge) {
    if (event.type !== 'dispatch-account' && !DISPATCH_EVENTS.includes(event.type)) return false;
    if (event.version === 1) {
      const inbox = bindDispatchInbox(s, project);
      void inbox.accept(event, acknowledge).then(result => {
        if (result.accepted) return inbox.sweep(event.id);
      }).catch(() => inbox.refuse(event, 'dispatch.outbox_unreadable'));
    } else applyDispatchEvent(s, project, event);
    return true;
  }
  function applyDispatchEvent(s, project, event, admissionKey) {
    const { callsOf, send, broadcast, rememberClaudeSource } = deps;
    if (event.type === 'dispatch-account') {
      // An account report changes nothing the window state shows; the pane is told to read usage again. Only a call the
      // session knows can report.
      const accepted = acceptDispatch(s, event, callsOf(s, project), payload => observeDispatchAccount(project, payload), admissionKey);
      if (accepted) {
        send('agents:usage-changed', { projectId: project.id });
      }
      return accepted;
    }
    const accepted = acceptDispatch(s, event, callsOf(s, project), undefined, admissionKey);
    if (accepted) {
      if (event.type === 'dispatch-start' && event.unconfirmed !== true) {
        if (event.agent === 'claude') rememberClaudeSource(event.sessionId, 'dispatch');
        try { deps.store?.queueRolePermissionsNotice?.(s.terminalId); } catch (error) { deps.report(error); }
      }
      if (event.type === 'dispatch-end') deps.roleEnded?.(s, project, event);
      broadcast();
    }
    return accepted;
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

  // The called models belong to the terminal session, so workers dispatched from a plain shell, or before the agent
  // restarts, stay visible; the agent's usage meter shares them while it runs.
  function callsOf(s, project) {
    if (s.switchPreviousHost) return callsOf(s.switchPreviousHost, project);
    const { AgentCalls, sessions, scheduleState, send, os, claudeConfigDir, sameDirectory, fs: files = fs } = deps;
    const id = s.terminalId;
    const calls = s.calls || AgentCalls.forTerminal(sessions, id, () => {
      const helperPids = new WeakMap(), current = () => sessions.get(id);
      return new AgentCalls({ terminalId: id, changed: () => scheduleState(), finished: s.recordRun, local: project.kind !== 'ssh',
        roles: () => (current()?.remoteConnection || current()?.terminal)?.appliedRouting?.roles ?? deps.routing?.sessionRoles?.(project.id) ?? null,
        dispatchAlive: async call => {
          if (project.kind === 'ssh') return null;
          let pid = call.helperPid || helperPids.get(call);
          if (!pid || call.done) {
            try {
              const team = await deps.loadTeamLocator().locateTeam(project.path);
              if (!team || !/^[a-f\d-]{36}$/i.test(call.key)) return null;
              const file = path.join(team.board, call.key + '.json');
              if (files.statSync(file).size > 65536) return null;
              const { readBoard } = require('../team/inbox.cjs');
              const entry = readBoard(files.readFileSync(file, 'utf8'));
              if (entry?.id !== call.key || path.resolve(entry.cwd) !== path.resolve(call.cwd)) return null;
              pid = entry.pid; helperPids.set(call, pid);
            } catch (error) { return call.done && error.code === 'ENOENT' ? false : null; }
          }
          return AgentCalls.alive(pid);
        },
        codexHome: () => current()?.codexHome || current()?.usageEnv?.CODEX_HOME || path.join(os.homedir(), '.codex'),
        claudeHome: () => current()?.usageEnv?.CLAUDE_CONFIG_DIR || claudeConfigDir(),
        feedChanged: event => { if (current()?.calls === calls) send('terminal:subagent-feed', { terminalId: id, ...event }); } });
    });
    if (s.nativeStructured && calls.setFolder === AgentCalls.prototype.setFolder) {
      const setFolder = calls.setFolder.bind(calls);
      // Keep this guard when the native tracker returns to a terminal host, including trackers retained from an earlier terminal.
      calls.setFolder = folder => { if (!sameDirectory(folder, calls.folder)) setFolder(folder); };
    }
    return s.calls = calls;
  }
  // An owner intervention's target, from the call the terminal's own tracker holds: never from the renderer. The planner
  // binding is the terminal session together with its CLI conversation, so a replaced conversation is never written to.
  function resolveIntervention(terminalId, callId) {
    const { sessions, store } = deps;
    const s = sessions.get(terminalId), project = store.findTerminal(terminalId)?.project, call = s?.calls?.byId(callId);
    if (!s?.sessionId || !project || !call) return null;
    return { terminalId, callId, parentSessionId: `${s.plannerSessionId || s.sessionId}:${s.claudeSessionId || s.rootThreadId || s.reportedThreadId || ''}`,
      confirmed: !call.unconfirmed, done: !!call.done, title: call.title, route: call.dispatch ? 'dispatch' : 'parent', projectPath: project.path,
      ...(call.dispatch ? { local: project.kind !== 'ssh', runId: callId.slice('dispatch:'.length), cwd: call.cwd } : {}) };
  }
  // The dashboard's 正在运行 strip: every terminal's running sub-agents and dispatched workers, with their project.
  function syncDashboardLive() {
    deps.dashboardWindow?.live([...deps.sessions.values()].flatMap(s => (s.calls?.running() ?? []).map(call => ({ ...call, project: s.projectId ?? null }))));
  }
  function dispatchedOnly(s) {
    const calls = s?.calls?.snapshot(null) || [];
    return calls.length ? { provider: null, context: null, round: null, total: null, limits: [], calls } : null;
  }

  return { acceptDispatchEvent, dispatchReading, clearDispatchAccount, bindDispatchInbox, disposeDispatchInbox,
    callsOf, dispatchedOnly, resolveIntervention, syncDashboardLive };

}

function reportDispatchRefusal({ code, id }, logger = console) {
  logger.warn('Dispatch event refused:', code, id || '');
}

module.exports = { createDispatchIntake, reportDispatchRefusal };
