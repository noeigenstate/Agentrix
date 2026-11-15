const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createCredentials } = require('./credentials.cjs');
const { createSdkLoader } = require('./runtime.cjs');
const { resolveClaudeExecutable, inspectClaudeExecutable } = require('./executable.cjs');
const { createConnectionTest, probeBillingIdentity, netRequest } = require('./connection.cjs');
const { createUsage } = require('./usage.cjs');
const { CREDITS_LOW } = require('./identity.cjs');
const { createClaudeSession } = require('./session.cjs');
const { readJson, writeJson } = require('../native-session/storage.cjs');
const { rememberClaudeSource } = require('../../prompt-queue.cjs');
function createClaudeRuntime({ directory, safeStorage, loadSdk = createSdkLoader(), resolveExecutable = resolveClaudeExecutable,
  now = Date.now, onCost, onSession, audit, request, inspectCli = inspectClaudeExecutable, initializationTimeoutMs,
  connectionSpec = () => ({ agent: 'claude', owner: 'gui', cwd: process.cwd(), effort: 'high', fast: true }) } = {}) {
  const sessions = new Set(), leases = new Map(), unavailable = new Map(), observations = new Map(), listeners = new Set();
  // A final rate limit belongs to the one session that received it: its card (terminalId -> until), so the terminal that
  // replaces it keeps the terminal for that minute. Credits and account limits are the account's and stay in `unavailable`
  // for the whole project.
  const rateLimited = new Map();
  let generation = 0, observation = 0, cliIdentity = null, refreshing, credentialVersion = 0;
  const notify = () => { for (const listener of listeners) listener(); };
  const resetAvailability = () => { unavailable.clear(); rateLimited.clear(); observations.clear(); generation++; notify(); };
  const availabilityGeneration = () => ({ generation, sequence: ++observation });
  const currentObservation = (scope, value) => value?.generation === generation && value.sequence >= (observations.get(scope) || 0);
  const credentials = createCredentials({ file: path.join(directory, 'credentials.json'), safeStorage, onChange: () => { credentialVersion++; resetAvailability(); } });
  const usage = createUsage({ file: path.join(directory, 'usage.json'), now });
  const ownerFile = path.join(directory, 'owner-sessions.json');
  const owners = readJson(ownerFile, []);
  const ownerSessions = new Map((Array.isArray(owners) ? owners.slice(-10000) : []).filter(row => row && typeof row.id === 'string' && /^[\w-]{1,100}$/.test(row.id) && typeof row.cwd === 'string').map(row => [row.id, row.cwd]));
  for (const [id, cwd] of ownerSessions) rememberClaudeSource(id, 'gui', cwd);
  // CLI checks are numbered as they start. One that comes back after a later one was seen is stale: it changes nothing,
  // and its caller gets the newer result instead.
  let cliIssued = 0, cliSeen = 0, cliLatest;
  function observeCli(value, ticket = ++cliIssued) {
    if (ticket < cliSeen) return false;
    cliSeen = ticket; cliLatest = value;
    const identity = JSON.stringify([value.status, value.version || null, value.file || null]);
    if (cliIdentity !== null && cliIdentity !== identity) resetAvailability();
    cliIdentity = identity;
    return true;
  }
  async function trackCli(check) {
    const ticket = ++cliIssued, value = await check;
    return observeCli(value, ticket) ? value : cliLatest;
  }
  const checkedCli = () => trackCli(inspectCli());
  function refreshAvailability() {
    if (![...unavailable.values()].some(value => value.reason === 'billing_identity_mismatch')) return Promise.resolve();
    return refreshing ||= checkedCli().catch(() => {}).finally(() => { refreshing = null; });
  }
  function onFailure(scope, reason, error, observedGeneration, card = null) {
    if (observedGeneration?.generation !== generation) return;
    if (reason === 'rate_limited') {
      if (!card) return;
      for (const [id, until] of rateLimited) if (until <= now()) rateLimited.delete(id);
      rateLimited.set(card, now() + 60000);
    }
    else if (reason === 'billing_identity_mismatch') {
      if (!currentObservation(scope, observedGeneration)) return;
      observations.set(scope, observedGeneration.sequence);
      unavailable.set(scope, { reason, detail: error.message, until: null });
    }
    else if (['credits_exhausted', 'account_limit'].includes(reason) && unavailable.get(scope)?.reason !== 'billing_identity_mismatch') {
      unavailable.set(scope, { reason, until: null, retryAt: now() + 600000, trial: null, ...(error?.message ? { detail: error.message } : {}) });
    }
    else if (unavailable.get(scope)?.until !== null && reason === 'invalid_key') unavailable.set(scope, { reason, until: now() + 60000 });
    else return;
    notify();
  }
  function onIdentity(scope, observedGeneration, tested = false) {
    if (!currentObservation(scope, observedGeneration)) return;
    observations.set(scope, observedGeneration.sequence);
    if ((tested || !['credits_exhausted', 'account_limit'].includes(unavailable.get(scope)?.reason)) && unavailable.delete(scope)) notify();
  }
  let decisions = readJson(path.join(directory, 'policy-audit.json'), [], { validate: value => Array.isArray(value) && value.length <= 1000 });
  const recordDecision = audit || (decision => {
    const next = [...decisions, { ...decision, at: now() }].slice(-1000);
    writeJson(path.join(directory, 'policy-audit.json'), next); decisions = next;
  });
  const runtimeApi = {
    credentials, usage, observeCli, trackCli, refreshAvailability,
    onAvailabilityChange(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    testConnection: createConnectionTest({ credentials, inspectCli: checkedCli, request, now, availabilityGeneration,
      sessionModel: (config = {}) => connectionSpec(config.projectId).model,
      onCredits: (config = {}, observedGeneration) => onFailure(config.projectId || '', 'credits_exhausted', new Error(CREDITS_LOW), observedGeneration),
      probeBilling: async (key, config = {}, observedGeneration) => {
        const scope = config.projectId || '';
        const result = await probeBillingIdentity({ key, spec: connectionSpec(config.projectId), loadSdk, resolveExecutable, timeoutMs: initializationTimeoutMs });
        if (result.status === 'mismatch') onFailure(scope, 'billing_identity_mismatch', { message: result.reason }, observedGeneration);
        else if (result.status === 'ok') onIdentity(scope, observedGeneration, true);
        return result;
      } }),
    connection(id) { return [...sessions].find(session => session.snapshot().runtimeSessionId === id)?.connection() || { kind: 'none', source: null, observedAt: null }; },
    claimApiRetry(projectId = '') {
      const failure = unavailable.get(projectId);
      if (!['credits_exhausted', 'account_limit'].includes(failure?.reason) || failure.retryAt > now()) return null;
      failure.retryAt = now() + 600000;
      return failure.trial = randomUUID();
    },
    // The API route for a project; given a session's card (terminalId), also that session's own final rate limit.
    apiState(projectId = '', trial = null, owner = 'gui', card = null) {
      if (!credentials.status().saved) return { status: 'no_key' };
      const failure = unavailable.get(projectId), excused = owner === 'dispatch' && failure?.reason === 'credits_exhausted' || trial && failure?.trial === trial;
      if (!excused && failure && (failure.until === null || failure.until > now())) return { status: failure.reason, ...(failure.detail ? { reason: failure.detail } : {}) };
      if (rateLimited.get(card) > now()) return { status: 'rate_limited' };
      return { status: 'ready' };
    },
    resetAvailability,
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
      const card = spec.terminalId || spec.runtimeSessionId;
      const session = createClaudeSession(spec, emit, { loadSdk, resolveExecutable, credentials: rollbackCredentials || credentials, usage, now, onCost,
        availabilityGeneration, initializationTimeoutMs,
        credentialVersion: () => credentialVersion,
        providerReady: () => runtimeApi.apiState(spec.projectId, spec.apiTrial, 'gui', card).status === 'ready',
        canContinue: () => spec.owner === 'dispatch' || credentials.status().saved && spec.mayContinue?.() !== false,
        onFailure: (reason, error, observedGeneration) => onFailure(spec.projectId || '', reason, error, observedGeneration, card),
        onIdentity: observedGeneration => onIdentity(spec.projectId || '', observedGeneration),
        onSuccess: observedGeneration => { rateLimited.delete(card); onIdentity(spec.projectId || '', observedGeneration, true); },
        onSession: id => { acquire(id); remember(id); onSession?.(spec, id); }, audit: decision => recordDecision({ runId: spec.runId || null, ...decision }) });
      let closing;
      const open = async () => {
        acquire(spec.providerSessionId);
        try {
          await refreshAvailability();
          const blocked = unavailable.get(spec.projectId || '');
          if (blocked?.until === null && !(spec.owner === 'dispatch' && blocked.reason === 'credits_exhausted')
            && !(spec.apiTrial && blocked.trial === spec.apiTrial) && !rollbackCredentials) {
            const failure = Object.assign(new Error(blocked.detail), { code: blocked.reason, beforeInput: true });
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
    async close() { await Promise.allSettled([...sessions].map(session => session.close())); },
  };
  return runtimeApi;
}
module.exports = { createClaudeRuntime, netRequest };
