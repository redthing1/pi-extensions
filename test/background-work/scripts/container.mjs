// Trusted test controller only. Nothing here is exposed as an agent tool.
import fs from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

export class ContainerFixture {
	constructor(root) {
		this.root = root;
		this.config = join(root, "ssh_config");
		this.id = undefined;
	}
	docker(...args) {
		return execFileSync("docker", args, {
			encoding: "utf8",
			timeout: 30000,
			stdio: ["pipe", "pipe", "pipe"],
		});
	}
	start() {
		const image = process.env.PI_BACKGROUND_DOCKER_IMAGE;
		if (!/^sha256:[a-f0-9]{64}$/.test(image || ""))
			throw Error("Explicit local fixture image ID required");
		const host = this.docker(
			"context",
			"inspect",
			"--format",
			"{{.Endpoints.docker.Host}}",
		).trim();
		if (!host.startsWith("unix:///"))
			throw Error("This fixture requires a local Unix Docker endpoint");
		for (const name of ["identity", "host_key"])
			execFileSync("ssh-keygen", [
				"-q",
				"-t",
				"ed25519",
				"-N",
				"",
				"-C",
				"synthetic-background-test",
				"-f",
				join(this.root, name),
			]);
		const serverConfig = join(this.root, "sshd_config");
		fs.writeFileSync(
			serverConfig,
			`Port 2222
ListenAddress 127.0.0.1
HostKey /run/fixture/host_key
PidFile /tmp/background-sshd.pid
AuthorizedKeysFile /run/fixture/authorized_keys
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
UsePAM no
AllowUsers teleport
DisableForwarding yes
PermitUserEnvironment no
PermitUserRC no
PrintMotd no
PrintLastLog no
LogLevel ERROR
`,
			{ mode: 0o600 },
		);
		this.id = this.docker(
			"create",
			"--pull=never",
			"--name",
			`pi-bg-${this.root.split("/").at(-1)}`,
			"--network=none",
			"--read-only",
			"--cap-drop=ALL",
			"--cap-add=SETUID",
			"--cap-add=SETGID",
			"--cap-add=SYS_CHROOT",
			"--security-opt=no-new-privileges",
			"--memory=512m",
			"--cpus=1",
			"--pids-limit=128",
			"--tmpfs",
			"/tmp:rw,nosuid,nodev,size=128m,mode=1777",
			"--tmpfs",
			"/run/fixture:rw,nosuid,nodev,noexec,size=1m,mode=755",
			"--tmpfs",
			"/workspace:rw,nosuid,nodev,size=128m,uid=10001,gid=10001,mode=700",
			"--tmpfs",
			"/home/teleport:rw,nosuid,nodev,size=16m,uid=10001,gid=10001,mode=700",
			"--entrypoint",
			"/bin/sh",
			image,
			"-c",
			"while [ ! -f /run/fixture/ready ]; do sleep 0.1; done; exec /usr/sbin/sshd -D -e -f /run/fixture/sshd_config",
		).trim();
		this.docker("start", this.id);
		for (const [from, to, mode] of [
			["host_key", "host_key", 0o600],
			["identity.pub", "authorized_keys", 0o644],
			["sshd_config", "sshd_config", 0o600],
		])
			this.writeFile(
				"root",
				`/run/fixture/${to}`,
				fs.readFileSync(join(this.root, from)),
				mode,
			);
		this.writeFile("root", "/run/fixture/ready", "ready", 0o600);
		const info = JSON.parse(this.docker("inspect", this.id))[0];
		if (
			info.HostConfig.Privileged ||
			!info.HostConfig.ReadonlyRootfs ||
			info.HostConfig.NetworkMode !== "none" ||
			info.HostConfig.PidMode ||
			info.Mounts.some((m) => m.Type !== "tmpfs") ||
			(info.HostConfig.PortBindings &&
				Object.keys(info.HostConfig.PortBindings).length)
		)
			throw Error("Unexpected container isolation configuration");
		// SSH over a trusted docker-exec stdio relay: no published port or container network.
		const relay =
			"const s=require('net').connect(2222,'127.0.0.1');process.stdin.pipe(s);s.pipe(process.stdout);s.on('error',()=>process.exit(1));s.on('close',()=>process.exit());";
		const q = (s) => `'${s.replaceAll("'", "'\\''")}'`;
		const proxy = join(this.root, "proxy.sh");
		fs.writeFileSync(
			proxy,
			`#!/bin/sh\nexec docker --host=${q(host)} exec -i --user teleport ${q(this.id)} node -e ${q(relay)}\n`,
			{ mode: 0o700 },
		);
		fs.writeFileSync(
			join(this.root, "known_hosts"),
			`background-fixture ${fs.readFileSync(join(this.root, "host_key.pub"), "utf8")}`,
			{ mode: 0o600 },
		);
		fs.writeFileSync(
			this.config,
			`Host background-fixture
  HostName background-fixture
  HostKeyAlias background-fixture
  User teleport
  Port 2222
  ProxyCommand ${proxy}
  IdentityFile ${join(this.root, "identity")}
  IdentityAgent none
  IdentitiesOnly yes
  UserKnownHostsFile ${join(this.root, "known_hosts")}
  GlobalKnownHostsFile /dev/null
  StrictHostKeyChecking yes
  BatchMode yes
  LogLevel ERROR
`,
			{ mode: 0o600 },
		);
		return this;
	}
	exec(command) {
		return this.docker(
			"exec",
			"--user",
			"teleport",
			this.id,
			"sh",
			"-c",
			command,
		);
	}
	copyFile(source, destination) {
		this.writeFile("teleport", destination, fs.readFileSync(source), 0o600);
	}
	writeFile(user, path, data, mode) {
		execFileSync(
			"docker",
			[
				"exec",
				"-i",
				"--user",
				user,
				this.id,
				"node",
				"-e",
				"const fs=require('fs');fs.writeFileSync(process.argv[1],fs.readFileSync(0),{mode:Number(process.argv[2])});",
				path,
				String(mode),
			],
			{ input: data, timeout: 10000, stdio: ["pipe", "pipe", "pipe"] },
		);
	}
	close() {
		if (this.id) {
			this.docker("rm", "--force", this.id);
			this.id = undefined;
		}
	}
}
