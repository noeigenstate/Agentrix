# Use only operations shared by Bash 3.2 and zsh.
expected=$1
bom=$(printf '\357\273\277')
cr=$(printf '\r')
seen=' '
first=1
format= version=
while IFS= read -r row || [ -n "$row" ]; do
    if [ "$first" = 1 ]; then row=${row#"$bom"}; first=0; fi
    case $row in *=*) ;; *) exit 2;; esac
    key=${row%%=*} value=${row#*=}
    case $key in [a-z]*) ;; *) exit 2;; esac
    case $key in *[!a-z0-9_]*) exit 2;; esac
    case $seen in *" $key "*) exit 2;; esac
    case $value in *"$cr"*) exit 2;; esac
    seen="$seen$key "
    case $key in format) format=$value;; version) version=$value;; esac
    printf '%s=%s\n' "$key" "$value"
done
[ "$format" = "$expected" ] && [ -n "$version" ] || exit 2
[ "$version" = 1 ] || exit 3
