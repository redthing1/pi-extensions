#!/bin/sh
set -eu

config=${1:-}
destination=${2:-teleport-test}

if [ -z "$config" ]; then
	echo "usage: mux-fallback-smoke.sh <isolated-ssh-config> [destination]" >&2
	exit 2
fi

directory=$(mktemp -d /tmp/pi-teleport-fallback-XXXXXX)
socket=$directory/c
master_pid=

cleanup() {
	if [ -n "$master_pid" ]; then
		kill "$master_pid" 2>/dev/null || true
		wait "$master_pid" 2>/dev/null || true
	fi
	rm -rf -- "$directory"
}
trap cleanup EXIT INT TERM

ssh -F "$config" \
	-M -N -T -S "$socket" \
	-o ControlMaster=yes \
	-o ControlPersist=no \
	-o RemoteCommand=none \
	-o RequestTTY=no \
	-o ForwardAgent=no \
	-o ForwardX11=no \
	-o ClearAllForwardings=yes \
	-o PermitLocalCommand=no \
	-o 'SendEnv=-*' \
	"$destination" &
master_pid=$!

attempt=0
while ! ssh -F "$config" -S "$socket" -O check "$destination" >/dev/null 2>&1; do
	attempt=$((attempt + 1))
	if [ "$attempt" -ge 100 ]; then
		echo "master did not become ready" >&2
		exit 1
	fi
	sleep 0.05
done

rm -- "$socket"

set +e
output=$(ssh -F "$config" \
	-T -S "$socket" \
	-o ControlMaster=no \
	-o ProxyCommand=/usr/bin/false \
	-o RemoteCommand=none \
	-o RequestTTY=no \
	-o ForwardAgent=no \
	-o ForwardX11=no \
	-o ClearAllForwardings=yes \
	-o PermitLocalCommand=no \
	-o 'SendEnv=-*' \
	"$destination" true 2>&1)
status=$?
set -e

if [ "$status" -eq 0 ]; then
	echo "mux client unexpectedly opened a direct connection" >&2
	exit 1
fi

printf 'fallback_blocked=true status=%s diagnostic=%s\n' "$status" "$output"
