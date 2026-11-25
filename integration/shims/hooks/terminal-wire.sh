# Shared by the local Bash 3.2 and zsh integrations.
# Output fields are local to the caller. This parser is also used for classify stdout.
__pg_read_fields() {
  local expected=$1 row key value seen=' ' format= version=
  local first=1
  while IFS= read -r row || [[ -n $row ]]; do
    if [[ $first == 1 ]]; then row=${row#$'\357\273\277'}; first=0; fi
    key=${row%%=*}; value=${row#*=}
    case $key in [a-z]*) ;; *) return 2;; esac
    case $key in *[!a-z0-9_]*) return 2;; esac
    [[ $row == *=* && $value != *$'\r'* && $seen != *" $key "* ]] || return 2
    seen+="$key "
    case $expected:$key in
      *:format) format=$value;;
      *:version) version=$value;;
      agentrix.session-mode:mode) wire_mode=$value;;
      agentrix.launch-route:route) wire_route=$value;;
      agentrix.lead-seat:model) wire_model=$value;;
      agentrix.lead-seat:effort) wire_effort=$value;;
      agentrix.lead-seat:fast) wire_fast=$value;;
      agentrix.lead-seat:ultracode) wire_ultracode=$value;;
      agentrix.lead-seat:seats) wire_seats=$value;;
    esac
  done
  [[ $format == "$expected" && $seen == *' version '* ]] || return 2
  [[ $version == 1 ]] || return 3
}

__pg_read_wire_file() {
  local file=$1 bytes probe
  [[ -f $file ]] || return 2
  bytes=$(wc -c < "$file") || return 2
  (( bytes <= 16384 )) || return 2
  if IFS= read -r -d '' probe < "$file"; then return 2; fi
  __pg_read_fields "$2" < "$file"
}

__pg_session_mode() {
  local file=${AGENTRIX_BOOTSTRAP-}.mode.env wire_mode=
  [[ -n ${AGENTRIX_BOOTSTRAP-} ]] || return 1
  if [[ ! -e $file && ! -L $file ]]; then
    cat -- "${file%.env}" 2>/dev/null
    return
  fi
  __pg_read_wire_file "$file" agentrix.session-mode || return
  case $wire_mode in native|conductor) printf '%s' "$wire_mode";; *) return 2;; esac
}

__pg_launch_route() {
  local wire_route=
  __pg_read_fields agentrix.launch-route <<< "$1" || return
  case $wire_route in passthrough|native|refused|conversation|utility|print) printf '%s' "$wire_route";; *) return 2;; esac
}

__pg_read_lead() {
  local wire_model= wire_effort= wire_fast= wire_ultracode= wire_seats= result
  __pg_read_wire_file "$1" agentrix.lead-seat
  result=$?
  if [[ $result == 3 ]]; then printf '%s\n' '座位文件版本不受支持' >&2; fi
  [[ $result == 0 ]] || return 1
  [[ $wire_ultracode == 0 || $wire_ultracode == 1 ]] && [[ -n $wire_seats ]] || return 1
  model=$wire_model effort=$wire_effort fast=$wire_fast seat_map=$wire_seats
  if [[ $wire_ultracode == 1 ]]; then ultracode=ultracode; fi
}

__pg_launch_words() {
  local record key value format= version=
  while IFS= read -r -d '' record; do
    [[ $record == *=* ]] || return 2
    key=${record%%=*}; value=${record#*=}
    case $key in
      format) [[ -z $format && -n $value ]] || return 2; format=$value;;
      version) [[ -z $version && -n $value ]] || return 2; version=$value;;
      unset) [[ -n $value && $value != *=* ]] || return 2; planner_unset+=(-u "$value");;
      env) [[ $value == ?*=* ]] || return 2; planner_env+=("$value");;
      arg) launch_args+=("$value");;
    esac
  done
  [[ -z $record && $format == agentrix.launch-words && $version == 1 ]]
}
