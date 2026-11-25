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
typeset -g __pg_fast_hook_settings=$AGENTRIX_FAST_HOOK_SETTINGS __pg_fast_hook_fallback=$AGENTRIX_FAST_HOOK_FALLBACK
unset AGENTRIX_FAST_HOOK_SETTINGS AGENTRIX_FAST_HOOK_FALLBACK
typeset -gi __pg_sequence=0
unset AGENTRIX_SOCKET AGENTRIX_PROJECT_ID AGENTRIX_SESSION_KEY AGENTRIX_NODE AGENTRIX_EVENT_HELPER AGENTRIX_START_DIR AGENTRIX_USER_ZDOTDIR AGENTRIX_READING_NOTE AGENTRIX_READING_NOTE_FILE AGENTRIX_ACCOUNT_BASELINE
unset AGENTRIX_HOOK_PORT AGENTRIX_HOOK_CHANNEL AGENTRIX_HOOK_SETTINGS AGENTRIX_HOOK_FALLBACK

# The shim folder goes only to the Claude Code the claude wrapper starts (intercept.cjs --launch): this shell, its scripts and
# whatever else it runs find the real CLIs, and the wrappers' own lookups skip the folder too.
typeset -g __pg_shims=$(ELECTRON_RUN_AS_NODE=1 "$__pg_node" -e 'try { process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).shims || ""); } catch {}' "$AGENTRIX_BOOTSTRAP" 2>/dev/null)
[[ -n $__pg_shims && -d $__pg_shims ]] || __pg_shims=
__pg_intercept="${__pg_shims:-${${(%):-%N}:h}/shims}/intercept.cjs"
unset AGENTRIX_DISPATCH_DEPTH AGENTRIX_RUN_ID AGENTRIX_RUN_PROOF AGENTRIX_SHIM_NODE

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
  if [[ $1 == agent-started ]]; then
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

__pg_redirect_agent() {
  local agent=$1; shift
  local word REPLY payload='[' separator=
  for word in "$@"; do
    __pg_json "$word"; payload+="$separator$REPLY"; separator=,
  done
  payload+=']'
  __pg_send agent-started 0 "$agent" '' '' "$payload"
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

__pg_ultracode_settings() {
  # The hook settings from main are compact JSON objects.
  if [[ "$(cat -- "${AGENTRIX_BOOTSTRAP}.mode" 2>/dev/null)" != conductor ]]; then
    printf '%s' "$1"
  elif [[ -z $1 || $1 == '{}' ]]; then
    printf '%s' '{"ultracode":true}'
  else
    printf '{"ultracode":true,%s' "${1#\{}"
  fi
}

# The shell keeps executable lookup, pipe events and temporary hook files.
agentrix_agent() {
  emulate -L zsh
  local agent=$1; shift
  local -a reply program
  local found=1 mode=conductor word route
  if __pg_program "$agent"; then program=("${reply[@]}"); else found=0; fi
  [[ -n ${AGENTRIX_BOOTSTRAP-} && "$(cat -- "${AGENTRIX_BOOTSTRAP}.mode" 2>/dev/null)" == native ]] && mode=native
  # Without a runnable helper the CLI starts with the user's words alone.
  if [[ ! -x $__pg_node ]]; then
    [[ $found == 1 ]] || { printf '%s\n' "$agent was not found in PATH. Install it, then restart this terminal."; return 127; }
    "${program[@]}" "$@"; return
  fi
  route=$(AGENTRIX_LAUNCH_ALIAS="${program[2]-}" ELECTRON_RUN_AS_NODE=1 "$__pg_node" "$__pg_intercept" --launch "$agent" classify "$mode" "$@") || return
  case $route in
    native)
      __pg_redirect_agent "$agent" "${program[@]:1}" "$@"
      return;;
    refused)
      printf '%s\n' '模型由模型路由决定，请在模型路由中更改。' >&2
      return 2;;
  esac
  if [[ $found == 0 ]]; then
    local label='Claude Code'
    [[ $route == passthrough ]] && label='Codex CLI'
    print -P "%F{yellow}$label was not found in PATH. Install it, then restart this terminal.%f"
    return 127
  fi
  if [[ $route == passthrough ]]; then "${program[@]}" "$@"; return; fi
  local launch_http=$__pg_hook_settings launch_fallback=$__pg_hook_fallback
  local model effort fast seat_map ultracode legacy_seats seat_valid=0 lead_file=${AGENTRIX_BOOTSTRAP-}.lead
  local model_pattern='^[A-Za-z0-9][]A-Za-z0-9_.:@+/[-]{0,159}$' effort_pattern='^[a-z][a-z0-9-]{0,31}$'
  if [[ $route == conversation && -n ${AGENTRIX_BOOTSTRAP-} && -r $lead_file ]] &&
    { IFS= read -r model && IFS= read -r effort && IFS= read -r fast && {
        # Old files put the seat map on line 6, after two retired fields.
        IFS= read -r seat_map || :
        if IFS= read -r ultracode && IFS= read -r legacy_seats; then seat_map=$legacy_seats; ultracode=; fi
      }; } < "$lead_file" &&
    [[ $model =~ $model_pattern && $effort =~ $effort_pattern && ( $fast == 0 || $fast == 1 ) ]]; then
    seat_valid=1
    if [[ $fast == 1 ]]; then launch_http=$__pg_fast_hook_settings launch_fallback=$__pg_fast_hook_fallback; fi
  fi
  if [[ $seat_valid == 0 ]]; then model= effort=; fi
  [[ ${seat_map-} == \{* ]] || seat_map=null
  local settings=$launch_fallback
  if [[ $__pg_hook_channel == http ]]; then
    if __pg_hook_proxy $__pg_hook_port; then __pg_send hook-channel 0 "$agent" $REPLY; else settings=$launch_http; fi
  fi
  [[ ${ultracode-} == ultracode && $seat_valid == 1 ]] && settings=$(__pg_ultracode_settings "$settings")
  __pg_send agent-started 0 "$agent" "$(__pg_command "$@")"
  local current_note=$(__pg_reading_note)
  # Without settings for this terminal Claude Code starts with the user's own alone, never with an empty file.
  local session_folder=${__pg_note_file%/*} session_name=${__pg_note_file##*/} settings_file=
  if [[ -n $settings ]]; then
    [[ -n $__pg_note_file && $session_folder != "$__pg_note_file" ]] || session_folder=${TMPDIR:-/tmp}
    session_name=${session_name%-skills.txt}
    settings_file=$(mktemp "$session_folder/${session_name:-agentrix}-claude-settings-XXXXXX") || return 1
    printf '%s' "$settings" > "$settings_file"
  fi
  local -a planner=() launch_args=()
  local reading_args= target=plain
  [[ -n $__pg_shims ]] && target=shims
  for word in ${(0)"$(AGENTRIX_LAUNCH_MODEL="$model" AGENTRIX_LAUNCH_EFFORT="$effort" AGENTRIX_LAUNCH_NOTE="$current_note" \
      AGENTRIX_LAUNCH_SETTINGS="$settings_file" AGENTRIX_SEATS="$seat_map" ELECTRON_RUN_AS_NODE=1 \
      "$__pg_node" "$__pg_intercept" --launch "$agent" words "$target" "$@")"}; do
    if [[ -n $reading_args ]]; then launch_args+=("$word"); elif [[ $word == -- ]]; then reading_args=1; else planner+=("$word"); fi
  done
  local code=1
  if [[ -n $reading_args ]]; then
    command env "${planner[@]}" AGENTRIX_SEATS="$seat_map" AGENTRIX_READING_NOTE_FILE="$__pg_note_file" \
      "${program[@]}" "${launch_args[@]}" "$@"
    code=$?
  fi
  [[ -n $settings_file ]] && rm -f -- "$settings_file"
  __pg_send agent-exited $code "$agent"
  return $code
}

codex() { agentrix_agent codex "$@"; }
claude() { agentrix_agent claude "$@"; }

__pg_precmd() { __pg_send shell-prompt }
add-zsh-hook precmd __pg_precmd

# The user's start-up files may have changed directory; the terminal opens where Agentrix asked.
[[ -n $__pg_start && -d $__pg_start ]] && builtin cd -q -- $__pg_start
print -P '%F{8}  AGENTRIX%f'
print -P '%F{8}  Type codex or claude to start, or codex resume --last to continue.%f'
print
__pg_send shell-ready
