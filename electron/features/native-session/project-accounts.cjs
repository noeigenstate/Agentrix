// Usage requests from the visible pane are the focus signal. Subscriptions live
// only for that read: the existing account service owns cache, interval and backoff.
function createProjectAccounts({ codex, readClaude }) {
  let current, generation = 0, serial = Promise.resolve(), subscription, cancel, claudeCache;
  const empty = kind => ({ connection: { kind, active: false, source: null, observedAt: null } });
  return {
    snapshot(id) { return current?.id === id ? current.value : null; },
    close(id) {
      if (id && current?.id !== id) return;
      ++generation; subscription?.dispose(); cancel?.(); subscription = null; current = null;
    },
    read(project, options) {
      if (!project || project.kind === 'ssh') return Promise.resolve(null);
      if (current?.id !== project.id) { ++generation; subscription?.dispose(); cancel?.(); current = { id: project.id }; }
      const token = generation;
      const task = serial.catch(() => {}).then(async () => {
        if (token !== generation) return null;
        const home = JSON.stringify(Object.entries(options.env).filter(([name]) => /^(?:CLAUDE_CONFIG_DIR|HOME|USERPROFILE)$/i.test(name)).sort());
        if (options.cli.claude.status === 'ok' && (claudeCache?.home !== home || Date.now() >= claudeCache.nextReadAt)) {
          claudeCache = { home, value: await readClaude(options.env), nextReadAt: Date.now() + codex.interval };
        }
        const claude = options.cli.claude.status === 'ok' ? claudeCache.value : empty('none');
        if (token !== generation) return null;
        let account = empty('none');
        if (options.cli.codex.status === 'ok') {
          account = await new Promise(resolve => {
            cancel = () => resolve(null);
            subscription = codex.watch({ cwd: project.restore?.cwd || project.path, env: options.env,
              accountLaunch: 'project-open-v1', retainCache: true }, value => {
              if (value.resetQuery?.state !== 'loading') resolve(value);
            });
          });
          const pending = codex.entries.get(subscription?.key)?.readPromise;
          subscription?.dispose(); subscription = null; cancel = null;
          await pending;
        }
        if (token !== generation) return null;
        current.value = { claude, codex: account };
        return current.value;
      });
      serial = task; return task;
    },
  };
}
module.exports = { createProjectAccounts };
