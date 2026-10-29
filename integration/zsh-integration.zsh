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
typeset -g __pg_account_baseline=$AGENTRIX_ACCOUNT_BASELINE
typeset -gi __pg_sequence=0
unset AGENTRIX_SOCKET AGENTRIX_PROJECT_ID AGENTRIX_SESSION_KEY AGENTRIX_NODE AGENTRIX_EVENT_HELPER AGENTRIX_START_DIR AGENTRIX_USER_ZDOTDIR AGENTRIX_READING_NOTE AGENTRIX_READING_NOTE_FILE AGENTRIX_ACCOUNT_BASELINE

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

# The words that run codex or claude ($1), in reply; fails when neither the alias nor PATH has a program.
__pg_program() {
  emulate -L zsh
  reply=()
  (( ${+__pg_aliases[$1]} )) && reply=(${(Q)${(z)__pg_aliases[$1]}})
  (( $#reply )) || reply=($1)
  reply[1]=${reply[1]/#\~/$HOME}
  if [[ $reply[1] == */* ]]; then [[ -x $reply[1] ]]
  else reply[1]=$(whence -p -- $reply[1]) || return 1; [[ -n $reply[1] ]]; fi
}

# type [exit code] [agent]: one line of JSON to Agentrix's socket, the event bootstrap.ps1 sends.
# A subshell writes it, so a closed Agentrix can never stop this shell.
__pg_send() {
  emulate -L zsh
  (( ++__pg_sequence ))
  local project key cwd home command launch= codex=false claude=false
  __pg_json "${4:-}"; command=$REPLY
  __pg_json $__pg_project; project=$REPLY
  __pg_json $__pg_key; key=$REPLY
  __pg_json $PWD; cwd=$REPLY
  __pg_json ${CODEX_HOME:-$HOME/.codex}; home=$REPLY
  __pg_program codex && codex=true
  __pg_program claude && claude=true
  if [[ $1 == codex-started && ${3:-codex} == codex ]]; then
    local scope=unavailable
    [[ ${5:-} == model-only-v1 ]] && scope=model-only-v1
    launch=",\"accountLaunch\":\"$scope\""
  fi
  local line="{\"projectId\":$project,\"sessionKey\":$key,\"type\":\"$1\",\"sequence\":$__pg_sequence,\"exitCode\":${2:-0},\"agent\":\"${3:-codex}\",\"codexAvailable\":$codex,\"claudeAvailable\":$claude,\"codexHome\":$home,\"cwd\":$cwd,\"command\":$command$launch}"
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

# Private stdin to the same classifier Bash and PowerShell use.
__pg_account_scope() {
  emulate -L zsh
  local word separator=
  [[ -n $__pg_account_baseline ]] || { print -rn -- unavailable; return; }
  {
    printf '{"baseline":%s,"args":[' "$__pg_account_baseline"
    for word in "$@"; do __pg_json "$word"; printf '%s%s' "$separator" "$REPLY"; separator=,; done
    printf ']}'
  } | ELECTRON_RUN_AS_NODE=1 "$__pg_node" "${__pg_helper%/*}/codex-account-scope.cjs" 2>/dev/null
}

codex() {
  emulate -L zsh
  local -a program
  if ! __pg_program codex; then
    print -P '%F{yellow}Codex CLI was not found in PATH. Install it, then restart this terminal.%f'
    return 127
  fi
  program=("${reply[@]}")
  # Codex runs this after every turn with one JSON argument: Agentrix's own executable, run as Node.
  local notify= word
  for word in /usr/bin/env ELECTRON_RUN_AS_NODE=1 "$__pg_node" "$__pg_helper" codex-notify "$__pg_socket" "$__pg_project" "$__pg_key"; do
    __pg_json "$word"; notify+=${notify:+,}$REPLY
  done
  __pg_send codex-started 0 codex "$(__pg_command "$@")" "$(__pg_account_scope "${program[@]:1}" "$@")"
  # What the reading view can show (electron/features/agents/reading-note.cjs); the user's own -c comes later and wins.
  local -a note=()
  local current_note=$(__pg_reading_note)
  [[ -n $current_note ]] && note=(-c "developer_instructions=\"$current_note\"")
  "${program[@]}" -c "notify=[$notify]" -c 'tui.terminal_title=["session-id"]' "${note[@]}" "$@"
  local code=$?
  __pg_send codex-exited $code
  return $code
}

# Claude Code reports each turn through hooks passed with --settings, which merge with the user's own settings
# instead of replacing them. Claude runs a hook command with sh, so every word is quoted for it.
claude() {
  emulate -L zsh
  local -a program
  if ! __pg_program claude; then
    print -P '%F{yellow}Claude Code was not found in PATH. Install it, then restart this terminal.%f'
    return 127
  fi
  program=("${reply[@]}")
  local hook="ELECTRON_RUN_AS_NODE=1 ${(qq)__pg_node} ${(qq)__pg_helper} claude-hook ${(qq)__pg_socket} ${(qq)__pg_project} ${(qq)__pg_key}"
  local start stop notify session
  __pg_json "$hook start"; start=$REPLY
  __pg_json "$hook stop"; stop=$REPLY
  __pg_json "$hook notify"; notify=$REPLY
  __pg_json "$hook session"; session=$REPLY
  local settings="{\"hooks\":{\"UserPromptSubmit\":[{\"hooks\":[{\"type\":\"command\",\"command\":$start,\"timeout\":10}]}],\"Stop\":[{\"hooks\":[{\"type\":\"command\",\"command\":$stop,\"timeout\":10}]}],\"Notification\":[{\"hooks\":[{\"type\":\"command\",\"command\":$notify,\"timeout\":10}]}],\"SessionStart\":[{\"hooks\":[{\"type\":\"command\",\"command\":$session,\"timeout\":10}]}]}}"
  __pg_send codex-started 0 claude "$(__pg_command "$@")"
  # What the reading view can show; a later --append-system-prompt of the user's wins.
  local -a note=()
  local current_note=$(__pg_reading_note)
  [[ -n $current_note ]] && note=(--append-system-prompt "$current_note")
  "${program[@]}" --settings "$settings" "${note[@]}" "$@"
  local code=$?
  __pg_send codex-exited $code claude
  return $code
}

__pg_precmd() { __pg_send shell-prompt }
add-zsh-hook precmd __pg_precmd

# The user's start-up files may have changed directory; the terminal opens where Agentrix asked.
[[ -n $__pg_start && -d $__pg_start ]] && builtin cd -q -- $__pg_start
print -P '%F{8}  AGENTRIX%f'
print -P '%F{8}  Type codex or claude to start, or codex resume to continue a session.%f'
print
__pg_send shell-ready
