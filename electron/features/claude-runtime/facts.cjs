// Facts about the Claude path (C-11). A fact is what was seen (`reason`, a C-1 Reason whose code is `claude.<name>`),
// for which scope, under which fingerprint, when, and until when. A fact read past its expiry is gone, and one whose
// fingerprint no longer matches what it was seen under is not current (I2): nobody has to remember to forget it.
const { reason } = require('../../shared/reason.cjs');

// One fact, as the resolver stores it and decide() reads it. `name` is what the fact is about (key, cli, billing,
// limit, rate); `message` is the sentence the windows were told for it before reasons were codes, kept until they read
// codes; `trial` is a ten-minute retry claimed against a limit.
function fact(name, code, { scope = null, fingerprint = null, source, observedAt = Date.now(), expiresAt = null, message, trial, ...held } = {}) {
  return { name, reason: reason(`claude.${code}`, { source, observedAt }), scope, fingerprint, observedAt, expiresAt,
    ...(message ? { message } : {}), ...(trial !== undefined ? { trial } : {}), ...held };
}

// The facts held for each (name, scope). `fingerprints[name](fact)` is a fact's fingerprint now; it is taken when the
// fact is set and compared when it is read.
function createFacts({ now = Date.now, fingerprints = {} } = {}) {
  const held = new Map(), running = new Map();
  const id = (name, scope) => `${name}\u0000${scope}`;
  const fingerprintOf = value => fingerprints[value.name]?.(value) ?? null;
  // The fact held for (name, scope), or null. A reader with `anyFingerprint` (a session already running under what was
  // seen) still sees a fact whose fingerprint has changed; any other reader sees only a current one.
  function get(name, scope, { anyFingerprint = false } = {}) {
    const value = held.get(id(name, scope));
    if (!value) return null;
    if (value.expiresAt !== null && value.expiresAt <= now()) { held.delete(id(name, scope)); return null; }
    return anyFingerprint || fingerprintOf(value) === value.fingerprint ? value : null;
  }
  // Fields as fact() takes them, with observedAt from this clock and the fingerprint taken now.
  function set(name, scope, code, fields) {
    const value = fact(name, code, { ...fields, scope, observedAt: now() });
    value.fingerprint = fingerprintOf(value);
    held.set(id(name, scope), value); return value;
  }
  // Whether anything was removed: one scope's fact, or the fact of every scope that `which(fact)` accepts.
  function remove(name, which) {
    if (typeof which !== 'function') return held.delete(id(name, which));
    const keys = [...held.values()].filter(value => value.name === name && which(value)).map(value => id(name, value.scope));
    keys.forEach(key => held.delete(key)); return keys.length > 0;
  }
  const has = (name, test = () => true) => [...held.values()].some(value => value.name === name && test(value) && get(name, value.scope));
  // Checks of the same thing run once: a caller that asks while one runs gets that one's answer.
  function once(key, task) {
    if (!running.has(key)) running.set(key, Promise.resolve().then(task).finally(() => running.delete(key)));
    return running.get(key);
  }
  return { get, set, remove, has, once, clear: () => held.clear() };
}

module.exports = { createFacts, fact };
