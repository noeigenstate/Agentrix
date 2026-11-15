const fs = require('node:fs');

// The file a terminal's shell integration and the dispatch helper read to reach main: the session's key, the event
// pipe and the control channel, and for a terminal also its hook channel and settings (hook-channel.cjs) and the paths
// its command hooks run. Only its owner can read it.
function writeBootstrap({ file, eventServer, projectId, projectPath, sessionKey, controlAddress, controlCapability, ...terminal }) {
  const pipeName = process.platform === 'win32' ? eventServer.name : eventServer.address;
  fs.writeFileSync(file, JSON.stringify({ projectId, projectPath, sessionKey, controlAddress, controlCapability, pipeName, ...terminal }), { mode: 0o600 });
}

module.exports = { writeBootstrap };
