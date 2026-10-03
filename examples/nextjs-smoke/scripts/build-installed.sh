#!/usr/bin/env bash
# Builds this example the way npm installs it: @decocms/blocks as a real folder in node_modules,
# not the workspace symlink (Next only compiles .ts outside node_modules unless transpilePackages says so).
# Needs .deco/blocks.gen.ts (run `deco content` first).
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
root="$(cd "$here/../.." && pwd)"
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT

(cd "$here" && tar --exclude=node_modules --exclude=.next --exclude='*.tsbuildinfo' -cf - .) | (cd "$out" && tar -xf -)
mkdir -p "$out/node_modules/@decocms"
for entry in "$root"/node_modules/* "$root"/node_modules/.bin; do
  [ "$(basename "$entry")" = "@decocms" ] || ln -s "$entry" "$out/node_modules/"
done
(cd "$root/packages/blocks" && tar --exclude=node_modules -cf - .) |
  (mkdir -p "$out/node_modules/@decocms/blocks" && cd "$out/node_modules/@decocms/blocks" && tar -xf -)

cd "$out" && "$root/node_modules/.bin/next" build
