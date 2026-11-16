const path = require('node:path');
const { createCredentials } = require('./credentials.cjs');
const { createSdkLoader } = require('./runtime.cjs');
const { resolveClaudeExecutable, inspectClaudeExecutable } = require('./executable.cjs');
const { createConnectionTest, probeBillingIdentity, netRequest } = require('./connection.cjs');
const { createUsage } = require('./usage.cjs');
const { CREDITS_LOW } = require('./identity.cjs');
const { createClaudeSession } = require('./session.cjs');
const { readJson, writeJson } = require('../native-session/storage.cjs');
const { rememberClaudeSource } = require('../../prompt-queue.cjs');
const { createResolver } = require('../claude-runtime/resolver.cjs');
const { decide, excused, nameOf } = require('../claude-runtime/decide.cjs');
function createClaudeRuntime({ directory, safeStorage, loadSdk = createSdkLoader(), resolveExecutable = resolveClaudeExecutable,
  now = Date.now, timers = globalThis, onCost, onSession, audit, request, inspectCli = inspectClaudeExecutable, initializationTimeoutMs,
  connectionSpec = () => ({ agent: 'claude', owner: 'gui', cwd: process.cwd(), effort: 'high', fast: true }) } = {}) {
  const sessions = new Set(), leases = new Map();
  let credentialVersion = 0;
  // What the path is decided from: the key, its limits, billing per project, a card's own rate limit and the CLI.
  const resolver = createResolver({ keySaved: () => credentials.status().saved, keyVersion: () => credentialVersion, inspectCli, now, timers });
  const credentials = createCredentials({ file: path.join(directory, 'credentials.json'), safeStorage, onChange: () => { credentialVersion++; resolver.reset(); } });
  const usage = createUsage({ file: path.join(directory, 'usage.json'), now });
  const ownerFile = path.join(directory, 'owner-sessions.json');
  const owners = readJson(ownerFile, []);
  const ownerSessions = new Map((Array.isArray(owners) ? owners.slice(-10000) : []).filter(row => row && typeof row.id === 'string' && /^[\w-]{1,100}$/.test(row.id) && typeof row.cwd === 'string').map(row => [row.id, row.cwd]));
  for (const [id, cwd] of ownerSessions) rememberClaudeSource(id, 'gui', cwd);
  // The API route's facts. A session already runs its Claude Code, so the CLI's fact is not one of them.
  const apiFacts = (projectId = '', card = null) => resolver.facts(projectId, card).filter(value => value.name !== 'cli');
  let decisions = readJson(path.join(directory, 'policy-audit.json'), [], { validate: value => Array.isArray(value) && value.length <= 1000 });
  const recordDecision = audit || (decision => {
    const next = [...decisions, { ...decision, at: now() }].slice(-1000);
    writeJson(path.join(directory, 'policy-audit.json'), next); decisions = next;
  });
  const runtimeApi = {
    credentials, usage, facts: resolver.facts, observeCli: resolver.observeCli, trackCli: resolver.trackCli,
    refreshAvailability: resolver.refresh, resetAvailability: resolver.reset, onAvailabilityChange: resolver.subscribe,
    testConnection: createConnectionTest({ credentials, inspectCli: resolver.checkCli, request, now, availabilityGeneration: resolver.generation,
      sessionModel: (config = {}) => connectionSpec(config.projectId).model,
      onKey: (status, observed) => resolver.observe({ kind: 'key', status, observed }),
      onCredits: (config = {}, observed) => resolver.observe({ kind: 'failure', scope: config.projectId || '', code: 'credits_exhausted', message: CREDITS_LOW, observed }),
      probeBilling: async (key, config = {}, observed) => {
        const scope = config.projectId || '', spec = connectionSpec(config.projectId);
        const result = await probeBillingIdentity({ key, spec, loadSdk, resolveExecutable, timeoutMs: initializationTimeoutMs });
        if (result.status === 'mismatch') resolver.observe({ kind: 'failure', scope, code: 'billing_identity_mismatch', message: result.reason, observed, spec });
        // A test with no project open stands for every project: each checks its billing again on its next new session.
        else if (result.status === 'ok') resolver.observe({ kind: 'identity', scope, observed, tested: true, everywhere: !scope });
        return result;
      } }),
    connection(id) { return [...sessions].find(session => session.snapshot().runtimeSessionId === id)?.connection() || { kind: 'none', source: null, observedAt: null }; },
    claimApiRetry: () => resolver.claimTrial(),
    // The API route in the shape the dispatcher's worker reads (worker.cjs), until R4 moves it onto decide().
    apiState(projectId = '', trial = null, owner = 'gui', card = null) {
      const { path: route, reason, message } = decide(apiFacts(projectId, card), {}, { owner, trial });
      return route === 'api' ? { status: 'ready' } : { status: nameOf(reason), ...(message ? { reason: message } : {}) };
    },
    create(spec, emit, rollbackCredentials = null) {
      const remember = id => {
        rememberClaudeSource(id, spec.owner === 'dispatch' ? 'dispatch' : 'gui', spec.cwd);
        if (spec.owner === 'dispatch' || !id || !spec.cwd || ownerSessions.get(id) === spec.cwd) return;
        ownerSessions.set(id, spec.cwd);
        if (ownerSessions.size > 10000) ownerSessions.delete(ownerSessions.keys().next().value);
        writeJson(ownerFile, [...ownerSessions].map(([id, cwd]) => ({ id, cwd })));
      };
      if (spec.providerSessionId) remember(spec.providerSessionId);
      const owner = {}; let leasedId = null;
      function acquire(id) {
        if (!id) return;
        if (leases.has(id) && leases.get(id) !== owner) throw new Error('该会话正在其他终端运行。');
        leases.set(id, owner); leasedId = id;
      }
      const release = () => { if (leasedId && leases.get(leasedId) === owner) leases.delete(leasedId); };
      const scope = spec.projectId || '', card = spec.terminalId || spec.runtimeSessionId;
      const session = createClaudeSession(spec, emit, { loadSdk, resolveExecutable, credentials: rollbackCredentials || credentials, usage, now, onCost,
        generation: resolver.generation, initializationTimeoutMs,
        credentialVersion: () => credentialVersion,
        providerReady: () => decide(apiFacts(scope, card), {}, { trial: spec.apiTrial }).path === 'api',
        canContinue: () => spec.owner === 'dispatch' || credentials.status().saved && spec.mayContinue?.() !== false,
        observe: observation => resolver.observe({ ...observation, scope, card, spec }),
        onSession: id => { acquire(id); remember(id); onSession?.(spec, id); }, audit: decision => recordDecision({ runId: spec.runId || null, ...decision }) });
      let closing;
      const open = async () => {
        acquire(spec.providerSessionId);
        try {
          await resolver.refresh();
          // A billing refusal or a provider limit held for this project closes the session before it asks the SDK anything.
          const blocked = !rollbackCredentials && apiFacts(scope).find(value => ['billing', 'limit'].includes(value.name)
            && !excused(value, { owner: spec.owner, trial: spec.apiTrial }));
          if (blocked) {
            const failure = Object.assign(new Error(blocked.message), { code: nameOf(blocked.reason), beforeInput: true });
            await session.close(); throw failure;
          }
          return await session.start();
        } catch (error) { release(); throw error; }
      };
      const runtime = { ...session, start: open, resume: open,
        checkpoint: () => session.checkpoint((spec, emit, credentials) => runtimeApi.create(spec, emit, credentials)),
        close() {
          return closing ||= (async () => {
            try { await session.close(); } finally { release(); sessions.delete(runtime); }
          })();
        },
      };
      sessions.add(runtime); return runtime;
    },
    async close() { resolver.close(); await Promise.allSettled([...sessions].map(session => session.close())); },
  };
  return runtimeApi;
}
module.exports = { createClaudeRuntime, netRequest };
