# Agentrix: zsh inside a planner reads its start-up files from this folder (ZDOTDIR, set by intercept.cjs withShims), so
# Codex's zsh -lc reads them too. Each stub ($1 names its phase) sources the user's own file of that name from their folder,
# then puts the shims first on PATH again; .zlogin, the last a login shell reads, decides.
__agx_stub=$ZDOTDIR
ZDOTDIR=${AGENTRIX_SHIM_USER_ZDOTDIR:-$HOME}
[[ -r $ZDOTDIR/.$1 ]] && builtin source "$ZDOTDIR/.$1"
# The user's .zshenv may name another folder for the files after it.
[[ $ZDOTDIR == "${AGENTRIX_SHIM_USER_ZDOTDIR:-$HOME}" ]] || export AGENTRIX_SHIM_USER_ZDOTDIR=$ZDOTDIR
# /etc/zshrc chose the history file while ZDOTDIR still named this folder.
[[ $1 == zshrc && $HISTFILE == "$__agx_stub"/* ]] && HISTFILE=$ZDOTDIR/.zsh_history
ZDOTDIR=$__agx_stub
unset __agx_stub
[[ -r ${AGENTRIX_SHIMS-}/hooks/path.sh ]] && builtin source "$AGENTRIX_SHIMS/hooks/path.sh"
return 0
