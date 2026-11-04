const path = require('node:path');
const { createCredentials } = require('./credentials.cjs');
const { createSdkLoader } = require('./runtime.cjs');
const { resolveClaudeExecutable, inspectClaudeExecutable } = require('./executable.cjs');
const { createConnectionTest, probeBillingIdentity } = require('./connection.cjs');
const { createUsage } = require('./usage.cjs');
const { createClaudeSession } = require('./session.cjs');
const { readJson, writeJson } = require('../native-session/storage.cjs');
function createClaudeRuntime({ directory, safeStorage, loadSdk = createSdkLoader(), resolveExecutable = resolveClaudeExecutable,
  now = Date.now, onCost, onSession, audit, request, inspectCli = inspectClaudeExecutable,
  connectionSpec = () => ({ agent: 'claude', owner: 'gui', cwd: process.cwd(), effort: 'high', fast: true }) } = {}) {
  const credentials = createCredentials({ file: path.join(directory, 'credentials.json'), safeStorage });
  const usage = createUsage({ file: path.join(directory, 'usage.json'), now });
  const configDirectory = path.join(directory, 'sdk-config');
  const sessions = new Set(), leases = new Map(); let unavailable = null;
  const provenanceFile = path.join(directory, 'sdk-session-configs.json');
  const isolatedIds = new Set(readJson(provenanceFile, [], { validate: value => Array.isArray(value) && value.every(id => typeof id === 'string' && id.length > 0 && id.length <= 160) }));
  let decisions = readJson(path.join(directory, 'policy-audit.json'), [], { validate: value => Array.isArray(value) && value.length <= 1000 });
  const recordDecision = audit || (decision => {
    const next = [...decisions, { ...decision, at: now() }].slice(-1000);
    writeJson(path.join(directory, 'policy-audit.json'), next); decisions = next;
  });
  return {
    credentials, usage, testConnection: createConnectionTest({ credentials, inspectCli, request, now,
      probeBilling: (key, config = {}) => probeBillingIdentity({ key, spec: connectionSpec(), configDirectory, loadSdk, resolveExecutable,
        maxBudgetUsd: config.monthlyBudgetUsd == null ? undefined : Math.min(usage.available(config.monthlyBudgetUsd) / 1e6, 5) }) }),
    connection(id) { return [...sessions].find(session => session.snapshot().runtimeSessionId === id)?.connection() || { kind: 'none', source: null, observedAt: null }; },
    apiState(budget) {
      if (!credentials.status().saved) return { status: 'no_key' };
      if (usage.available(budget) <= 0) return { status: 'budget_exhausted' };
      if (unavailable && (unavailable.until === null || unavailable.until > now())) return { status: unavailable.reason };
      return { status: 'ready' };
    },
    resetAvailability() { unavailable = null; },
    create(spec, emit) {
      const owner = {}; let leasedId = null;
      // Existing beta sessions must still resume from the directory where the CLI wrote them.
      const isolated = !spec.providerSessionId || isolatedIds.has(spec.providerSessionId);
      function acquire(id) {
        if (!id) return;
        if (leases.has(id) && leases.get(id) !== owner) throw new Error('该会话正在其他终端运行。');
        leases.set(id, owner); leasedId = id;
      }
      const release = () => { if (leasedId && leases.get(leasedId) === owner) leases.delete(leasedId); };
      const session = createClaudeSession(spec, emit, { loadSdk, resolveExecutable, credentials, usage, now, onCost,
        configDirectory: isolated ? configDirectory : null,
        onSession: id => {
          acquire(id);
          if (isolated && !isolatedIds.has(id)) { writeJson(provenanceFile, [...isolatedIds, id]); isolatedIds.add(id); }
          onSession?.(spec, id);
        }, audit: decision => recordDecision({ runId: spec.runId || null, ...decision }),
        onFailure(reason) { if (['rate_limited', 'credits_exhausted', 'invalid_key'].includes(reason)) unavailable = { reason, until: now() + 60000 }; } });
      let closing;
      const open = async () => {
        acquire(spec.providerSessionId);
        try { return await session.start(); } catch (error) { release(); throw error; }
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
