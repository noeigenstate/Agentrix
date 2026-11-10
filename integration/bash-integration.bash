# Agentrix shell integration for Bash, a local terminal on Linux and macOS.
# Bash starts with --rcfile naming this file. Linux keeps ~/.bashrc; macOS reads the login files here because
# --login would ignore --rcfile. Then add prompt reports and the codex and claude wrappers. No user file is modified.

# Keep shell integration private; the bootstrap path is inherited by dispatch helpers.
__pg_socket=$AGENTRIX_SOCKET __pg_project=$AGENTRIX_PROJECT_ID __pg_key=$AGENTRIX_SESSION_KEY
__pg_node=$AGENTRIX_NODE __pg_helper=$AGENTRIX_EVENT_HELPER __pg_start=$AGENTRIX_START_DIR __pg_note=$AGENTRIX_READING_NOTE
__pg_note_file=$AGENTRIX_READING_NOTE_FILE
__pg_login_files=$AGENTRIX_LOGIN_FILES
__pg_sequence=0
unset AGENTRIX_SOCKET AGENTRIX_PROJECT_ID AGENTRIX_SESSION_KEY AGENTRIX_NODE AGENTRIX_EVENT_HELPER AGENTRIX_START_DIR AGENTRIX_READING_NOTE AGENTRIX_READING_NOTE_FILE AGENTRIX_ACCOUNT_BASELINE AGENTRIX_LOGIN_FILES

__pg_reading_note() {
  if [[ -n $__pg_note_file && -r $__pg_note_file ]]; then cat -- "$__pg_note_file"; else printf '%s' "$__pg_note"; fi
}

if [[ $__pg_login_files == 1 ]]; then
  [[ -r /etc/profile ]] && builtin source /etc/profile
  for __pg_profile in ~/.bash_profile ~/.bash_login ~/.profile; do
    if [[ -r $__pg_profile ]]; then builtin source "$__pg_profile"; break; fi
  done
  unset __pg_profile
else
  [[ -r ~/.bashrc ]] && builtin source ~/.bashrc
fi
unset __pg_login_files

# A JSON string (also a TOML basic string) for $1, in REPLY.
__pg_json() {
  local value=$1 out= character index
  value=${value//\\/\\\\}; value=${value//\"/\\\"}
  value=${value//$'\n'/\\n}; value=${value//$'\r'/\\r}; value=${value//$'\t'/\\t}
  if [[ $value == *[[:cntrl:]]* ]]; then
    for (( index = 0; index < ${#value}; index++ )); do
      character=${value:index:1}
      [[ $character == [[:cntrl:]] ]] && printf -v character '\\u%04x' "'$character"
      out+=$character
    done
    value=$out
  fi
  REPLY="\"$value\""
}

# $1 quoted for sh, in REPLY.
__pg_quote() { REPLY="'${1//\'/\'\\\'\'}'"; }

# An alias for codex or claude from the user's start-up files (alias claude=~/.claude/local/claude, or
# alias claude='claude --model opus') would bypass the wrappers below. Each wrapper runs the alias's words instead.
__pg_alias_codex= __pg_alias_claude=
for __pg_name in codex claude; do
  if __pg_alias=$(builtin alias "$__pg_name" 2>/dev/null); then
    eval "__pg_alias_$__pg_name=${__pg_alias#*=}"
    builtin unalias "$__pg_name"
  fi
done
unset __pg_name __pg_alias

# The words that run codex or claude ($1), in __pg_words; fails when neither the alias nor PATH has a program.
__pg_program() {
  local alias_name=__pg_alias_$1
  __pg_words=()
  [[ -n ${!alias_name} ]] && eval "__pg_words=(${!alias_name})" 2>/dev/null
  (( ${#__pg_words[@]} )) || __pg_words=("$1")
  [[ ${__pg_words[0]} == '~'* ]] && __pg_words[0]=$HOME${__pg_words[0]:1}
  if [[ ${__pg_words[0]} == */* ]]; then [[ -x ${__pg_words[0]} ]]
  else __pg_words[0]=$(builtin type -P -- "${__pg_words[0]}") && [[ -n ${__pg_words[0]} ]]; fi
}

# type [exit code] [agent]: one report to Agentrix's socket, the event zsh-integration.zsh sends. Bash has
# no Unix sockets, so Agentrix's own executable sends it as Node; a closed Agentrix never stops this shell.
__pg_send() {
  (( ++__pg_sequence ))
  local codex=false claude=false __pg_words
  __pg_program codex && codex=true
  __pg_program claude && claude=true
  ELECTRON_RUN_AS_NODE=1 "$__pg_node" "$__pg_helper" shell-event "$__pg_socket" "$__pg_project" "$__pg_key" \
    "$1" "$__pg_sequence" "${2:-0}" "${3:-codex}" "$codex" "$claude" "${CODEX_HOME:-$HOME/.codex}" "$PWD" "${4:-}" "${5:-}" "${6-}" </dev/null >/dev/null 2>&1
  return 0
}

# The first word given to an agent's CLI when it is a subcommand or an option (update, --version): Agentrix tells such a
# run from a conversation by it (electron/features/agents/agent-command.cjs). Anything else is not sent.
__pg_command() {
  local pattern='^-{0,2}[A-Za-z][A-Za-z-]{0,23}$'
  [[ ${1-} =~ $pattern ]] && printf '%s' "$1"
  return 0
}

# Whether $1, the first word given to codex, is one of the CLI's own management runs (codex --help, checked against
# 0.167.0). Those start no conversation and run in this terminal; everything else opens in native mode. bootstrap.ps1,
# zsh-integration.zsh and remote-worker.py carry the same words.
__pg_codex_terminal() {
  case ${1-} in --version|-V|--help|-h|help|login|logout|mcp|plugin|app-server|remote-control|app|completion|update|doctor|sandbox|debug|apply|a|archive|delete|unarchive|migrate-rollouts|migrate-nfs-db|exec-server|features) return 0;; esac
  return 1
}

# A management run is the CLI itself, with the user's alias and its exit status. Any other codex requests the
# existing native session path, and no Codex executable runs here.
codex() {
  local -a __pg_words
  local found=true
  __pg_program codex || { found=false; __pg_words=(codex); }
  if __pg_codex_terminal "${__pg_words[1]-${1-}}"; then
    if $found; then "${__pg_words[@]}" "$@"; return; fi
    printf '\e[33m%s\e[0m\n' 'Codex CLI was not found in PATH. Install it, then restart this terminal.'
    return 127
  fi
  local word REPLY payload='[' separator=
  for word in "${__pg_words[@]:1}" "$@"; do
    __pg_json "$word"; payload+="$separator$REPLY"; separator=,
  done
  payload+=']'
  __pg_send codex-started 0 codex '' '' "$payload"
  printf '%s\n' '已请求在原生模式打开 Codex。'
  return 0
}

# Claude Code reports each turn through hooks passed with --settings, which merge with the user's own settings
# instead of replacing them. Claude runs a hook command with sh, so every word is quoted for it.
claude() {
  local __pg_words
  if ! __pg_program claude; then
    printf '\e[33m%s\e[0m\n' 'Claude Code was not found in PATH. Install it, then restart this terminal.'
    return 127
  fi
  local -a program=("${__pg_words[@]}")
  local hook=ELECTRON_RUN_AS_NODE=1 word REPLY start stop notify session progress permission
  for word in "$__pg_node" "$__pg_helper" claude-hook "$__pg_socket" "$__pg_project" "$__pg_key"; do
    __pg_quote "$word"; hook+=" $REPLY"
  done
  __pg_json "$hook start"; start=$REPLY
  __pg_json "$hook stop"; stop=$REPLY
  __pg_json "$hook notify"; notify=$REPLY
  __pg_json "$hook progress"; progress=$REPLY
  __pg_json "$hook permission"; permission=$REPLY
  __pg_quote "$__pg_note_file"; __pg_json "$hook session $REPLY"; session=$REPLY
  local settings="{\"hooks\":{\"UserPromptSubmit\":[{\"hooks\":[{\"type\":\"command\",\"command\":$start,\"timeout\":10}]}],\"Stop\":[{\"hooks\":[{\"type\":\"command\",\"command\":$stop,\"timeout\":10}]}],\"Notification\":[{\"hooks\":[{\"type\":\"command\",\"command\":$notify,\"timeout\":10}]}],\"SessionStart\":[{\"hooks\":[{\"type\":\"command\",\"command\":$session,\"timeout\":10}]}],\"PreToolUse\":[{\"hooks\":[{\"type\":\"command\",\"command\":$progress,\"timeout\":10,\"async\":true}]}],\"PostToolUse\":[{\"hooks\":[{\"type\":\"command\",\"command\":$progress,\"timeout\":10,\"async\":true}]}],\"PostToolUseFailure\":[{\"hooks\":[{\"type\":\"command\",\"command\":$progress,\"timeout\":10,\"async\":true}]}],\"PermissionDenied\":[{\"hooks\":[{\"type\":\"command\",\"command\":$progress,\"timeout\":10,\"async\":true}]}],\"ElicitationResult\":[{\"hooks\":[{\"type\":\"command\",\"command\":$progress,\"timeout\":10,\"async\":true}]}],\"PermissionRequest\":[{\"hooks\":[{\"type\":\"command\",\"command\":$permission,\"timeout\":10}]}],\"Elicitation\":[{\"hooks\":[{\"type\":\"command\",\"command\":$permission,\"timeout\":10}]}]}}"
  __pg_send codex-started 0 claude "$(__pg_command "$@")"
  # What the reading view can show; a later --append-system-prompt of the user's wins.
  local -a note=()
  local current_note=$(__pg_reading_note)
  if [[ $current_note == *" Agentrix skill delivery: "* ]]; then
    current_note="${current_note%%" Agentrix skill delivery: "*} Agentrix delivers skill instructions through its SessionStart hook."
  fi
  [[ -n $current_note ]] && note=(--append-system-prompt "$current_note")
  local session_folder=${__pg_note_file%/*} session_name=${__pg_note_file##*/} settings_file
  [[ -n $__pg_note_file && $session_folder != "$__pg_note_file" ]] || session_folder=${TMPDIR:-/tmp}
  session_name=${session_name%-skills.txt}
  settings_file=$(mktemp "$session_folder/${session_name:-agentrix}-claude-settings-XXXXXX") || return 1
  printf '%s' "$settings" > "$settings_file"
  AGENTRIX_READING_NOTE_FILE="$__pg_note_file" "${program[@]}" --settings "$settings_file" ${note[@]+"${note[@]}"} "$@"
  local code=$?
  rm -f -- "$settings_file"
  __pg_send codex-exited $code claude
  return $code
}

# Runs first at every prompt and hands the command's exit status on to the user's own prompt commands.
__pg_precmd() { local code=$?; __pg_send shell-prompt; return $code; }
if [[ $(declare -p PROMPT_COMMAND 2>/dev/null) == 'declare -a'* ]]; then PROMPT_COMMAND=(__pg_precmd "${PROMPT_COMMAND[@]}")
else PROMPT_COMMAND="__pg_precmd${PROMPT_COMMAND:+; $PROMPT_COMMAND}"; fi

# The user's start-up files may have changed directory; the terminal opens where Agentrix asked.
[[ -n $__pg_start && -d $__pg_start ]] && builtin cd -- "$__pg_start"
printf '\e[90m%s\e[0m\n' '  AGENTRIX' '  Type codex or claude to start, or codex resume --last to continue.' ''
__pg_send shell-ready
