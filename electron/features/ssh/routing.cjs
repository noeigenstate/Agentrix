const connecting = new WeakMap();

// Keep only the latest save for a connecting host. Its readiness never holds the save receipt.
function refreshRemoteRouting(remote, lead, routing, { bound, changed, failed }) {
  if (remote.closed) return null;
  const update = async () => {
    if (!bound()) return;
    try {
      await remote.request('claude-lead', { claudeLead: lead }, { timeout: 3000 });
      remote.appliedRouting = { effective: routing?.effective ?? {}, roles: routing?.roles ?? [] };
      if (bound()) changed();
    } catch {
      if (bound()) failed();
    }
  };
  if (remote.connected) {
    connecting.delete(remote);
    return update();
  }
  if (!connecting.has(remote)) {
    const flush = action => {
      const queued = connecting.get(remote);
      connecting.delete(remote);
      return queued?.[action]();
    };
    void remote.ready.then(() => flush('update'), () => flush('failed'));
  }
  connecting.set(remote, { update, failed: () => { if (bound()) failed(); } });
  return null;
}

module.exports = { refreshRemoteRouting };
