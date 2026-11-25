const fs = require('node:fs/promises');
const path = require('node:path');

// Claude Code's installed config uses the trimmed API key's last 20 characters, never the full key.
function claudeProbeConfig(project, key) {
  return { hasCompletedOnboarding: true, theme: 'dark', bypassPermissionsModeAccepted: true,
    customApiKeyResponses: { approved: [key.trim().slice(-20)], rejected: [] },
    projects: Object.fromEntries([].concat(project).map(folder => [folder.replace(/\\/g, '/'), { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true }])) };
}

function writeClaudeProbeConfig(folder, projects, key) {
  return fs.writeFile(path.join(folder, '.claude.json'), JSON.stringify(claudeProbeConfig(projects.map(project => project.path), key)));
}

module.exports = { claudeProbeConfig, writeClaudeProbeConfig };
