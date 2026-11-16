// The facts a Claude path is decided from (C-11), each with its own scope, fingerprint and expiry:
// - key: no key saved, or the saved one refused (the key's: every project; a refusal the connection test saw keeps new
//   sessions off the API until the key changes, one a session saw keeps every session off it for a minute);
// - limit: credits or an account limit the provider reported (the key's: every project), with one ten-minute trial;
// - billing: Claude Code billing another credential than the key, for one project, while its settings chain (the user's,
//   the managed and the project's settings files) and the key are what they were when it was seen (N1);
// - rate: a final rate limit, for the one card that received it, for a minute;
// - cli: the last check of the Claude Code the native path runs.
// Sessions and the connection test tell it what they saw (`observe`); `facts(scope, card)` is what decide() reads. It
// starts no session, spends nothing and writes no file (I6).
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createFacts, fact } = require('./facts.cjs');

// The scopes of the key's facts: what sessions saw, and the connection test's refusal, which only new sessions read.
const KEY = '', TESTED = 'connection-test';
const LIMIT_REASONS = new Set(['credits_exhausted', 'account_limit']);
// A Claude Code the last check could not run is checked again at a start only once this long has passed: an explicit
// check can take seconds (the stored PATH, then the version check), and a start must not wait for it every time.
const MINUTE = 60000, TRIAL = 600000, CLI_RECHECK = 10000;
const MANAGED = { win32: 'C:\\Program Files\\ClaudeCode', darwin: '/Library/Application Support/ClaudeCode', linux: '/etc/claude-code' };

// The settings files Claude Code reads for a session of this spec: the user's (where the session's own environment
// puts its config folder), the managed policy, then each project folder from cwd up to the project root.
function settingsChain({ cwd, worktree, projectRoot, env } = {}, platform = process.platform) {
  const paths = platform === 'win32' ? path.win32 : path.posix, inherited = env || process.env;
  const home = platform === 'win32' ? inherited.USERPROFILE || inherited.HOME : inherited.HOME || inherited.USERPROFILE;
  const config = inherited.CLAUDE_CONFIG_DIR || (home ? paths.join(home, '.claude') : null);
  const files = [...(config ? [paths.join(config, 'settings.json')] : []), paths.join(MANAGED[platform] || MANAGED.linux, 'managed-settings.json')];
  const start = paths.resolve(cwd || process.cwd()), root = paths.resolve(worktree || projectRoot || start);
  for (let folder = start; folder === root || folder.startsWith(root + paths.sep); folder = paths.dirname(folder)) {
    files.push(paths.join(folder, '.claude', 'settings.json'), paths.join(folder, '.claude', 'settings.local.json'));
    if (folder === root) break;
  }
  return files;
}

// What a CLI check says about the native path, as a fact; null when it found one it can run.
function cliFact(value, observedAt = Date.now()) {
  if (!value || value.status === 'ok') return null;
  const code = value.status === 'too_old' ? 'cli_too_old' : value.reason && value.reason !== 'not_found' ? 'native_cli_unverified' : 'native_cli_required';
  return fact('cli', code, { source: 'locator', observedAt });
}

// The facts a connection test's own result gives, which stand in for the held ones of the same name for that test's
// answer: a key or billing answer it could not get is not held for later sessions, and its billing answer is told as the
// test's own reason says it.
function testFacts(result, observedAt = Date.now()) {
  const said = { forbidden: 'key_forbidden', rate_limited: 'rate_limited', unreachable: 'api_unreachable', error: 'key_check_failed', missing: 'no_key', invalid: 'invalid_key' };
  const value = (name, code, message) => code ? fact(name, code, { source: 'connection-test', observedAt, message }) : { name, reason: null };
  const billing = result.billing?.status === 'ok' ? null : result.billing?.status === 'mismatch' ? 'billing_identity_mismatch' : 'billing_unconfirmed';
  return [value('key', said[result.key?.status]), cliFact(result.cli, observedAt) || value('cli', null), value('billing', billing, result.reason || undefined)];
}
// Held facts with the given ones in place of those of the same name; one whose reason is null removes its name.
const overlay = (held, given) => [...given.filter(value => value.reason), ...held.filter(value => !given.some(other => other.name === value.name))];

function createResolver({ keySaved, keyVersion = () => 0, inspectCli, now = Date.now, timers = globalThis, stat = fs.statSync, platform = process.platform }) {
  const signature = files => JSON.stringify(files.map(file => { try { const { size, mtimeMs } = stat(file); return [file, size, mtimeMs]; } catch { return [file]; } }));
  const facts = createFacts({ now, fingerprints: { billing: value => `${keyVersion()}:${signature(value.files)}`,
    key: () => String(keyVersion()), limit: () => String(keyVersion()), rate: () => String(keyVersion()) } });
  const listeners = new Set(), holds = new Map(), observations = new Map();
  const notify = () => { for (const listener of listeners) listener(); };
  // Observations are numbered within a generation; a reset starts a new one, so a check that began before it changes nothing.
  let generation = 0, sequence = 0;
  const current = observed => observed?.generation === generation;
  const latest = (scope, observed) => current(observed) && observed.sequence >= (observations.get(scope) || 0);
  const release = card => { timers.clearTimeout(holds.get(card)); holds.delete(card); facts.remove('rate', card); };
  function reset() { [...holds.keys()].forEach(release); facts.clear(); observations.clear(); generation++; notify(); }

  function failed({ scope = '', code, message, observed, card = null, spec = {} }) {
    if (!current(observed)) return;
    if (code === 'rate_limited') {
      if (!card) return;
      release(card);
      facts.set('rate', card, code, { source: 'session', expiresAt: now() + MINUTE });
      const timer = timers.setTimeout(() => { if (holds.get(card) === timer) { holds.delete(card); notify(); } }, MINUTE);
      timer?.unref?.(); holds.set(card, timer);
    } else if (code === 'billing_identity_mismatch') {
      if (!latest(scope, observed)) return;
      observations.set(scope, observed.sequence);
      facts.set('billing', scope, code, { source: 'session', message, files: settingsChain(spec, platform) });
    } else if (LIMIT_REASONS.has(code)) {
      facts.set('limit', KEY, code, { source: 'session', message, retryAt: now() + TRIAL, trial: null });
    } else if (code === 'invalid_key') {
      facts.set('key', KEY, code, { source: 'session', expiresAt: now() + MINUTE });
    } else return;
    notify();
  }
  // Claude Code reported the saved key: this project's billing holds again, and a session's key refusal (the same key,
  // whichever project saw it) is over. A tested one (a connection test, or a turn the provider accepted) also ends the
  // limits, and a turn the provider accepted (`accepted`) also ends the connection test's key refusal: the key works. A
  // test with no project ends every project's billing refusal seen before it began, so each checks again (N2); a refusal
  // a session saw after that stands.
  function identified({ scope = '', observed, tested = false, accepted = false, everywhere = false }) {
    if (!latest(scope, observed)) return;
    observations.set(scope, observed.sequence);
    const older = value => (observations.get(value.scope) || 0) <= observed.sequence;
    const removed = [facts.remove('billing', everywhere ? older : scope), facts.remove('key', KEY), tested && facts.remove('limit', KEY),
      accepted && facts.remove('key', TESTED)];
    if (removed.some(Boolean)) notify();
  }
  // The connection test's key answer: a refused key is held for new sessions until the key changes, and an accepted one
  // ends every key refusal.
  function keyChecked({ status, observed }) {
    if (!current(observed)) return;
    if (status === 'invalid') facts.set('key', TESTED, 'invalid_key', { source: 'connection-test' });
    else if (status !== 'ok' || ![facts.remove('key', KEY), facts.remove('key', TESTED)].some(Boolean)) return;
    notify();
  }
  // A turn the provider accepted also ends its card's rate limit.
  const KINDS = { failure: failed, identity: identified, key: keyChecked,
    success: value => { if (value.card) release(value.card); identified({ ...value, tested: true, accepted: true }); } };
  const observe = observation => KINDS[observation.kind](observation);

  // CLI checks are numbered as they start. One that comes back after a later one was seen is stale: it changes nothing,
  // and its caller gets the newer result instead. Another Claude Code than before starts everything afresh.
  let cliIssued = 0, cliSeen = 0, cliLatest, cliSeenAt = 0, cliIdentity = null;
  function observeCli(value, ticket = ++cliIssued) {
    if (ticket < cliSeen) return false;
    cliSeen = ticket; cliLatest = value; cliSeenAt = now();
    const identity = JSON.stringify([value.status, value.version || null, value.file || null]);
    if (cliIdentity !== null && cliIdentity !== identity) reset();
    cliIdentity = identity;
    return true;
  }
  async function trackCli(check) {
    const ticket = ++cliIssued, value = await check;
    return observeCli(value, ticket) ? value : cliLatest;
  }
  const checkCli = () => facts.once('cli', () => trackCli(inspectCli()));
  // Look again before deciding when the answer may be stale: a held billing refusal may be about a Claude Code that has
  // since changed, and a Claude Code the last check could not run may have been installed or fixed since it was checked.
  const cliStale = () => cliLatest && cliLatest.status !== 'ok' && now() - cliSeenAt >= CLI_RECHECK;
  const refresh = () => facts.has('billing') || cliStale() ? checkCli().then(() => {}, () => {}) : Promise.resolve();

  function claimTrial() {
    const limit = facts.get('limit', KEY);
    if (!limit || limit.retryAt > now()) return null;
    limit.retryAt = now() + TRIAL;
    return limit.trial = randomUUID();
  }

  // `running`: the facts for a session already on its way. The connection test's key refusal is for new sessions only
  // (it never stopped a running one), and a billing refusal holds it while Claude Code itself rewrites settings files
  // (/model, "always allow"): N1 is about the next new session.
  function held(scope = '', card = null, { running = false } = {}) {
    const key = keySaved() ? facts.get('key', KEY) || !running && facts.get('key', TESTED) : fact('key', 'no_key', { source: 'credentials', observedAt: now() });
    return [key, cliFact(cliLatest, now()), facts.get('billing', scope, { anyFingerprint: running }), facts.get('limit', KEY),
      card && facts.get('rate', card)].filter(Boolean);
  }

  return {
    facts: held,
    generation: () => ({ generation, sequence: ++sequence }),
    observe, observeCli, trackCli, checkCli, refresh, claimTrial, reset,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    close() { [...holds.keys()].forEach(release); },
  };
}

module.exports = { createResolver, cliFact, testFacts, overlay, settingsChain };
