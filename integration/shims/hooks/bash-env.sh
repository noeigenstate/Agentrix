# Agentrix: bash inside a planner reads this (BASH_ENV, set by intercept.cjs withShims) after its login files, so it also
# runs for Codex's bash -lc. The user's own BASH_ENV runs first.
if [ -n "${AGENTRIX_SHIM_USER_BASH_ENV-}" ]; then . "$AGENTRIX_SHIM_USER_BASH_ENV"; fi
if [ -r "${AGENTRIX_SHIMS-}/hooks/path.sh" ]; then . "$AGENTRIX_SHIMS/hooks/path.sh"; fi
