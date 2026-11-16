const fs = require('node:fs');
const path = require('node:path');

// The file a terminal's shell integration and the dispatch helper read to reach main: the session's key, the event
// pipe and the control channel, and for a terminal also its hook channel and settings (hook-channel.cjs) and the paths
// its command hooks run. Only its owner can read it.
// Beside it, the session's own copy of the Claude Code start-up hook (claudeEnvFile, the planner's CLAUDE_ENV_FILE): Claude
// Code lets SessionStart hooks append to that file, so it is never the installed one.
const claudeEnvFile = file => file.replace(/\.json$/i, '') + '-claude-env.sh';

function writeBootstrap({ file, eventServer, projectId, projectPath, sessionKey, controlAddress, controlCapability, ...terminal }) {
  const pipeName = process.platform === 'win32' ? eventServer.name : eventServer.address;
  const packaged = process.resourcesPath && path.join(process.resourcesPath, 'integration');
  const integration = terminal.claudeHookPath ? path.dirname(terminal.claudeHookPath)
    : packaged && fs.existsSync(path.join(packaged, 'shims', '.agentrix-shims')) ? packaged : path.resolve(__dirname, '../../../integration');
  const shims = path.join(integration, 'shims'), hook = path.join(shims, 'hooks/claude-env.sh');
  const copy = fs.existsSync(hook) ? claudeEnvFile(file) : undefined;
  if (copy) fs.writeFileSync(copy, fs.readFileSync(hook), { mode: 0o600 });
  fs.writeFileSync(file, JSON.stringify({ projectId, projectPath, sessionKey, controlAddress, controlCapability, pipeName,
    shims, nodePath: process.execPath, claudeEnvFile: copy, ...terminal }), { mode: 0o600 });
}

// Removes a session's bootstrap file and the files written with it.
function removeBootstrap(file) {
  for (const name of [file, claudeEnvFile(file)]) fs.rmSync(name, { force: true });
}

module.exports = { writeBootstrap, removeBootstrap };
