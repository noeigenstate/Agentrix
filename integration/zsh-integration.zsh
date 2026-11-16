# Agentrix shell integration for zsh, the local terminal on macOS.
# zsh starts with ZDOTDIR pointing at a folder of stub start-up files (written by electron/zsh-terminal.cjs);
# each stub sources this file with its phase. The user's own .zshenv, .zprofile and .zshrc run first, unchanged,
# and their .zlogin after us. Then this adds what bootstrap.ps1 adds to PowerShell: a report at every prompt and
# the codex and claude wrappers. No user file is modified.
# Phases: zshenv, zprofile (source the user's file and hand back to the next stub), zshrc (source the user's
# file, then set up this terminal).

# The user's own start-up folder: what their .zshenv chose, else what Agentrix was started with, else HOME.
__pg_user_zdotdir=${__pg_user_zdotdir:-${AGENTRIX_USER_ZDOTDIR:-$HOME}}
__pg_zdotdir=${__pg_zdotdir:-$ZDOTDIR}

if [[ $1 == zshenv || $1 == zprofile ]]; then
  ZDOTDIR=$__pg_user_zdotdir
  [[ -r $ZDOTDIR/.$1 ]] && builtin source "$ZDOTDIR/.$1"
  __pg_user_zdotdir=$ZDOTDIR
  ZDOTDIR=$__pg_zdotdir
  return 0
fi

ZDOTDIR=$__pg_user_zdotdir
# /etc/zshrc chose the history file while ZDOTDIR still named Agentrix's folder.
[[ $HISTFILE == $__pg_zdotdir/* ]] && HISTFILE=$ZDOTDIR/.zsh_history
[[ -r $ZDOTDIR/.zshrc ]] && builtin source "$ZDOTDIR/.zshrc"
# zsh reads .zlogin from ZDOTDIR next: the user's own. A shell started from this one starts like any other.
if [[ $__pg_user_zdotdir == $HOME && -z $AGENTRIX_USER_ZDOTDIR ]]; then unset ZDOTDIR; else export ZDOTDIR=$__pg_user_zdotdir; fi

# What Agentrix passed in, kept in this shell only; programs started here do not inherit it.
typeset -g __pg_socket=$AGENTRIX_SOCKET __pg_project=$AGENTRIX_PROJECT_ID __pg_key=$AGENTRIX_SESSION_KEY
typeset -g __pg_node=$AGENTRIX_NODE __pg_helper=$AGENTRIX_EVENT_HELPER __pg_start=$AGENTRIX_START_DIR __pg_note=$AGENTRIX_READING_NOTE
typeset -g __pg_note_file=$AGENTRIX_READING_NOTE_FILE
typeset -g __pg_hook_port=$AGENTRIX_HOOK_PORT __pg_hook_channel=$AGENTRIX_HOOK_CHANNEL __pg_hook_settings=$AGENTRIX_HOOK_SETTINGS __pg_hook_fallback=$AGENTRIX_HOOK_FALLBACK
typeset -gi __pg_sequence=0
unset AGENTRIX_SOCKET AGENTRIX_PROJECT_ID AGENTRIX_SESSION_KEY AGENTRIX_NODE AGENTRIX_EVENT_HELPER AGENTRIX_START_DIR AGENTRIX_USER_ZDOTDIR AGENTRIX_READING_NOTE AGENTRIX_READING_NOTE_FILE AGENTRIX_ACCOUNT_BASELINE
unset AGENTRIX_HOOK_PORT AGENTRIX_HOOK_CHANNEL AGENTRIX_HOOK_SETTINGS AGENTRIX_HOOK_FALLBACK

# Non-interactive tool shells inherit the shims; this shell's owner functions resolve the real CLI below.
typeset -g __pg_shims=$(ELECTRON_RUN_AS_NODE=1 "$__pg_node" -e 'try { process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).shims || ""); } catch {}' "$AGENTRIX_BOOTSTRAP" 2>/dev/null)
if [[ -n $__pg_shims && -d $__pg_shims ]]; then
  export PATH="$__pg_shims:$PATH" AGENTRIX_DISPATCH_DEPTH=0 AGENTRIX_SHIM_NODE="$__pg_node"
  unset AGENTRIX_RUN_ID AGENTRIX_RUN_PROOF
fi

__pg_reading_note() {
  if [[ -n $__pg_note_file && -r $__pg_note_file ]]; then cat -- "$__pg_note_file"; else printf '%s' "$__pg_note"; fi
}
unset __pg_zdotdir __pg_user_zdotdir
zmodload zsh/net/socket 2>/dev/null
autoload -Uz add-zsh-hook

# A JSON string (also a TOML basic string) for $1, in REPLY.
__pg_json() {
  emulate -L zsh
  local value=$1 out= character
  value=${value//\\/\\\\}; value=${value//\"/\\\"}
  value=${value//$'\n'/\\n}; value=${value//$'\r'/\\r}; value=${value//$'\t'/\\t}
  if [[ $value == *[[:cntrl:]]* ]]; then
    for character in ${(s::)value}; do
      if [[ $character == [[:cntrl:]] ]]; then out+=$(printf '\\u%04x' "'$character"); else out+=$character; fi
    done
    value=$out
  fi
  REPLY="\"$value\""
}

# An alias for codex or claude from the user's start-up files (alias claude=~/.claude/local/claude, or
# alias claude='claude --model opus') would bypass the wrappers below. Each wrapper runs the alias's words instead.
typeset -gA __pg_aliases
for __pg_name in codex claude; do
  if (( ${+aliases[$__pg_name]} )); then __pg_aliases[$__pg_name]=$aliases[$__pg_name]; unalias $__pg_name; fi
done
unset __pg_name

# The words that run codex or claude ($1), in reply; fails when neither the alias nor PATH has a program. Without an
# alias, each is the file Agentrix chose for this terminal (AGENTRIX_CODEX_EXECUTABLE, AGENTRIX_CLAUDE_EXECUTABLE) while
# it is there.
__pg_program() {
  emulate -L zsh
  local PATH=$PATH path_entry
  local -a safe_path
  for path_entry in "${path[@]}"; do
    [[ -n $__pg_shims && $path_entry == "$__pg_shims" ]] || safe_path+=("$path_entry")
  done
  PATH=${(j.:.)safe_path}
  local chosen=AGENTRIX_${(U)1}_EXECUTABLE
  reply=()
  (( ${+__pg_aliases[$1]} )) && reply=(${(Q)${(z)__pg_aliases[$1]}})
  if (( ! $#reply )); then
    if [[ -f ${(P)chosen} && -x ${(P)chosen} ]]; then reply=(${(P)chosen}); else reply=($1); fi
  fi
  reply[1]=${reply[1]/#\~/$HOME}
  if [[ $reply[1] == */* ]]; then [[ -x $reply[1] ]]
  else reply[1]=$(whence -p -- $reply[1]) || return 1; [[ -n $reply[1] ]]; fi
}

# type [exit code] [agent]: one line of JSON to Agentrix's socket, the event bootstrap.ps1 sends.
# A subshell writes it, so a closed Agentrix can never stop this shell.
__pg_send() {
  emulate -L zsh
  (( ++__pg_sequence ))
  local project key cwd home command codex=false claude=false
  __pg_json "${4:-}"; command=$REPLY
  __pg_json $__pg_project; project=$REPLY
  __pg_json $__pg_key; key=$REPLY
  __pg_json $PWD; cwd=$REPLY
  __pg_json ${CODEX_HOME:-$HOME/.codex}; home=$REPLY
  __pg_program codex && codex=true
  __pg_program claude && claude=true
  if [[ $1 == codex-started ]]; then
    # Wait for the main process to finish the launch note before the CLI reads it.
    ELECTRON_RUN_AS_NODE=1 "$__pg_node" "$__pg_helper" shell-event "$__pg_socket" "$__pg_project" "$__pg_key" \
      "$1" "$__pg_sequence" "${2:-0}" "${3:-codex}" "$codex" "$claude" "${CODEX_HOME:-$HOME/.codex}" "$PWD" "${4:-}" "${5:-}" "${6-}" </dev/null >/dev/null 2>&1
    return 0
  fi
  local line="{\"projectId\":$project,\"sessionKey\":$key,\"type\":\"$1\",\"sequence\":$__pg_sequence,\"exitCode\":${2:-0},\"agent\":\"${3:-codex}\",\"codexAvailable\":$codex,\"claudeAvailable\":$claude,\"codexHome\":$home,\"cwd\":$cwd,\"command\":$command}"
  ( zsocket $__pg_socket && print -r -u $REPLY -- $line ) 2>/dev/null
  return 0
}

# The first word given to an agent's CLI when it is a subcommand or an option (update, --version): Agentrix tells such a
# run from a conversation by it (electron/features/agents/agent-command.cjs). Anything else is not sent.
__pg_command() {
  emulate -L zsh
  [[ ${1-} =~ '^-{0,2}[A-Za-z][A-Za-z-]{0,23}$' ]] && print -rn -- "$1"
  return 0
}

# Whether $1, the first word given to codex, is one of the CLI's own management runs (codex --help, checked against
# 0.167.0). Those start no conversation and run in this terminal; everything else opens in native mode. bootstrap.ps1,
# bash-integration.bash and remote-worker.py carry the same words.
__pg_codex_terminal() {
  emulate -L zsh
  case ${1-} in --version|-V|--help|-h|help|login|logout|mcp|plugin|app-server|remote-control|app|completion|update|doctor|sandbox|debug|apply|a|archive|delete|unarchive|migrate-rollouts|migrate-nfs-db|exec-server|features) return 0;; esac
  return 1
}

# A management run is the CLI itself, with the user's alias and its exit status. Any other codex requests the
# existing native session path, and no Codex executable runs here.
codex() {
  emulate -L zsh
  local -a reply
  local found=true
  __pg_program codex || { found=false; reply=(codex) }
  local -a arguments=("${reply[@]:1}" "$@")
  if __pg_codex_terminal "$arguments[1]"; then
    if $found; then "${reply[@]}" "$@"; return; fi
    print -P '%F{yellow}Codex CLI was not found in PATH. Install it, then restart this terminal.%f'
    return 127
  fi
  local word REPLY payload='[' separator=
  for word in "${arguments[@]}"; do
    __pg_json "$word"; payload+="$separator$REPLY"; separator=,
  done
  payload+=']'
  __pg_send codex-started 0 codex '' '' "$payload"
  printf '%s\n' '已请求在原生模式打开 Codex。'
  return 0
}

# The proxy variable that would carry this terminal's HTTP hooks to port $1, by hook-channel.cjs's rule over the live
# environment, in REPLY; fails when none would. HTTPS_PROXY or HTTP_PROXY in either case, unless every NO_PROXY and
# no_proxy that is set exempts 127.0.0.1.
__pg_hook_proxy() {
  emulate -L zsh
  local name value entry exempted=false
  REPLY=
  for name in HTTPS_PROXY https_proxy HTTP_PROXY http_proxy; do
    if [[ -n ${(P)name-} ]]; then REPLY=${(U)name}; break; fi
  done
  [[ -n $REPLY ]] || return 1
  for name in NO_PROXY no_proxy; do
    value=${(P)name-}
    [[ -n $value ]] || continue
    for entry in ${=value//,/ }; do
      [[ $entry == '*' || $entry == 127.0.0.1 || $entry == "127.0.0.1:$1" || ( $entry == .* && 127.0.0.1 == *"$entry" ) ]] && { exempted=true; continue 2; }
    done
    return 0
  done
  ! $exempted
}

# Claude Code reports each turn through the hooks main wrote for this terminal (hook-channel.cjs), passed with --settings,
# which merge with the user's own settings instead of replacing them: HTTP hooks, or command hooks when a proxy would
# carry them. A proxy set in this terminal (by the user's start-up files, say) falls back too, and main is told why.
claude() {
  emulate -L zsh
  local -a program
  if ! __pg_program claude; then
    print -P '%F{yellow}Claude Code was not found in PATH. Install it, then restart this terminal.%f'
    return 127
  fi
  program=("${reply[@]}")
  local settings=$__pg_hook_fallback
  if [[ $__pg_hook_channel == http ]]; then
    if __pg_hook_proxy $__pg_hook_port; then __pg_send hook-channel 0 claude $REPLY; else settings=$__pg_hook_settings; fi
  fi
  __pg_send codex-started 0 claude "$(__pg_command "$@")"
  # What the reading view can show; a later --append-system-prompt of the user's wins.
  local -a note=()
  local current_note=$(__pg_reading_note)
  if [[ $current_note == *" Agentrix skill delivery: "* ]]; then
    current_note="${current_note%%" Agentrix skill delivery: "*} Agentrix delivers skill instructions through its SessionStart hook."
  fi
  [[ -n $current_note ]] && note=(--append-system-prompt "$current_note")
  # Without settings for this terminal Claude Code starts with the user's own alone, never with an empty file.
  local session_folder=${__pg_note_file%/*} session_name=${__pg_note_file##*/} settings_file=
  local -a settings_args=()
  if [[ -n $settings ]]; then
    [[ -n $__pg_note_file && $session_folder != "$__pg_note_file" ]] || session_folder=${TMPDIR:-/tmp}
    session_name=${session_name%-skills.txt}
    settings_file=$(mktemp "$session_folder/${session_name:-agentrix}-claude-settings-XXXXXX") || return 1
    printf '%s' "$settings" > "$settings_file"
    settings_args=(--settings "$settings_file")
  fi
  AGENTRIX_READING_NOTE_FILE="$__pg_note_file" "${program[@]}" "${settings_args[@]}" "${note[@]}" "$@"
  local code=$?
  [[ -n $settings_file ]] && rm -f -- "$settings_file"
  __pg_send codex-exited $code claude
  return $code
}

__pg_precmd() { __pg_send shell-prompt }
add-zsh-hook precmd __pg_precmd

# The user's start-up files may have changed directory; the terminal opens where Agentrix asked.
[[ -n $__pg_start && -d $__pg_start ]] && builtin cd -q -- $__pg_start
print -P '%F{8}  AGENTRIX%f'
print -P '%F{8}  Type codex or claude to start, or codex resume --last to continue.%f'
print
__pg_send shell-ready
