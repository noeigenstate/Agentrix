const fs = require('node:fs');
const path = require('node:path');

// The file a terminal's shell integration and the dispatch helper read to reach main: the session's key, the event
// pipe and the control channel, and for a terminal also its hook channel and settings (hook-channel.cjs) and the paths
// its command hooks run. Only its owner can read it.
function writeBootstrap({ file, eventServer, projectId, projectPath, sessionKey, controlAddress, controlCapability, ...terminal }) {
  const pipeName = process.platform === 'win32' ? eventServer.name : eventServer.address;
  const packaged = process.resourcesPath && path.join(process.resourcesPath, 'integration');
  const integration = terminal.claudeHookPath ? path.dirname(terminal.claudeHookPath)
    : packaged && fs.existsSync(path.join(packaged, 'shims', '.agentrix-shims')) ? packaged : path.resolve(__dirname, '../../../integration');
  fs.writeFileSync(file, JSON.stringify({ projectId, projectPath, sessionKey, controlAddress, controlCapability, pipeName,
    shims: path.join(integration, 'shims'), nodePath: process.execPath, ...terminal }), { mode: 0o600 });
}

module.exports = { writeBootstrap };
