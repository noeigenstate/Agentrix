# Agentrix shell integration for Bash, a local terminal on Linux and macOS.
# Bash starts with --rcfile naming this file. Linux keeps ~/.bashrc; macOS reads the login files here because
# --login would ignore --rcfile. Then add prompt reports and the codex and claude wrappers. No user file is modified.

# Keep shell integration private; the bootstrap path is inherited by dispatch helpers.
__pg_socket=$AGENTRIX_SOCKET __pg_project=$AGENTRIX_PROJECT_ID __pg_key=$AGENTRIX_SESSION_KEY
__pg_node=$AGENTRIX_NODE __pg_helper=$AGENTRIX_EVENT_HELPER __pg_start=$AGENTRIX_START_DIR __pg_note=$AGENTRIX_READING_NOTE
__pg_note_file=$AGENTRIX_READING_NOTE_FILE
__pg_login_files=$AGENTRIX_LOGIN_FILES
__pg_hook_port=$AGENTRIX_HOOK_PORT __pg_hook_channel=$AGENTRIX_HOOK_CHANNEL __pg_hook_settings=$AGENTRIX_HOOK_SETTINGS __pg_hook_fallback=$AGENTRIX_HOOK_FALLBACK
__pg_fast_hook_settings=$AGENTRIX_FAST_HOOK_SETTINGS __pg_fast_hook_fallback=$AGENTRIX_FAST_HOOK_FALLBACK
unset AGENTRIX_FAST_HOOK_SETTINGS AGENTRIX_FAST_HOOK_FALLBACK
__pg_sequence=0
unset AGENTRIX_SOCKET AGENTRIX_PROJECT_ID AGENTRIX_SESSION_KEY AGENTRIX_NODE AGENTRIX_EVENT_HELPER AGENTRIX_START_DIR AGENTRIX_READING_NOTE AGENTRIX_READING_NOTE_FILE AGENTRIX_ACCOUNT_BASELINE AGENTRIX_LOGIN_FILES
unset AGENTRIX_HOOK_PORT AGENTRIX_HOOK_CHANNEL AGENTRIX_HOOK_SETTINGS AGENTRIX_HOOK_FALLBACK

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

# The shim folder goes only to the Claude Code the claude wrapper starts (intercept.cjs --launch): this shell, its scripts and
# whatever else it runs find the real CLIs, and the wrappers' own lookups skip the folder too.
__pg_shims=$(ELECTRON_RUN_AS_NODE=1 "$__pg_node" -e 'try { process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).shims || ""); } catch {}' "$AGENTRIX_BOOTSTRAP" 2>/dev/null)
[[ -n $__pg_shims && -d $__pg_shims ]] || __pg_shims=
__pg_intercept="${__pg_shims:-${BASH_SOURCE[0]%/*}/shims}/intercept.cjs"
unset AGENTRIX_DISPATCH_DEPTH AGENTRIX_RUN_ID AGENTRIX_RUN_PROOF AGENTRIX_SHIM_NODE

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

# The words that run codex or claude ($1), in __pg_words; fails when neither the alias nor PATH has a program. Without
# an alias, each is the file Agentrix chose for this terminal (AGENTRIX_CODEX_EXECUTABLE, AGENTRIX_CLAUDE_EXECUTABLE)
# while it is there.
__pg_program() {
  local PATH=$PATH
  if [[ -n $__pg_shims ]]; then
    PATH=:$PATH:
    while [[ $PATH == *":$__pg_shims:"* ]]; do PATH=${PATH/":$__pg_shims:"/:}; done
    PATH=${PATH#:}; PATH=${PATH%:}
  fi
  local alias_name=__pg_alias_$1 chosen=AGENTRIX_CODEX_EXECUTABLE
  [[ $1 == claude ]] && chosen=AGENTRIX_CLAUDE_EXECUTABLE
  __pg_words=()
  [[ -n ${!alias_name} ]] && eval "__pg_words=(${!alias_name})" 2>/dev/null
  if (( ! ${#__pg_words[@]} )); then
    if [[ -f ${!chosen-} && -x ${!chosen-} ]]; then __pg_words=("${!chosen}"); else __pg_words=("$1"); fi
  fi
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

__pg_redirect_agent() {
  local agent=$1; shift
  local word REPLY payload='[' separator=
  for word in "$@"; do
    __pg_json "$word"; payload+="$separator$REPLY"; separator=,
  done
  payload+=']'
  __pg_send codex-started 0 "$agent" '' '' "$payload"
  printf '%s\n' '已请求在原生模式打开 Codex。'
  return 0
}

# The proxy variable that would carry this terminal's HTTP hooks to port $1, by hook-channel.cjs's rule over the live
# environment, in REPLY; fails when none would. HTTPS_PROXY or HTTP_PROXY in either case, unless every NO_PROXY and
# no_proxy that is set exempts 127.0.0.1. Bash 3.2 (macOS) has no case conversion, hence the spelled-out names.
__pg_hook_proxy() {
  local name entry exempted=false
  local -a entries
  REPLY=
  for name in HTTPS_PROXY https_proxy HTTP_PROXY http_proxy; do
    if [[ -n ${!name-} ]]; then REPLY=$name; break; fi
  done
  case $REPLY in '') return 1;; https_proxy) REPLY=HTTPS_PROXY;; http_proxy) REPLY=HTTP_PROXY;; esac
  for name in NO_PROXY no_proxy; do
    [[ -n ${!name-} ]] || continue
    IFS=$', \t\n' read -r -a entries <<< "${!name}"
    for entry in ${entries[@]+"${entries[@]}"}; do
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
  local agent=$1; shift
  local -a __pg_words program
  local found=1 mode=conductor word route
  if __pg_program "$agent"; then program=("${__pg_words[@]}"); else found=0; fi
  [[ -n ${AGENTRIX_BOOTSTRAP-} && "$(cat -- "${AGENTRIX_BOOTSTRAP}.mode" 2>/dev/null)" == native ]] && mode=native
  route=$(AGENTRIX_LAUNCH_ALIAS="${program[1]-}" ELECTRON_RUN_AS_NODE=1 "$__pg_node" "$__pg_intercept" --launch "$agent" classify "$mode" "$@") || return
  case $route in
    native)
      __pg_redirect_agent "$agent" ${program[@]+"${program[@]:1}"} "$@"
      return;;
    refused)
      printf '%s\n' '模型由模型路由决定，请在模型路由中更改。' >&2
      return 2;;
  esac
  if [[ $found == 0 ]]; then
    local label='Claude Code'
    [[ $route == passthrough ]] && label='Codex CLI'
    printf '\e[33m%s\e[0m\n' "$label was not found in PATH. Install it, then restart this terminal."
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
  local settings=$launch_fallback REPLY
  if [[ $__pg_hook_channel == http ]]; then
    if __pg_hook_proxy "$__pg_hook_port"; then __pg_send hook-channel 0 "$agent" "$REPLY"; else settings=$launch_http; fi
  fi
  [[ ${ultracode-} == ultracode && $seat_valid == 1 ]] && settings=$(__pg_ultracode_settings "$settings")
  __pg_send codex-started 0 "$agent" "$(__pg_command "$@")"
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
  while IFS= read -r -d '' word; do
    if [[ -n $reading_args ]]; then launch_args+=("$word"); elif [[ $word == -- ]]; then reading_args=1; else planner+=("$word"); fi
  done < <(AGENTRIX_LAUNCH_MODEL="$model" AGENTRIX_LAUNCH_EFFORT="$effort" AGENTRIX_LAUNCH_NOTE="$current_note" \
      AGENTRIX_LAUNCH_SETTINGS="$settings_file" AGENTRIX_SEATS="$seat_map" ELECTRON_RUN_AS_NODE=1 \
      "$__pg_node" "$__pg_intercept" --launch "$agent" words "$target" "$@")
  local code=1
  if [[ -n $reading_args ]]; then
    command env ${planner[@]+"${planner[@]}"} AGENTRIX_SEATS="$seat_map" AGENTRIX_READING_NOTE_FILE="$__pg_note_file" \
      "${program[@]}" ${launch_args[@]+"${launch_args[@]}"} "$@"
    code=$?
  fi
  [[ -n $settings_file ]] && rm -f -- "$settings_file"
  __pg_send codex-exited $code "$agent"
  return $code
}

codex() { agentrix_agent codex "$@"; }
claude() { agentrix_agent claude "$@"; }

# Runs first at every prompt and hands the command's exit status on to the user's own prompt commands.
__pg_precmd() { local code=$?; __pg_send shell-prompt; return $code; }
if [[ $(declare -p PROMPT_COMMAND 2>/dev/null) == 'declare -a'* ]]; then PROMPT_COMMAND=(__pg_precmd "${PROMPT_COMMAND[@]}")
else PROMPT_COMMAND="__pg_precmd${PROMPT_COMMAND:+; $PROMPT_COMMAND}"; fi

# The user's start-up files may have changed directory; the terminal opens where Agentrix asked.
[[ -n $__pg_start && -d $__pg_start ]] && builtin cd -- "$__pg_start"
printf '\e[90m%s\e[0m\n' '  AGENTRIX' '  Type codex or claude to start, or codex resume --last to continue.' ''
__pg_send shell-ready
