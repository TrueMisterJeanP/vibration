#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
target=${1:-"$root/dist/vibration-community"}

mkdir -p "$target"
rsync -a --delete --delete-excluded --exclude-from="$root/editions/community.exclude" "$root/" "$target/"

printf 'Community export written to %s\n' "$target"
printf 'Check it with: cd %s && GOCACHE=/tmp/webtchat-go-cache go test -tags community ./... && npm run check:js\n' "$target"
