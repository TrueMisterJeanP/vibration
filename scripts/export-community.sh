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

# The Enterprise tree is deployable as-is, so its static assets carry an
# Enterprise cache/build token. Rewrite that token only inside the generated
# Community tree. Keeping this transformation here prevents either edition
# from advertising the other edition's build.
enterprise_build='enterprise-v467'
community_build='community-1-0-34-v467'

if grep -r -q 'community-1-0-[0-9]' "$root/web" "$root/tests"; then
  printf 'Refusing to export: a Community build token leaked into the Enterprise source tree.\n' >&2
  exit 1
fi

grep -r -l "$enterprise_build" "$staging/web" "$staging/tests" | while IFS= read -r file; do
  sed "s/$enterprise_build/$community_build/g" "$file" > "$file.community"
  mv "$file.community" "$file"
done

if grep -r -q "$enterprise_build" "$staging/web" "$staging/tests"; then
  printf 'Refusing to export: the Enterprise build token remains in the Community tree.\n' >&2
  exit 1
fi

# The staging directory contains only public files. A second sync removes stale
# files from the target while explicitly preserving an existing Git history.
rsync -a --delete --exclude=".git/" "$staging/" "$target/"

printf 'Community export written to %s\n' "$target"
printf 'Check it with: cd %s && GOCACHE=/tmp/webtchat-go-cache go test -tags community ./... && npm run check:js\n' "$target"
