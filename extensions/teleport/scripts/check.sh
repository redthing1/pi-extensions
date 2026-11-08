#!/bin/sh
set -eu
pi_root=${1:?usage: check.sh /absolute/pi-root}
case "$pi_root" in /*) ;; *) echo 'pi root must be absolute' >&2; exit 2 ;; esac
test -f "$pi_root/tsconfig.json"
source_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
extensions_root=$(dirname "$source_root")
temporary_root=$(mktemp -d "$pi_root/.pi-teleport-check.XXXXXX")
trap 'rm -r -- "$temporary_root"' EXIT HUP INT TERM
mkdir "$temporary_root/extensions"
mkdir "$temporary_root/tmp"
cp -R "$source_root" "$temporary_root/extensions/teleport"
cp -R "$extensions_root/shared" "$temporary_root/extensions/shared"
cd "$pi_root"
TMPDIR="$temporary_root/tmp" bun "$temporary_root/extensions/teleport/scripts/check.ts"
