const { withoutShims } = require('./shared/agentrix-shims.cjs');
const { claudeBackgroundEnvironment } = require('./shared/claude-background.cjs');

// allowBackgroundTasks: the Settings switch (shared/claude-background.cjs); off, Claude Code runs without background tasks.
function createTerminalEnvironment(source, bootstrapFile, { allowBackgroundTasks = false } = {}) {
  // Agentrix started inside a planner (a worker's GUI check, beta beside stable): its terminals start as the owner's.
  const env = withoutShims(source);
  // A terminal window can be launched from a non-interactive host (including
  // Codex tools or CI). Its output policy must not disable colors in our PTYs.
  for (const key of Object.keys(env)) {
    const name = key.toUpperCase();
    if (['NO_COLOR', 'NODE_DISABLE_COLORS', 'TERM', 'COLORTERM', 'CLICOLOR', 'TERM_PROGRAM',
      'AGENTRIX_BOOTSTRAP', 'ELECTRON_RUN_AS_NODE', 'AGENTRIX_DATA_DIR', 'AGENTRIX_DEV_URL', 'CLAUDE_CODE_ENTRYPOINT',
      'AGENTRIX_CLAUDE_EXECUTABLE', 'AGENTRIX_CODEX_EXECUTABLE'].includes(name)
      || (name === 'FORCE_COLOR' && ['0', 'false', ''].includes(String(env[key]).toLowerCase()))) {
      delete env[key];
    }
  }
  return {
    ...claudeBackgroundEnvironment(env, allowBackgroundTasks),
    AGENTRIX_BOOTSTRAP: bootstrapFile,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    TERM_PROGRAM: 'agentrix',
    CLICOLOR: '1',
  };
}

module.exports = { createTerminalEnvironment };
