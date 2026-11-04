const path = require('node:path');
const { createCredentials } = require('./credentials.cjs');
const { createSdkLoader } = require('./runtime.cjs');
const { resolveClaudeExecutable, inspectClaudeExecutable } = require('./executable.cjs');
const { createConnectionTest, probeBillingIdentity } = require('./connection.cjs');
const { createUsage } = require('./usage.cjs');
const { createClaudeSession } = require('./session.cjs');
const { readJson, writeJson } = require('../native-session/storage.cjs');
function createClaudeRuntime({ directory, safeStorage, loadSdk = createSdkLoader(), resolveExecutable = resolveClaudeExecutable,
  now = Date.now, onCost, onSession, audit, request, inspectCli = inspectClaudeExecutable, initializationTimeoutMs,
  connectionSpec = () => ({ agent: 'claude', owner: 'gui', cwd: process.cwd(), effort: 'high', fast: true }) } = {}) {
  const sessions = new Set(), leases = new Map(); let unavailable = null, generation = 0, cliIdentity = null, refreshing;
  const resetAvailability = () => { unavailable = null; generation++; };
  const credentials = createCredentials({ file: path.join(directory, 'credentials.json'), safeStorage, onChange: resetAvailability });
  const usage = createUsage({ file: path.join(directory, 'usage.json'), now });
  function observeCli(value) {
    const identity = JSON.stringify([value.status, value.version || null, value.file || null]);
    if (cliIdentity !== null && cliIdentity !== identity) resetAvailability();
    cliIdentity = identity;
  }
  async function checkedCli() { const value = await inspectCli(); observeCli(value); return value; }
  function refreshAvailability() {
    if (unavailable?.until !== null) return Promise.resolve();
    return refreshing ||= checkedCli().catch(() => {}).finally(() => { refreshing = null; });
  }
  function onFailure(reason, error, observedGeneration) {
    if (observedGeneration !== undefined && observedGeneration !== generation) return;
    if (reason === 'billing_identity_mismatch') unavailable = { reason, detail: error.message, until: null };
    else if (unavailable?.until !== null && ['rate_limited', 'credits_exhausted', 'invalid_key'].includes(reason)) unavailable = { reason, until: now() + 60000 };
  }
  let decisions = readJson(path.join(directory, 'policy-audit.json'), [], { validate: value => Array.isArray(value) && value.length <= 1000 });
  const recordDecision = audit || (decision => {
    const next = [...decisions, { ...decision, at: now() }].slice(-1000);
    writeJson(path.join(directory, 'policy-audit.json'), next); decisions = next;
  });
  return {
    credentials, usage, observeCli, refreshAvailability,
    testConnection: createConnectionTest({ credentials, inspectCli: checkedCli, request, now, availabilityGeneration: () => generation,
      probeBilling: async (key, config = {}, observedGeneration) => {
        const result = await probeBillingIdentity({ key, spec: connectionSpec(), loadSdk, resolveExecutable,
          maxBudgetUsd: config.monthlyBudgetUsd == null ? undefined : Math.min(usage.available(config.monthlyBudgetUsd) / 1e6, 5), timeoutMs: initializationTimeoutMs });
        if (result.status === 'mismatch') onFailure('billing_identity_mismatch', { message: result.reason }, observedGeneration);
        return result;
      } }),
    connection(id) { return [...sessions].find(session => session.snapshot().runtimeSessionId === id)?.connection() || { kind: 'none', source: null, observedAt: null }; },
    apiState(budget) {
      if (!credentials.status().saved) return { status: 'no_key' };
      if (usage.available(budget) <= 0) return { status: 'budget_exhausted' };
      if (unavailable && (unavailable.until === null || unavailable.until > now())) return { status: unavailable.reason, ...(unavailable.detail ? { reason: unavailable.detail } : {}) };
      return { status: 'ready' };
    },
    resetAvailability,
    create(spec, emit) {
      const owner = {}; let leasedId = null;
      function acquire(id) {
        if (!id) return;
        if (leases.has(id) && leases.get(id) !== owner) throw new Error('该会话正在其他终端运行。');
        leases.set(id, owner); leasedId = id;
      }
      const release = () => { if (leasedId && leases.get(leasedId) === owner) leases.delete(leasedId); };
      const session = createClaudeSession(spec, emit, { loadSdk, resolveExecutable, credentials, usage, now, onCost,
        availabilityGeneration: () => generation, initializationTimeoutMs, onFailure,
        onSession: id => { acquire(id); onSession?.(spec, id); }, audit: decision => recordDecision({ runId: spec.runId || null, ...decision }) });
      let closing;
      const open = async () => {
        acquire(spec.providerSessionId);
        try {
          await refreshAvailability();
          if (unavailable?.until === null) {
            const failure = Object.assign(new Error(unavailable.detail), { code: unavailable.reason, beforeInput: true });
            await session.close(); throw failure;
          }
          return await session.start();
        } catch (error) { release(); throw error; }
      };
      const runtime = { ...session, start: open, resume: open,
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
}
module.exports = { createClaudeRuntime };
