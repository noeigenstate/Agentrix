// The path choice in the shape the dispatcher's worker reads (worker.cjs), until R4 moves it onto decide() itself.
// No clock, filesystem, credentials or Electron: the helper uses this same decision.
const { decide } = require('../claude-runtime/decide.cjs');
const { reason, codesOf } = require('../../shared/reason.cjs');
const { adapterOf } = require('../cli-adapters/registry.mjs');
const { support } = require('../cli-adapters/capabilities.mjs');

// The fact a legacy API state names: its status is the code, its sentence the fact's message.
const FACT_OF = { no_key: 'key', invalid_key: 'key', native_cli_required: 'cli', native_cli_unverified: 'cli', cli_too_old: 'cli',
  billing_identity_mismatch: 'billing', rate_limited: 'rate' };
function fromApiState({ status, reason: message } = {}) {
  if (status === 'ready') return [];
  const name = status || 'no_key', known = codesOf('claude').includes(`claude.${name}`);
  return [{ name: FACT_OF[name] || 'limit', reason: reason(`claude.${known ? name : 'api_unavailable'}`, { source: 'api-state', observedAt: 0 }),
    ...(message || !known ? { message: message || name } : {}) }];
}
function choosePath({ agent, claudePath = 'api-then-terminal', apiState = {} }) {
  const manifest = adapterOf(agent)?.manifest;
  if (!manifest?.usage?.apiSpend) return { path: manifest && support(manifest, 'native').ok ? 'native' : null, reason: null };
  const { path, wire } = decide(fromApiState(apiState), { claudePath });
  return { path, reason: wire };
}
module.exports = { choosePath, fromApiState };
