// The real Claude Code terminal UI in a PTY, offline: a throwaway profile (harness in claude-real.cjs), the CLI's own onboarding
// answered in advance, and claude-terminal-peer.cjs owning the PTY so a ConPTY kill that stalls cannot stall the test run.
const fs = require('node:fs');
const path = require('node:path');
const { fork } = require('node:child_process');
const { once } = require('node:events');

// Starts the CLI named by AGENTRIX_REAL_CLAUDE in f.cwd with f.env (copied when called). Resolves once the peer has the CLI
// running. onChunk gets every piece of terminal output as it arrives, which is how a test sees the order of the screen
// against the order of other events; capture keeps the last 64 KB for output().
async function terminal(t, f, args = [], capture = false, onChunk = null, trustedFolders = []) {
  const env = { ...f.env }; delete env.CI;
  const projects = Object.fromEntries([f.cwd, ...trustedFolders].map(folder => [folder.replaceAll('\\', '/'),
    { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true }]));
  fs.writeFileSync(path.join(env.CLAUDE_CONFIG_DIR, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true,
    lastOnboardingVersion: '2.1.318', theme: 'dark', customApiKeyResponses: { approved: [env.ANTHROPIC_API_KEY.slice(-20)], rejected: [] },
    projects }));
  const child = fork(path.join(__dirname, 'claude-terminal-peer.cjs'), [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  child.stderr.resume(); const ended = once(child, 'exit');
  f.cleanup(async () => {
    if (child.exitCode === null && child.signalCode === null && child.connected) child.send({ type: 'stop' });
    // ConPTY's synchronous kill can stall its owned peer. Bound cleanup rather
    // than leaving a completed CLI test waiting forever in its after hook.
    const timer = setTimeout(() => child.kill('SIGKILL'), 4000);
    try { await ended; } finally { clearTimeout(timer); }
  });
  let output = '';
  child.on('message', message => { if (message.type === 'data') { output = (output + message.data).slice(-65536); onChunk?.(message.data); } });
  child.send({ type: 'start', cli: process.env.AGENTRIX_REAL_CLAUDE, cwd: f.cwd, env, args, capture: capture || Boolean(onChunk) });
  await new Promise(resolve => { const ready = message => { if (message.type === 'ready') { child.off('message', ready); resolve(); } }; child.on('message', ready); });
  return Object.assign((text, paste = false) => child.send({ type: 'input', text, paste }), { output: () => output, key: text => child.send({ type: 'key', text }) });
}

module.exports = { terminal };
