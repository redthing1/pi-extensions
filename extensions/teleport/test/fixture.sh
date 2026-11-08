#!/bin/sh
set -eu

action=${1:-}
state_directory=${2:-}
container_name=pi-teleport-test-sshd
image=pi-teleport-test:ssh

if [ -z "$action" ] || [ -z "$state_directory" ]; then
	echo "usage: fixture.sh <start|stop|status> <absolute-state-directory>" >&2
	exit 2
fi

case "$state_directory" in
	/*) ;;
	*) echo "state directory must be absolute" >&2; exit 2 ;;
esac

state_parent=$(dirname -- "$state_directory")
state_name=$(basename -- "$state_directory")
case "$state_name" in
	pi-teleport-fixture-*) ;;
	*) echo "state directory name must begin with pi-teleport-fixture-" >&2; exit 2 ;;
esac
if [ "$state_parent" != "/tmp" ]; then
	echo "test state directory must be an immediate child of /tmp" >&2
	exit 2
fi

case "$action" in
	start)
		if docker container inspect "$container_name" >/dev/null 2>&1; then
			echo "test container already exists: $container_name" >&2
			exit 1
		fi
		if [ -e "$state_directory" ]; then
			echo "test state directory already exists: $state_directory" >&2
			exit 1
		fi

		install -d -m 0700 "$state_directory"
		printf '%s\n' pi-teleport-isolated-fixture >"$state_directory/.fixture-marker"
		chmod 0600 "$state_directory/.fixture-marker"
		ssh-keygen -q -t ed25519 -N "" -C "pi-teleport-isolated-test" -f "$state_directory/id_ed25519"
		cp "$state_directory/id_ed25519.pub" "$state_directory/authorized_keys"
		chmod 0600 "$state_directory/id_ed25519" "$state_directory/authorized_keys"

		docker run --detach \
			--name "$container_name" \
			--hostname teleport-test \
			--publish 127.0.0.1::2222 \
			--mount "type=bind,src=$state_directory/authorized_keys,dst=/run/teleport-test/authorized_keys,readonly" \
			--memory 512m \
			--cpus 1 \
			--pids-limit 256 \
			--security-opt no-new-privileges \
			"$image" >"$state_directory/container-id"

		port=$(docker container inspect --format '{{(index (index .NetworkSettings.Ports "2222/tcp") 0).HostPort}}' "$container_name")
		attempt=0
		while ! ssh-keyscan -T 1 -p "$port" 127.0.0.1 >"$state_directory/known_hosts" 2>/dev/null; do
			attempt=$((attempt + 1))
			if [ "$attempt" -ge 20 ]; then
				echo "sshd did not become ready" >&2
				exit 1
			fi
			sleep 1
		done
		chmod 0600 "$state_directory/known_hosts"

		{
			echo "Host teleport-test"
			echo "  HostName 127.0.0.1"
			echo "  Port $port"
			echo "  User teleport"
			echo "  IdentityFile $state_directory/id_ed25519"
			echo "  IdentitiesOnly yes"
			echo "  IdentityAgent none"
			echo "  UserKnownHostsFile $state_directory/known_hosts"
			echo "  StrictHostKeyChecking yes"
			echo "  BatchMode yes"
			echo "  LogLevel ERROR"
		} >"$state_directory/ssh_config"
		chmod 0600 "$state_directory/ssh_config"

		docker exec --user teleport "$container_name" sh -c "printf '%s\\n' remote-sentinel > /workspace/sentinel.txt"
		printf 'container=%s\nport=%s\nconfig=%s\n' "$container_name" "$port" "$state_directory/ssh_config"
		;;
	stop)
		if [ -L "$state_directory" ] || [ ! -d "$state_directory" ] || [ ! -f "$state_directory/.fixture-marker" ] \
			|| [ "$(sed -n '1p' "$state_directory/.fixture-marker")" != "pi-teleport-isolated-fixture" ]; then
			echo "refusing to remove unmarked fixture state: $state_directory" >&2
			exit 1
		fi
		if docker container inspect "$container_name" >/dev/null 2>&1; then
			actual_id=$(docker container inspect --format '{{.Id}}' "$container_name")
			if [ ! -f "$state_directory/container-id" ] || [ "$(cat "$state_directory/container-id")" != "$actual_id" ]; then
				echo "refusing to remove a container not owned by this fixture" >&2
				exit 1
			fi
			docker container rm --force "$container_name" >/dev/null
		fi
		rm -r -- "$state_directory"
		;;
	status)
		docker container inspect --format 'name={{.Name}} state={{.State.Status}} port={{(index (index .NetworkSettings.Ports "2222/tcp") 0).HostPort}}' "$container_name"
		;;
	*)
		echo "unknown action: $action" >&2
		exit 2
		;;
esac
