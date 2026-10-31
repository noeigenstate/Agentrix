# Agentrix shell integration for Bash, a local terminal on Linux.
# Bash starts with --rcfile naming this file, after the system's /etc/bash.bashrc where it has one. This sources
# the user's own ~/.bashrc, unchanged, then adds what zsh-integration.zsh adds to zsh: a report at every prompt
# and the codex and claude wrappers. No user file is modified.

# Keep shell integration private; the bootstrap path is inherited by dispatch helpers.
__pg_socket=$AGENTRIX_SOCKET __pg_project=$AGENTRIX_PROJECT_ID __pg_key=$AGENTRIX_SESSION_KEY
__pg_node=$AGENTRIX_NODE __pg_helper=$AGENTRIX_EVENT_HELPER __pg_start=$AGENTRIX_START_DIR __pg_note=$AGENTRIX_READING_NOTE
__pg_note_file=$AGENTRIX_READING_NOTE_FILE
__pg_account_baseline=$AGENTRIX_ACCOUNT_BASELINE
__pg_sequence=0
unset AGENTRIX_SOCKET AGENTRIX_PROJECT_ID AGENTRIX_SESSION_KEY AGENTRIX_NODE AGENTRIX_EVENT_HELPER AGENTRIX_START_DIR AGENTRIX_READING_NOTE AGENTRIX_READING_NOTE_FILE AGENTRIX_ACCOUNT_BASELINE

__pg_reading_note() {
  if [[ -n $__pg_note_file && -r $__pg_note_file ]]; then cat -- "$__pg_note_file"; else printf '%s' "$__pg_note"; fi
}

[[ -r ~/.bashrc ]] && builtin source ~/.bashrc

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
declare -A __pg_aliases=()
for __pg_name in codex claude; do
  if [[ -n ${BASH_ALIASES[$__pg_name]+set} ]]; then __pg_aliases[$__pg_name]=${BASH_ALIASES[$__pg_name]}; unalias "$__pg_name"; fi
done
unset __pg_name

# The words that run codex or claude ($1), in __pg_words; fails when neither the alias nor PATH has a program.
__pg_program() {
  __pg_words=()
  [[ -n ${__pg_aliases[$1]+set} ]] && eval "__pg_words=(${__pg_aliases[$1]})" 2>/dev/null
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
    "$1" "$__pg_sequence" "${2:-0}" "${3:-codex}" "$codex" "$claude" "${CODEX_HOME:-$HOME/.codex}" "$PWD" "${4:-}" "${5:-}" </dev/null >/dev/null 2>&1
  return 0
}

# The first word given to an agent's CLI when it is a subcommand or an option (update, --version): Agentrix tells such a
# run from a conversation by it (electron/features/agents/agent-command.cjs). Anything else is not sent.
__pg_command() {
  local pattern='^-{0,2}[A-Za-z][A-Za-z-]{0,23}$'
  [[ ${1-} =~ $pattern ]] && printf '%s' "$1"
  return 0
}

# Private stdin to the shared bounded classifier; only its enum is emitted.
__pg_account_scope() {
  local word separator=
  [[ -n $__pg_account_baseline ]] || { printf unavailable; return; }
  {
    printf '{"baseline":%s,"args":[' "$__pg_account_baseline"
    for word in "$@"; do __pg_json "$word"; printf '%s%s' "$separator" "$REPLY"; separator=,; done
    printf ']}'
  } | ELECTRON_RUN_AS_NODE=1 "$__pg_node" "${__pg_helper%/*}/codex-account-scope.cjs" 2>/dev/null
}

codex() {
  local __pg_words
  if ! __pg_program codex; then
    printf '\e[33m%s\e[0m\n' 'Codex CLI was not found in PATH. Install it, then restart this terminal.'
    return 127
  fi
  local -a program=("${__pg_words[@]}")
  # Codex runs this after every turn with one JSON argument: Agentrix's own executable, run as Node.
  local notify= word REPLY
  for word in /usr/bin/env ELECTRON_RUN_AS_NODE=1 "$__pg_node" "$__pg_helper" codex-notify "$__pg_socket" "$__pg_project" "$__pg_key"; do
    __pg_json "$word"; notify+=${notify:+,}$REPLY
  done
  __pg_send codex-started 0 codex "$(__pg_command "$@")" "$(__pg_account_scope "${program[@]:1}" "$@")"
  # What the reading view can show (electron/features/agents/reading-note.cjs); the user's own -c comes later and wins.
  local -a note=()
  local current_note=$(__pg_reading_note)
  [[ -n $current_note ]] && note=(-c "developer_instructions=\"$current_note\"")
  AGENTRIX_READING_NOTE_FILE="$__pg_note_file" "${program[@]}" -c "notify=[$notify]" -c 'tui.terminal_title=["session-id"]' "${note[@]}" "$@"
  local code=$?
  __pg_send codex-exited $code
  return $code
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
  local hook=ELECTRON_RUN_AS_NODE=1 word REPLY start stop notify session
  for word in "$__pg_node" "$__pg_helper" claude-hook "$__pg_socket" "$__pg_project" "$__pg_key"; do
    __pg_quote "$word"; hook+=" $REPLY"
  done
  __pg_json "$hook start"; start=$REPLY
  __pg_json "$hook stop"; stop=$REPLY
  __pg_json "$hook notify"; notify=$REPLY
  __pg_quote "$__pg_note_file"; __pg_json "$hook session $REPLY"; session=$REPLY
  local settings="{\"hooks\":{\"UserPromptSubmit\":[{\"hooks\":[{\"type\":\"command\",\"command\":$start,\"timeout\":10}]}],\"Stop\":[{\"hooks\":[{\"type\":\"command\",\"command\":$stop,\"timeout\":10}]}],\"Notification\":[{\"hooks\":[{\"type\":\"command\",\"command\":$notify,\"timeout\":10}]}],\"SessionStart\":[{\"hooks\":[{\"type\":\"command\",\"command\":$session,\"timeout\":10}]}]}}"
  __pg_send codex-started 0 claude "$(__pg_command "$@")"
  # What the reading view can show; a later --append-system-prompt of the user's wins.
  local -a note=()
  local current_note=$(__pg_reading_note)
  if [[ $current_note == *" Agentrix skill delivery: "* ]]; then
    current_note="${current_note%%" Agentrix skill delivery: "*} Agentrix delivers skill instructions through its SessionStart hook."
  fi
  [[ -n $current_note ]] && note=(--append-system-prompt "$current_note")
  AGENTRIX_READING_NOTE_FILE="$__pg_note_file" "${program[@]}" --settings "$settings" "${note[@]}" "$@"
  local code=$?
  __pg_send codex-exited $code claude
  return $code
}

# Runs first at every prompt and hands the command's exit status on to the user's own prompt commands.
__pg_precmd() { local code=$?; __pg_send shell-prompt; return $code; }
if [[ $(declare -p PROMPT_COMMAND 2>/dev/null) == 'declare -a'* ]]; then PROMPT_COMMAND=(__pg_precmd "${PROMPT_COMMAND[@]}")
else PROMPT_COMMAND="__pg_precmd${PROMPT_COMMAND:+; $PROMPT_COMMAND}"; fi

# The user's start-up files may have changed directory; the terminal opens where Agentrix asked.
[[ -n $__pg_start && -d $__pg_start ]] && builtin cd -- "$__pg_start"
printf '\e[90m%s\e[0m\n' '  AGENTRIX' '  Type codex or claude to start, or codex resume to continue a session.' ''
__pg_send shell-ready
