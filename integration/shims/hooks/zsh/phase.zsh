# Agentrix hook: zsh inside a planner reads its start-up files from this folder (ZDOTDIR, set by intercept.cjs withShims),
# so Codex's zsh -lc reads them too. Each stub ($1 names its phase) runs the user's own file of that name from their
# folder through path.sh, which then puts the shims first on PATH again; .zlogin, the last a login shell reads, decides.
__agx_stub=$ZDOTDIR
ZDOTDIR=${AGENTRIX_SHIM_USER_ZDOTDIR:-$HOME}
__agx_user=$ZDOTDIR/.$1
[[ -r ${AGENTRIX_SHIMS-}/hooks/path.sh ]] && builtin source "$AGENTRIX_SHIMS/hooks/path.sh"
unset __agx_user
# The user's .zshenv may name another folder for the files after it; another Agentrix's stub folder is never theirs.
[[ $ZDOTDIR == "${AGENTRIX_SHIM_USER_ZDOTDIR:-$HOME}" || -r $ZDOTDIR/phase.zsh ]] || export AGENTRIX_SHIM_USER_ZDOTDIR=$ZDOTDIR
# /etc/zshrc chose the history file while ZDOTDIR still named this folder.
[[ $1 == zshrc && ${HISTFILE-} == "$__agx_stub"/* ]] && HISTFILE=$ZDOTDIR/.zsh_history
ZDOTDIR=$__agx_stub
unset __agx_stub
return 0
