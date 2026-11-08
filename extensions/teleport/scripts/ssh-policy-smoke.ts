import { strict as assert } from "node:assert";
import { createServer, connect } from "node:net";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { MasterConnection } from "../transport/master.ts";
import { sshEnvironment } from "../transport/policy.ts";

const { values } = parseArgs({ options: { config: { type: "string" } } });
if (!values.config) throw new Error("--config must name an isolated fixture configuration");
const fixture = resolve(values.config);
const marker = await readFile(join(fixture, "..", ".fixture-marker"), "utf8");
assert.equal(marker.trim(), "pi-teleport-isolated-fixture");
const root = await mkdtemp(join(tmpdir(), "pi-teleport-policy-"));
const config = join(root, "config");
const unsafeConfig = join(root, "unsafe-config");
const canary = "teleport-synthetic-client-only";
const oldAskpass = process.env.SSH_ASKPASS;
const oldSecret = process.env.TELEPORT_TEST_SECRET;
const server = createServer();
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const address = server.address();
assert(address && typeof address === "object");
const port = address.port;
await new Promise<void>((done, reject) => server.close((error) => (error ? reject(error) : done())));

async function capture(master: MasterConnection, command: string): Promise<string> {
	const child = master.spawnChannel(command);
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk: Buffer) => {
		stdout += chunk.toString();
	});
	child.stderr.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
	});
	child.stdin.end();
	await new Promise<void>((done, reject) => {
		child.once("error", reject);
		child.once("close", (code) => (code === 0 ? done() : reject(new Error(`channel ${code}: ${stderr}`))));
	});
	return stdout;
}

try {
	const original = await readFile(fixture, "utf8");
	const externalPort = /\bPort (\d+)/u.exec(original)?.[1];
	assert(externalPort);
	const base = original.replace("Host teleport-test", "Host teleport-test teleport-jump");
	const via = original.replace("Host teleport-test", "Host teleport-via-jump").replace(/\bPort \d+/u, "Port 2222");
	await writeFile(
		config,
		`${base}\n${via}  HostKeyAlias [127.0.0.1]:${externalPort}\n  ProxyJump teleport-jump\nHost *\n  SendEnv *\n  ForwardAgent yes\n  ForwardX11 yes\n  LocalForward 127.0.0.1:${port} 127.0.0.1:2222\n`,
		{ mode: 0o600 },
	);
	await writeFile(unsafeConfig, `${base}\nHost *\n  SetEnv TELEPORT_TEST_LITERAL=${canary}\n`, { mode: 0o600 });
	process.env.SSH_ASKPASS = canary;
	process.env.TELEPORT_TEST_SECRET = canary;
	assert.equal(sshEnvironment().TELEPORT_TEST_SECRET, undefined);
	for (const destination of ["teleport-test", "teleport-via-jump"]) {
		const master = new MasterConnection({ destination, sshConfigPath: config });
		await master.start();
		try {
			const environment = await capture(master, "env");
			assert(!environment.includes(canary), "no client environment may reach the server");
			assert(!environment.includes("SSH_AUTH_SOCK="), "agent forwarding must remain disabled");
			assert(!environment.includes("DISPLAY="), "X11 forwarding must remain disabled");
			await new Promise<void>((done, reject) => {
				const socket = connect({ host: "127.0.0.1", port });
				socket.once("connect", () => {
					socket.destroy();
					reject(new Error("configured local forward became reachable"));
				});
				socket.once("error", (error: NodeJS.ErrnoException) =>
					error.code === "ECONNREFUSED" ? done() : reject(error),
				);
			});
			const child = new MasterConnection({ destination, borrowedSocketPath: master.handoff().socketPath });
			await child.start();
			assert(!(await capture(child, "env")).includes(canary));
			await child.close();
			assert((await master.check()).ok, "borrowed clients must not close their parent's master");
		} finally {
			await master.close();
		}
		assert.throws(() => master.spawnChannel("true"), /not started/);
	}
	const unsafe = new MasterConnection({ destination: "teleport-test", sshConfigPath: unsafeConfig });
	await assert.rejects(
		() => unsafe.start(),
		(error: unknown) => {
			assert(error instanceof Error);
			assert.match(error.message, /does not permit SSH SetEnv/);
			assert(!error.message.includes(canary), "diagnostics must not echo configuration values");
			return true;
		},
	);
	console.log("teleport SSH policy smoke passed: direct, jump, child, environment, forwarding, and SetEnv rejection");
} finally {
	if (oldAskpass === undefined) delete process.env.SSH_ASKPASS;
	else process.env.SSH_ASKPASS = oldAskpass;
	if (oldSecret === undefined) delete process.env.TELEPORT_TEST_SECRET;
	else process.env.TELEPORT_TEST_SECRET = oldSecret;
	await rm(root, { recursive: true, force: true });
}
