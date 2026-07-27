#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
target=${1:-"$root/dist/vibration-community"}

mkdir -p "$target"
target=$(CDPATH= cd -- "$target" && pwd)
if [ "$target" = "$root" ]; then
  printf 'Refusing to export Community over the source directory: %s\n' "$root" >&2
  exit 1
fi

staging=$(mktemp -d "${TMPDIR:-/tmp}/vibration-community.XXXXXX")
trap 'rm -rf "$staging"' EXIT HUP INT TERM

rsync -a --delete-excluded --exclude-from="$root/editions/community.exclude" "$root/" "$staging/"
cp "$root/editions/community.package.json" "$staging/package.json"
cp "$root/editions/community.package-lock.json" "$staging/package-lock.json"

# The staging directory contains only public files. A second sync removes stale
# files from the target while explicitly preserving an existing Git history.
rsync -a --delete --exclude=".git/" "$staging/" "$target/"

printf 'Community export written to %s\n' "$target"
printf 'Check it with: cd %s && GOCACHE=/tmp/webtchat-go-cache go test -tags community ./... && npm run check:js\n' "$target"
