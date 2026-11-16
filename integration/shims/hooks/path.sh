# Agentrix: puts the shim folder (AGENTRIX_SHIMS, as this shell names it) first on PATH again. bash-env.sh, claude-env.sh
# and the zsh phases source it after the user's own start-up files, which may have put a real codex or claude first
# (Ubuntu's ~/.local/bin, path_helper, nvm, Homebrew). Plain sh, bash and zsh read it alike.
case ${AGENTRIX_SHIMS-} in
  '') ;;
  *) case $PATH in "$AGENTRIX_SHIMS" | "$AGENTRIX_SHIMS":*) ;; *) PATH=$AGENTRIX_SHIMS${PATH:+:$PATH}; export PATH ;; esac ;;
esac
