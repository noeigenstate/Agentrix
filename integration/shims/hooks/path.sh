# Agentrix hook: runs the user's own start-up hook named in __agx_user, then puts the shim folder (AGENTRIX_SHIMS, as this
# shell names it) first on PATH again. bash-env.sh, claude-env.sh and the zsh phases source it after the user's start-up
# files, which may have put a real codex or claude first (Ubuntu's ~/.local/bin, path_helper, nvm, Homebrew). A "user"
# file that is an Agentrix hook by where it is (a shim folder, or a session's copy of claude-env.sh) is never sourced, so
# hooks cannot chain into themselves; electron/shared/agentrix-shims.cjs shimHook is the same rule.
# Plain sh, bash and zsh read it alike.
if [ -n "${__agx_user-}" ] && [ -r "$__agx_user" ]; then
  case $__agx_user in */*) __agx_dir=${__agx_user%/*} ;; *) __agx_dir=. ;; esac
  __agx_hook=
  if [ -e "$__agx_dir/.agentrix-shims" ] || [ -e "$__agx_dir/../.agentrix-shims" ] || [ -e "$__agx_dir/../../.agentrix-shims" ]; then __agx_hook=1
  else
    # A session's private copy of the Claude Code hook: named so beside its bootstrap, and written from this folder's.
    case $__agx_user in *-claude-env.sh)
      __agx_first=
      IFS= read -r __agx_first < "$__agx_user" || :
      case $__agx_first in '# Agentrix hook'*) __agx_hook=1 ;; esac ;;
    esac
  fi
  [ -n "$__agx_hook" ] || . "$__agx_user"
fi
unset __agx_user __agx_first __agx_dir __agx_hook
case ${AGENTRIX_SHIMS-} in
  '') ;;
  *) case $PATH in "$AGENTRIX_SHIMS" | "$AGENTRIX_SHIMS":*) ;; *) PATH=$AGENTRIX_SHIMS${PATH:+:$PATH}; export PATH ;; esac ;;
esac
