# Agentrix hook: an owner's own ! command in a native Codex session runs this first (electron/shared/agentrix-shims.cjs
# ownerShellCommand), in the shell Codex started with the planner's env: no shim folder on PATH, the user's own start-up
# hooks back, and no depth, run identity or shim variables, so a typed claude or codex is the real CLI. The rules of
# withoutShims; plain sh, bash and zsh read it alike.
__agx_rest=$PATH: __agx_path=
while [ -n "$__agx_rest" ]; do
  __agx_dir=${__agx_rest%%:*}
  __agx_rest=${__agx_rest#*:}
  if [ -z "$__agx_dir" ] || [ ! -e "$__agx_dir/.agentrix-shims" ]; then __agx_path=${__agx_path:+$__agx_path:}$__agx_dir; fi
done
PATH=$__agx_path; export PATH
if [ -n "${AGENTRIX_SHIMS+set}" ]; then
  if [ -n "${AGENTRIX_SHIM_USER_BASH_ENV-}" ]; then BASH_ENV=$AGENTRIX_SHIM_USER_BASH_ENV; export BASH_ENV; else unset BASH_ENV; fi
  if [ -n "${AGENTRIX_SHIM_USER_CLAUDE_ENV_FILE-}" ]; then CLAUDE_ENV_FILE=$AGENTRIX_SHIM_USER_CLAUDE_ENV_FILE; export CLAUDE_ENV_FILE; else unset CLAUDE_ENV_FILE; fi
  if [ -n "${AGENTRIX_SHIM_USER_ZDOTDIR-}" ]; then ZDOTDIR=$AGENTRIX_SHIM_USER_ZDOTDIR; export ZDOTDIR; else unset ZDOTDIR; fi
fi
unset AGENTRIX_SHIMS AGENTRIX_SHIM_USER_BASH_ENV AGENTRIX_SHIM_USER_CLAUDE_ENV_FILE AGENTRIX_SHIM_USER_ZDOTDIR AGENTRIX_SHIM_NODE \
  AGENTRIX_DISPATCH_DEPTH AGENTRIX_RUN_ID AGENTRIX_RUN_PROOF __agx_rest __agx_path __agx_dir
