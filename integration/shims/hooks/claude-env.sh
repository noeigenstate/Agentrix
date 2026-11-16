# Agentrix hook: Claude Code runs this text before each Bash command, after the shell snapshot that restores the PATH the
# user's start-up files built (CLAUDE_ENV_FILE, set by intercept.cjs withShims to the session's own copy of this file).
# The user's own CLAUDE_ENV_FILE runs first.
__agx_user=${AGENTRIX_SHIM_USER_CLAUDE_ENV_FILE-}
if [ -r "${AGENTRIX_SHIMS-}/hooks/path.sh" ]; then . "$AGENTRIX_SHIMS/hooks/path.sh"; fi
unset __agx_user
