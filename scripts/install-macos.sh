#!/bin/bash
# Installs or updates Agentrix on a Mac with Apple silicon, from the latest GitHub release:
#   curl -fsSL https://raw.githubusercontent.com/noeigenstate/Agentrix/main/scripts/install-macos.sh | bash
# The build is signed ad hoc, not notarized by Apple. A file curl downloads carries no quarantine flag, so the
# app opens directly, without Gatekeeper's "cannot verify the developer" prompt; a DMG downloaded in a browser
# does show it. Nothing needs an administrator password.
# Options (environment variables):
#   AGENTRIX_VERSION=0.6.9          a given release instead of the latest
#   AGENTRIX_INSTALL_DIR=~/Applications   another folder than /Applications
#   AGENTRIX_OPEN=0                 install without opening the app
# A downloaded zip can be installed directly: bash install-macos.sh ~/Downloads/Agentrix-0.6.9-mac-arm64.zip
set -euo pipefail

repo=noeigenstate/Agentrix
app_name='Agentrix.app'
fail() { printf 'Agentrix: %s\n' "$1" >&2; exit 1; }

[[ $(uname -s) == Darwin ]] || fail 'this installer is for macOS.'
[[ $(sysctl -n hw.optional.arm64 2>/dev/null || true) == 1 ]] || fail 'this build needs a Mac with Apple silicon (M1 or later).'

work=$(mktemp -d "${TMPDIR:-/tmp}/agentrix-install.XXXXXX")
trap 'rm -rf "$work"' EXIT

if [[ $# -ge 1 ]]; then
  archive=$1
  [[ -f $archive ]] || fail "no such file: $archive"
else
  if [[ -n ${AGENTRIX_VERSION:-} ]]; then
    tag="v${AGENTRIX_VERSION#v}"
  else
    # The latest release page redirects to its tag; no API token or rate limit involved.
    latest=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$repo/releases/latest") || fail 'could not reach GitHub.'
    tag=${latest##*/}
  fi
  [[ $tag =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || fail "no release found ($tag)."
  version=${tag#v}
  name="Agentrix-$version-mac-arm64.zip"
  base="https://github.com/$repo/releases/download/$tag"
  printf 'Downloading Agentrix %s…\n' "$version"
  curl -fL --progress-bar -o "$work/$name" "$base/$name" || fail "$tag has no macOS build."
  curl -fsSL -o "$work/SHA256SUMS-mac.txt" "$base/SHA256SUMS-mac.txt" || fail 'the checksum file is missing from the release.'
  expected=$(awk -v file="$name" '$2 == file { print $1 }' "$work/SHA256SUMS-mac.txt")
  actual=$(shasum -a 256 "$work/$name" | awk '{ print $1 }')
  [[ -n $expected && $expected == "$actual" ]] || fail 'the download does not match its SHA-256 checksum.'
  archive="$work/$name"
fi

ditto -x -k "$archive" "$work/app"
[[ -d "$work/app/$app_name" ]] || fail "the archive does not contain $app_name."
codesign --verify --deep --strict "$work/app/$app_name" 2>/dev/null || fail 'the application signature is broken.'

destination=${AGENTRIX_INSTALL_DIR:-/Applications}
destination=${destination/#\~/$HOME}
if [[ -z ${AGENTRIX_INSTALL_DIR:-} && ! -w /Applications ]]; then destination="$HOME/Applications"; fi
mkdir -p "$destination"
target="$destination/$app_name"

# A running copy is asked to quit first; it asks about running terminals, and nothing is replaced until it has.
if pgrep -f "/$app_name/Contents/MacOS/Agentrix" >/dev/null 2>&1; then
  printf 'Quitting the running Agentrix…\n'
  osascript -e 'tell application id "local.projectgrid.desktop" to quit' >/dev/null 2>&1 || fail 'Agentrix is running. Quit it, then run this again.'
  for _ in $(seq 1 120); do pgrep -f "/$app_name/Contents/MacOS/Agentrix" >/dev/null 2>&1 || break; sleep 1; done
  pgrep -f "/$app_name/Contents/MacOS/Agentrix" >/dev/null 2>&1 && fail 'Agentrix is still running. Quit it, then run this again.'
fi

rm -rf "$target"
ditto "$work/app/$app_name" "$target"
# A zip that came through a browser passes its quarantine flag on; this copy is trusted as installed.
xattr -dr com.apple.quarantine "$target" 2>/dev/null || true
printf 'Installed %s\n' "$target"
[[ ${AGENTRIX_OPEN:-1} == 0 ]] || open "$target"
