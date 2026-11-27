// Usage requests from the visible pane are the focus signal. Subscriptions live
// only for that read: the existing account service owns cache, interval and backoff.
const { retainAccount } = require('../agents/agent-usage.cjs');
const { createClaudeReadSchedule, POLL_INTERVAL } = require('../agents/claude-account-usage.cjs');
function createProjectAccounts({ codex, readClaude, readClaudeUsage, now = Date.now,
  claudeSchedule = createClaudeReadSchedule(now), timers = globalThis, readTimeoutMs = 30000 }) {
  let current, generation = 0, serial = Promise.resolve(), subscription, cancel, claudeCache;
  // The Codex scope each project's reads retain, until the project is removed or reads another.
  const scopes = new Map();
  const empty = kind => ({ connection: { kind, active: false, source: null, observedAt: null } });
  const release = id => {
    const key = scopes.get(id);
    scopes.delete(id);
    if (key && ![...scopes.values()].includes(key)) codex.releaseCache(key);
  };

  async function claudeSnapshot(env) {
    const home = JSON.stringify(Object.entries(env).filter(([name]) => /^(?:CLAUDE_(?:SECURESTORAGE_)?CONFIG_DIR|HOME|USERPROFILE)$/i.test(name)).sort());
    if (claudeCache?.home === home && now() < claudeCache.nextReadAt) return claudeCache;
    const previous = claudeCache?.home === home ? claudeCache : null;
    const value = retainAccount(previous?.value, await readClaude(env));
    const sameAccount = value?.connection?.kind === previous?.value?.connection?.kind && value?.connection?.scopeId === previous?.value?.connection?.scopeId;
    return claudeCache = { ...previous, home, value, nextReadAt: now() + codex.interval, direct: sameAccount ? previous?.direct : null };
  }

  async function refreshClaude(cache, cwd, env, signal) {
    if (!readClaudeUsage) return cache.value;
    const useDirect = () => cache.checkedDirect ? retainAccount(cache.value, cache.direct) : cache.value;
    if (cache.checkedCwd === cwd && now() < Math.max(cache.checkedUntil, claudeSchedule.nextAt)) return useDirect();
    let finishRequest;
    const result = await Promise.resolve().then(() => readClaudeUsage({ cwd, env, signal, beforeRequest: () => {
      if (signal.aborted) return false;
      return !!(finishRequest = claudeSchedule.begin());
    } })).catch(() => null);
    finishRequest?.(result ?? { state: 'error', reason: 'query' });
    if (signal.aborted) return cache.value;
    cache.checkedCwd = cwd;
    cache.checkedUntil = finishRequest || result?.reason === 'throttled'
      ? claudeSchedule.nextAt : now() + POLL_INTERVAL;
    cache.checkedDirect = result?.state === 'ready' || result?.reason === 'throttled' || (result?.state === 'error' && !!finishRequest);
    if (result?.state === 'ready') cache.direct = { ...result.account, connection: {
      ...cache.value?.connection, kind: 'subscription', active: false, source: result.account.source, observedAt: result.account.at,
    } };
    return useDirect();
  }

  async function readCodex(project, options, previous) {
    let deadline, watched;
    const expired = new Promise(resolve => { deadline = timers.setTimeout(resolve, readTimeoutMs); });
    try {
      const result = new Promise(resolve => {
        cancel = resolve;
        watched = subscription = codex.watch(options, value => {
          if (value.resetQuery?.state !== 'loading') resolve(value);
        });
        if (watched.key && scopes.get(project.id) !== watched.key) { release(project.id); scopes.set(project.id, watched.key); }
      });
      const account = await Promise.race([result, expired]);
      if (subscription === watched) { watched?.dispose(); subscription = null; }
      await Promise.race([codex.entries.get(watched?.key)?.readPromise, expired]);
      return account ?? previous;
    } finally {
      timers.clearTimeout(deadline);
      if (subscription === watched) { watched?.dispose(); subscription = null; }
      cancel = null;
    }
  }
  return {
    snapshot(id) { return current?.id === id ? current.value : null; },
    close(id) {
      if (id) release(id);
      if (id && current?.id !== id) return;
      ++generation; current?.abort.abort(); subscription?.dispose(); cancel?.(); subscription = null; current = null;
    },
    read(project, options) {
      if (!project || project.kind === 'ssh') return Promise.resolve(null);
      if (current?.id !== project.id) {
        ++generation; current?.abort.abort(); subscription?.dispose(); cancel?.();
        current = { id: project.id, abort: new AbortController() };
      }
      const token = generation;
      const task = serial.catch(() => {}).then(async () => {
        if (token !== generation) return null;
        const { cli, env, onCached } = options;
        const cwd = project.restore?.cwd || project.path;
        const cache = cli.claude.status === 'ok' ? await claudeSnapshot(env) : null;
        if (token !== generation) return null;
        const codexOptions = { cwd, env, accountLaunch: 'project-open-v1', retainCache: true };
        const claude = (cache?.checkedCwd === cwd && cache.checkedDirect ? retainAccount(cache.value, cache.direct) : cache?.value) ?? empty('none');
        const account = (cli.codex.status === 'ok' ? codex.peek?.(codexOptions) : null) ?? empty('none');
        current.value = { claude, codex: account };
        onCached?.();
        const publish = (agent, value) => {
          if (token !== generation) return;
          current.value = { ...current.value, [agent]: value };
          onCached?.();
        };
        await Promise.all([
          cache && refreshClaude(cache, cwd, env, current.abort.signal).then(value => publish('claude', value)),
          cli.codex.status === 'ok' && readCodex(project, codexOptions, account).then(value => publish('codex', value)),
        ]);
        return token === generation ? current.value : null;
      });
      serial = task; return task;
    },
  };
}
module.exports = { createProjectAccounts };
