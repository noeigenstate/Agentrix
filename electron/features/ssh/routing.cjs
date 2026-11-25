const connecting = new WeakMap();
const updating = new WeakMap();

// Keep only the latest save for a connecting host. Its readiness never holds the save receipt.
function refreshRemoteRouting(remote, lead, routing, { bound, changed, failed }) {
  if (remote.closed) return null;
  const update = async () => {
    if (remote.closed || !bound()) return;
    try {
      await remote.request('claude-lead', { claudeLead: lead }, { timeout: 3000 });
      if (remote.closed || !bound()) return;
      const previous = remote.appliedRouting?.conductor;
      remote.appliedRouting = { effective: routing?.effective ?? {}, roles: routing?.roles ?? [],
        ...(typeof lead.conductor === 'boolean' && { conductor: lead.conductor }) };
      changed(typeof previous === 'boolean' && previous !== lead.conductor);
    } catch {
      if (bound()) failed();
    }
  };
  const enqueue = () => {
    const next = (updating.get(remote) || Promise.resolve()).catch(() => {}).then(update);
    updating.set(remote, next);
    const release = () => { if (updating.get(remote) === next) updating.delete(remote); };
    void next.then(release, release);
    return next;
  };
  if (remote.connected) {
    connecting.delete(remote);
    return enqueue();
  }
  if (!connecting.has(remote)) {
    const flush = action => {
      const queued = connecting.get(remote);
      connecting.delete(remote);
      return queued?.[action]();
    };
    void remote.ready.then(() => flush('update'), () => flush('failed'));
  }
  connecting.set(remote, { update: enqueue, failed: () => { if (bound()) failed(); } });
  return null;
}

module.exports = { refreshRemoteRouting };
