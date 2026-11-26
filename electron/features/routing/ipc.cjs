function registerRoutingIpc({ handle, routing, claudeFastRefusal }) {
  async function afterRefresh(result) {
    if (result.ok) await routing.launchRefresh;
    return result;
  }
  function withFastRefusal(info) {
    const reason = info?.conductor && !info.routing?.remote && claudeFastRefusal?.();
    return reason ? { ...info, claudeFastRefusal: reason } : info;
  }
  handle('routing:seats', (projectId, terminalId) => withFastRefusal(routing.seatsInfo(projectId, terminalId, true)));
  handle('routing:refresh', async (projectId, terminalId, reason = 'manual') =>
    withFastRefusal(await routing.refreshSeats(projectId, terminalId, reason === 'dialog' ? 'dialog' : 'manual')));
  handle('routing:save', (scope, projectId, config, base) => afterRefresh(routing.setRouting(scope, projectId, config, base)));
  handle('routing:resolve', (projectId, action, digest) => afterRefresh(routing.resolveRouting(projectId, action, digest)));
}

module.exports = { registerRoutingIpc };
