const path = require('node:path');
const { createSettings } = require('./settings.cjs');
const { createRouter } = require('./router.cjs');
const { registerIpc } = require('./ipc.cjs');
const { decide } = require('../claude-runtime/decide.cjs');
const { overlay, testFacts } = require('../claude-runtime/resolver.cjs');
const { accountChanged, retainConnection, retainLimits, quotaRead } = require('../agents/agent-usage.cjs');
const { support } = require('../cli-adapters/capabilities.mjs');
const { adapters } = require('../cli-adapters/registry.cjs');
// Nothing tells this module that a project was removed, so it holds the last usage of the most recently read ones.
const HELD_PROJECTS = 64;
function createNativeSessions(options) {
  // Per project: its read counter, the last usage sent and, per agent, the time a quota that names no account must be newer than.
  const projects = new Map();
  const storedSettings = createSettings(path.join(options.directory, 'settings.json'));
  const settings = { ...storedSettings, set(patch) {
    const result = storedSettings.set(patch);
    if (Object.keys(patch).some(key => key !== 'codexAutoReset')) { options.claude.resetAvailability?.(); router.reconcile(true); }
    return result;
  } };
  const router = createRouter({ ...options, settings });
  async function testConnection(projectId) {
    if (options.validateProject?.(projectId)?.kind === 'ssh') projectId = undefined;
    const result = await options.claude.testConnection({ ...settings.get(), projectId });
    // The facts a new session in this scope is decided from, with what this test itself saw in place of the held ones.
    const facts = overlay(options.claude.facts(projectId), testFacts(result)), chosen = decide(facts, settings.get());
    router.reconcile();
    // The reason says why the API cannot be used, whichever path the settings then choose.
    return { ...result, path: chosen.path, reason: decide(facts).wire ?? chosen.wire };
  }
  const facade = { ...router, testConnection,
    async close() { projects.clear(); await router.close(); },
    async usage(projectId) {
      const remote = options.validateProject?.(projectId)?.kind === 'ssh';
      const key = `${remote ? 'ssh' : 'local'}:${projectId || ''}`, project = projects.get(key) || { revision: 0, floor: {} };
      projects.delete(key); projects.set(key, project);
      if (projects.size > HELD_PROJECTS) projects.delete(projects.keys().next().value);
      const revision = ++project.revision;
      const inputs = remote ? {} : await Promise.resolve().then(() => options.usageInputs?.(projectId)).catch(() => undefined);
      const usage = router.usage(inputs, projectId);
      const connections = await Promise.resolve().then(() => options.connections?.(projectId)).catch(() => null);
      const previous = project.usage;
      if (project.revision !== revision && previous) for (const { manifest: { id: agent } } of adapters()) {
        usage.agents[agent] = { ...previous.agents[agent], limits: usage.agents[agent].limits };
      }
      for (const { manifest, nativePolicy } of adapters()) {
        const agent = manifest.id;
        if (remote) {
          const next = support(manifest, 'ssh.native').ok ? { path: 'native', reason: null } : { path: null, reason: null };
          if (!next.path) {
            usage.agents[agent] = { path: null, reason: null, next, limits: null, connection: { kind: 'none', active: false, source: null, observedAt: null } };
            continue;
          }
          usage.agents[agent].next = next;
          if (nativePolicy?.remoteQuotaUnavailable) {
            const state = usage.agents[agent];
            const remoteLimits = await options.remoteLimits?.(projectId, agent, nativePolicy.remoteLimits);
            state.limits = remoteLimits ?? { scopeId: `${agent}-ssh-account`, state: 'unavailable', source: 'ssh', limitsById: {},
              billingRoute: 'unknown', observedAtMs: null, resetCredits: null, ordinaryUsageAllowed: null, reason: nativePolicy.remoteQuotaUnavailable };
            state.connection = { kind: remoteLimits ? 'subscription' : 'unknown', active: !!connections?.[agent]?.active,
              source: remoteLimits?.source ?? null, observedAt: remoteLimits?.observedAtMs ?? null };
            continue;
          }
        }
        const state = usage.agents[agent], held = previous?.agents[agent];
        // What the account reader named and what main read from the session, oldest first: each is an observation of its
        // own, so the session's (which may name no account) does not hide the reader's by being the later of the two.
        const session = connections?.[agent], account = inputs?.limits?.[agent]?.accountConnection;
        const observed = (session?.kind === 'api' && session.active) || !Number.isFinite(account?.observedAt) ? [session]
          : [{ ...account, active: session?.active ?? false }, session].sort((a, b) => (a?.observedAt ?? -Infinity) - (b?.observedAt ?? -Infinity));
        state.connection = observed.reduce((connection, next) => retainConnection(connection, next), held?.connection)
          || { kind: 'unknown', active: false, source: null, observedAt: null };
        const changed = accountChanged(held?.connection, state.connection);
        // Quota is shown only for the account now observed. A reading that names its account must name this one. One
        // that names none (a session's, which the router may hold from before the change) must be newer than the change
        // and than what the earlier account showed; the account's own read then stands in for it.
        if (changed) project.floor[agent] = Math.max(state.connection.observedAt ?? -Infinity, held.limits?.observedAtMs ?? -Infinity);
        const floor = project.floor[agent];
        const own = limits => limits && (limits.accountScopeId && state.connection.scopeId ? limits.accountScopeId === state.connection.scopeId
          : floor == null || limits.observedAtMs > floor) ? limits : null;
        const routed = own(state.limits), read = own(inputs?.limits?.[agent]);
        // The session's reading leads. Only an empty one that names no billing route (Codex said the account changed)
        // gives way, and only to the reader's newer reading of this subscription account's quota: an API connection
        // keeps its own payload.
        const standIn = routed?.billingRoute === 'unknown' && !quotaRead(routed) && state.connection.kind === 'subscription'
          && !!read?.accountScopeId && read.accountScopeId === state.connection.scopeId && quotaRead(read)
          && read.observedAtMs > (routed.observedAtMs ?? -Infinity);
        state.limits = retainLimits(changed ? null : held?.limits, standIn ? read : routed || read) || null;
        if (state.connection.kind === 'none' && Number.isFinite(state.connection.observedAt)) state.limits = null;
      }
      if (remote) usage.switches = { waiting: 0 };
      project.usage = structuredClone(usage);
      return usage;
    },
  };
  return { ...facade, getSettings: settings.get, register: handle => registerIpc({ handle, router: facade, settings, claude: options.claude, remoteModels: options.remoteModels }) };
}
module.exports = { createNativeSessions, createNativeUsage: require('./agent-usage.cjs').createNativeUsage };
