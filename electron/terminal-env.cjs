function createTerminalEnvironment(source, bootstrapFile) {
  const env = { ...source };
  // A terminal window can be launched from a non-interactive host (including
  // Codex tools or CI). Its output policy must not disable colors in our PTYs.
  for (const key of Object.keys(env)) {
    const name = key.toUpperCase();
    if (['NO_COLOR', 'NODE_DISABLE_COLORS', 'TERM', 'COLORTERM', 'CLICOLOR', 'TERM_PROGRAM',
      'AGENTRIX_BOOTSTRAP', 'ELECTRON_RUN_AS_NODE', 'AGENTRIX_DATA_DIR', 'AGENTRIX_DEV_URL', 'CLAUDE_CODE_ENTRYPOINT'].includes(name)
      || (name === 'FORCE_COLOR' && ['0', 'false', ''].includes(String(env[key]).toLowerCase()))) {
      delete env[key];
    }
  }
  return {
    ...env,
    AGENTRIX_BOOTSTRAP: bootstrapFile,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    TERM_PROGRAM: 'agentrix',
    CLICOLOR: '1',
  };
}

module.exports = { createTerminalEnvironment };
