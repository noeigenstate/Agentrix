// CI=true also belongs to local preflight. Only GitHub Actions may touch the host clipboard.
const githubActions = env => env.GITHUB_ACTIONS === 'true';
const reason = 'This test uses the system clipboard and runs only in GitHub Actions (GITHUB_ACTIONS=true).';
module.exports = { githubActions, reason };
