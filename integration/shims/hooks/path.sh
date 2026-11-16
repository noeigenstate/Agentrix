# Agentrix hook: runs the user's own start-up hook named in __agx_user, then puts the shim folder (AGENTRIX_SHIMS, as this
# shell names it) first on PATH again. bash-env.sh, claude-env.sh and the zsh phases source it after the user's start-up
# files, which may have put a real codex or claude first (Ubuntu's ~/.local/bin, path_helper, nvm, Homebrew). A "user"
# file that is an Agentrix hook (this file, or another Agentrix's) is never sourced, so hooks cannot chain into themselves.
# Plain sh, bash and zsh read it alike.
if [ -n "${__agx_user-}" ] && [ -r "$__agx_user" ]; then
  __agx_first=
  IFS= read -r __agx_first < "$__agx_user" || :
  case $__agx_first in '# Agentrix hook'*) ;; *) . "$__agx_user" ;; esac
fi
unset __agx_user __agx_first
case ${AGENTRIX_SHIMS-} in
  '') ;;
  *) case $PATH in "$AGENTRIX_SHIMS" | "$AGENTRIX_SHIMS":*) ;; *) PATH=$AGENTRIX_SHIMS${PATH:+:$PATH}; export PATH ;; esac ;;
esac
