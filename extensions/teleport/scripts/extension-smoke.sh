#!/bin/sh
set -eu

pi_root=${1:-}
ssh_config=${2:-}
destination=${3:-teleport-test}

if [ -z "$pi_root" ] || [ -z "$ssh_config" ]; then
	echo "usage: extension-smoke.sh <pi-root> <isolated-ssh-config> [destination]" >&2
	exit 2
fi
case "$pi_root" in
	/*) ;;
	*) echo "pi root must be absolute" >&2; exit 2 ;;
esac
case "$ssh_config" in
	/*) ;;
	*) echo "ssh config must be absolute" >&2; exit 2 ;;
esac
if [ ! -f "$pi_root/packages/coding-agent/src/index.ts" ]; then
	echo "not a Pi source checkout: $pi_root" >&2
	exit 2
fi
if [ ! -f "$ssh_config" ]; then
	echo "ssh config does not exist: $ssh_config" >&2
	exit 2
fi

source_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
extensions_root=$(dirname "$source_root")
temporary_root=$(mktemp -d "$pi_root/.pi-teleport-extension-smoke.XXXXXX")
cleanup() {
	case "$temporary_root" in
		"$pi_root"/.pi-teleport-extension-smoke.*)
			if [ -d "$temporary_root" ] && [ ! -L "$temporary_root" ]; then
				rm -r -- "$temporary_root"
			fi
			;;
		*) echo "refusing to remove unexpected path: $temporary_root" >&2 ;;
	esac
}
trap cleanup EXIT HUP INT TERM

mkdir "$temporary_root/extensions"
mkdir "$temporary_root/tmp"
mkdir -p "$temporary_root/home/.ssh"
cp "$ssh_config" "$temporary_root/home/.ssh/config"
cp -R "$source_root" "$temporary_root/extensions/teleport"
cp -R "$extensions_root/shared" "$temporary_root/extensions/shared"
cp -R "$extensions_root/apply-patch" "$temporary_root/extensions/apply-patch"
cd "$pi_root"
HOME="$temporary_root/home" TMPDIR="$temporary_root/tmp" PI_TELEPORT_FIXTURE_CONFIG="$ssh_config" bun "$temporary_root/extensions/teleport/scripts/extension-smoke.ts" \
	--config "$ssh_config" \
	--destination "$destination"
