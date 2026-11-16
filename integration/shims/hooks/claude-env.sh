# Agentrix: Claude Code runs this text before each Bash command, after the shell snapshot that restores the PATH the user's
# start-up files built (CLAUDE_ENV_FILE, set by intercept.cjs withShims). The user's own CLAUDE_ENV_FILE runs first.
if [ -n "${AGENTRIX_SHIM_USER_CLAUDE_ENV_FILE-}" ]; then . "$AGENTRIX_SHIM_USER_CLAUDE_ENV_FILE"; fi
if [ -r "${AGENTRIX_SHIMS-}/hooks/path.sh" ]; then . "$AGENTRIX_SHIMS/hooks/path.sh"; fi
