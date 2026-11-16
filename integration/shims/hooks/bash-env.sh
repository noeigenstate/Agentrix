# Agentrix hook: bash inside a planner reads this (BASH_ENV, set by intercept.cjs withShims) after its login files, so it
# also runs for Codex's bash -lc. The user's own BASH_ENV runs first.
__agx_user=${AGENTRIX_SHIM_USER_BASH_ENV-}
if [ -r "${AGENTRIX_SHIMS-}/hooks/path.sh" ]; then . "$AGENTRIX_SHIMS/hooks/path.sh"; fi
unset __agx_user
