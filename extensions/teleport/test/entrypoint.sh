#!/bin/sh
set -eu

key_source=/run/teleport-test/authorized_keys
key_target=/home/teleport/.ssh/authorized_keys

if [ ! -f "$key_source" ]; then
	echo "missing isolated test authorized_keys" >&2
	exit 1
fi

install -o teleport -g teleport -m 0600 "$key_source" "$key_target"
ssh-keygen -A >/dev/null

exec /usr/sbin/sshd -D -e -f /etc/ssh/sshd_config
