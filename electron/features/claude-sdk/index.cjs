const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createCredentials } = require('./credentials.cjs');
const { createSdkLoader } = require('./runtime.cjs');
const { resolveClaudeExecutable, inspectClaudeExecutable } = require('./executable.cjs');
const { createConnectionTest, probeBillingIdentity } = require('./connection.cjs');
const { createUsage } = require('./usage.cjs');
const { createClaudeSession } = require('./session.cjs');
const { readJson, writeJson } = require('../native-session/storage.cjs');
const { rememberClaudeSource } = require('../../prompt-queue.cjs');
function createClaudeRuntime({ directory, safeStorage, loadSdk = createSdkLoader(), resolveExecutable = resolveClaudeExecutable,
  now = Date.now, onCost, onSession, audit, request, inspectCli = inspectClaudeExecutable, initializationTimeoutMs,
  connectionSpec = () => ({ agent: 'claude', owner: 'gui', cwd: process.cwd(), effort: 'high', fast: true }) } = {}) {
  const sessions = new Set(), leases = new Map(), unavailable = new Map(), observations = new Map(), listeners = new Set();
  let generation = 0, observation = 0, cliIdentity = null, refreshing, credentialVersion = 0;
  const notify = () => { for (const listener of listeners) listener(); };
  const resetAvailability = () => { unavailable.clear(); observations.clear(); generation++; notify(); };
  const availabilityGeneration = () => ({ generation, sequence: ++observation });
  const currentObservation = (scope, value) => value?.generation === generation && value.sequence >= (observations.get(scope) || 0);
  const credentials = createCredentials({ file: path.join(directory, 'credentials.json'), safeStorage, onChange: () => { credentialVersion++; resetAvailability(); } });
  const usage = createUsage({ file: path.join(directory, 'usage.json'), now });
  const ownerFile = path.join(directory, 'owner-sessions.json');
  const owners = readJson(ownerFile, []);
  const ownerSessions = new Map((Array.isArray(owners) ? owners.slice(-10000) : []).filter(row => row && typeof row.id === 'string' && /^[\w-]{1,100}$/.test(row.id) && typeof row.cwd === 'string').map(row => [row.id, row.cwd]));
  for (const [id, cwd] of ownerSessions) rememberClaudeSource(id, 'gui', cwd);
  function observeCli(value) {
    const identity = JSON.stringify([value.status, value.version || null, value.file || null]);
    if (cliIdentity !== null && cliIdentity !== identity) resetAvailability();
    cliIdentity = identity;
  }
  async function checkedCli() { const value = await inspectCli(); observeCli(value); return value; }
  function refreshAvailability() {
    if (![...unavailable.values()].some(value => value.reason === 'billing_identity_mismatch')) return Promise.resolve();
    return refreshing ||= checkedCli().catch(() => {}).finally(() => { refreshing = null; });
  }
  function onFailure(scope, reason, error, observedGeneration) {
    if (observedGeneration?.generation !== generation) return;
    if (reason === 'billing_identity_mismatch') {
      if (!currentObservation(scope, observedGeneration)) return;
      observations.set(scope, observedGeneration.sequence);
      unavailable.set(scope, { reason, detail: error.message, until: null });
    }
    else if (reason === 'credits_exhausted' && unavailable.get(scope)?.reason !== 'billing_identity_mismatch') {
      unavailable.set(scope, { reason, until: null, retryAt: now() + 600000, trial: null });
    }
    else if (unavailable.get(scope)?.until !== null && ['rate_limited', 'invalid_key'].includes(reason)) unavailable.set(scope, { reason, until: now() + 60000 });
    else return;
    notify();
  }
  function onIdentity(scope, observedGeneration, tested = false) {
    if (!currentObservation(scope, observedGeneration)) return;
    observations.set(scope, observedGeneration.sequence);
    if ((tested || unavailable.get(scope)?.reason !== 'credits_exhausted') && unavailable.delete(scope)) notify();
  }
  let decisions = readJson(path.join(directory, 'policy-audit.json'), [], { validate: value => Array.isArray(value) && value.length <= 1000 });
  const recordDecision = audit || (decision => {
    const next = [...decisions, { ...decision, at: now() }].slice(-1000);
    writeJson(path.join(directory, 'policy-audit.json'), next); decisions = next;
  });
  const runtimeApi = {
    credentials, usage, observeCli, refreshAvailability,
    onAvailabilityChange(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    testConnection: createConnectionTest({ credentials, inspectCli: checkedCli, request, now, availabilityGeneration,
      probeBilling: async (key, config = {}, observedGeneration) => {
        const scope = config.projectId || '';
        const result = await probeBillingIdentity({ key, spec: connectionSpec(config.projectId), loadSdk, resolveExecutable,
          maxBudgetUsd: config.monthlyBudgetUsd == null ? undefined : usage.available(config.monthlyBudgetUsd) / 1e6, timeoutMs: initializationTimeoutMs });
        if (result.status === 'mismatch') onFailure(scope, 'billing_identity_mismatch', { message: result.reason }, observedGeneration);
        else if (result.status === 'ok') onIdentity(scope, observedGeneration, true);
        return result;
      } }),
    connection(id) { return [...sessions].find(session => session.snapshot().runtimeSessionId === id)?.connection() || { kind: 'none', source: null, observedAt: null }; },
    claimApiRetry(projectId = '') {
      const failure = unavailable.get(projectId);
      if (failure?.reason !== 'credits_exhausted' || failure.retryAt > now()) return null;
      failure.retryAt = now() + 600000;
      return failure.trial = randomUUID();
    },
    apiState(budget, projectId = '', trial = null, owner = 'gui') {
      if (!credentials.status().saved) return { status: 'no_key' };
      if (usage.available(budget) <= 0) return { status: 'budget_exhausted' };
      const failure = unavailable.get(projectId);
      if (owner === 'dispatch' && failure?.reason === 'credits_exhausted') return { status: 'ready' };
      if (trial && failure?.trial === trial) return { status: 'ready' };
      if (failure && (failure.until === null || failure.until > now())) return { status: failure.reason, ...(failure.detail ? { reason: failure.detail } : {}) };
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
      const session = createClaudeSession(spec, emit, { loadSdk, resolveExecutable, credentials: rollbackCredentials || credentials, usage, now, onCost,
        availabilityGeneration, initializationTimeoutMs,
        credentialVersion: () => credentialVersion,
        canContinue: () => spec.owner === 'dispatch' || credentials.status().saved && spec.mayContinue?.() !== false,
        onFailure: (reason, error, observedGeneration) => onFailure(spec.projectId || '', reason, error, observedGeneration),
        onIdentity: observedGeneration => onIdentity(spec.projectId || '', observedGeneration),
        onSuccess: observedGeneration => onIdentity(spec.projectId || '', observedGeneration, true),
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
module.exports = { createClaudeRuntime };
