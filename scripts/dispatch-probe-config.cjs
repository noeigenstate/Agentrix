// Claude Code's installed config uses the trimmed API key's last 20 characters, never the full key.
function claudeProbeConfig(project, key) {
  return { hasCompletedOnboarding: true, theme: 'dark', bypassPermissionsModeAccepted: true,
    customApiKeyResponses: { approved: [key.trim().slice(-20)], rejected: [] },
    projects: Object.fromEntries([].concat(project).map(folder => [folder.replace(/\\/g, '/'), { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true }])) };
}

module.exports = { claudeProbeConfig };
