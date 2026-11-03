const path = require('node:path');
const { createCredentials } = require('./credentials.cjs');
const { createSdkLoader } = require('./runtime.cjs');
const { resolveClaudeExecutable } = require('./executable.cjs');
const { createUsage } = require('./usage.cjs');
const { createClaudeSession } = require('./session.cjs');
const { readJson, writeJson } = require('../native-session/storage.cjs');
function createClaudeRuntime({ directory, safeStorage, loadSdk = createSdkLoader(), resolveExecutable = resolveClaudeExecutable,
  now = Date.now, onCost, onSession, audit } = {}) {
  const credentials = createCredentials({ file: path.join(directory, 'credentials.json'), safeStorage });
  const usage = createUsage({ file: path.join(directory, 'usage.json'), now });
  const sessions = new Set(), leases = new Map(); let unavailable = null;
  let decisions = readJson(path.join(directory, 'policy-audit.json'), [], { validate: value => Array.isArray(value) && value.length <= 1000 });
  const recordDecision = audit || (decision => {
    const next = [...decisions, { ...decision, at: now() }].slice(-1000);
    writeJson(path.join(directory, 'policy-audit.json'), next); decisions = next;
  });
  return {
    credentials, usage,
    apiState(budget) {
      if (!credentials.status().saved) return { status: 'no_key' };
      if (usage.available(budget) <= 0) return { status: 'budget_exhausted' };
      if (unavailable && (unavailable.until === null || unavailable.until > now())) return { status: unavailable.reason };
      return { status: 'ready' };
    },
    resetAvailability() { unavailable = null; },
    create(spec, emit) {
      const owner = {}; let leasedId = null;
      function acquire(id) {
        if (!id) return;
        if (leases.has(id) && leases.get(id) !== owner) throw new Error('该会话正在其他终端运行。');
        leases.set(id, owner); leasedId = id;
      }
      const release = () => { if (leasedId && leases.get(leasedId) === owner) leases.delete(leasedId); };
      const session = createClaudeSession(spec, emit, { loadSdk, resolveExecutable, credentials, usage, now, onCost, onSession: id => { acquire(id); onSession?.(spec, id); }, audit: decision => recordDecision({ runId: spec.runId || null, ...decision }),
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
