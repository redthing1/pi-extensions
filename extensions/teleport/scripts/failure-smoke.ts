import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { MasterConnection, quotePosix } from "../transport/master.ts";
import { RemoteScratch } from "../transport/scratch.ts";
import { WorkerClient, WorkerRequestError } from "../transport/worker-client.ts";
import { WorkspaceClient } from "../workspace/client.ts";

const { values } = parseArgs({
	options: {
		config: { type: "string" },
		container: { type: "string" },
		destination: { type: "string", default: "teleport-test" },
		worker: { type: "string" },
	},
});

if (!values.config) throw new Error("--config is required");
if (!values.container) throw new Error("--container is required");
const configPath = resolve(values.config);
const destination = values.destination;
const container = values.container;
const fixtureDirectory = dirname(configPath);
if (container !== "pi-teleport-test-sshd") {
	throw new Error(`Refusing to kill an unexpected container: ${container}`);
}
if ((await readFile(join(fixtureDirectory, ".fixture-marker"), "utf8")).trim() !== "pi-teleport-isolated-fixture") {
	throw new Error("Failure injection requires an isolated Teleport fixture");
}
const workerPath = resolve(values.worker ?? new URL("../worker/worker.mjs", import.meta.url).pathname);
const testId = randomBytes(12).toString("hex");
const localRoot = await mkdtemp(join(tmpdir(), "pi-teleport-failure-decoy-"));
const originalCwd = process.cwd();
const evidencePath = `failure-${testId}.txt`;
const readyPath = `failure-${testId}.ready`;
const remoteEvidencePath = `/workspace/${evidencePath}`;
const remoteReadyPath = `/workspace/${readyPath}`;
const localEvidencePath = join(localRoot, evidencePath);

await writeFile(localEvidencePath, "local-decoy");
process.chdir(localRoot);

try {
	await ensureEndpointRunning();
	await checkWorkerLoss();
	await checkMasterLoss();
	await checkEndpointLoss();
	assert.equal(await readFile(localEvidencePath, "utf8"), "local-decoy");
	console.log("teleport failure injection smoke passed");
} finally {
	process.chdir(originalCwd);
	try {
		await ensureEndpointRunning();
		try {
			const cleanup = await connect();
			try {
				await cleanup.workspace.remove(remoteEvidencePath, { force: true });
				await cleanup.workspace.remove(remoteReadyPath, { force: true });
			} finally {
				await close(cleanup);
			}
		} catch {
			// The primary failure is more useful than a secondary remote cleanup diagnostic.
		}
	} finally {
		await rm(localRoot, { recursive: true, force: true });
	}
}

async function checkWorkerLoss(): Promise<void> {
	const connection = await connect();
	try {
		const request = connection.workspace.exec(`printf w >> ${quotePosix(remoteEvidencePath)}; kill -KILL "$PPID"`);
		await assert.rejects(() => request.promise, /Worker transport closed|protocol stream ended|closed/);
		await assert.rejects(() => connection.workspace.read(evidencePath));
	} finally {
		await close(connection);
	}
	await assertEvidence("w");
	await removeRemotePath(connection.remoteDirectory);
}

async function checkMasterLoss(): Promise<void> {
	await resetEvidence();
	const connection = await connect();
	try {
		const request = connection.workspace.exec(
			`printf m >> ${quotePosix(remoteEvidencePath)}; printf ready > ${quotePosix(remoteReadyPath)}; sleep 30`,
		);
		void request.promise.catch(() => {});
		await waitForRemoteFile(connection.workspace, remoteReadyPath);
		await connection.master.close();
		await assert.rejects(() => request.promise, /Worker transport closed|protocol stream ended|closed/);
		await assert.rejects(() => connection.workspace.read(evidencePath));
	} finally {
		await close(connection);
	}
	await assertEvidence("m");
	await removeRemotePath(connection.remoteDirectory);
}

async function checkEndpointLoss(): Promise<void> {
	await resetEvidence();
	const connection = await connect();
	try {
		const request = connection.workspace.exec(
			`printf e >> ${quotePosix(remoteEvidencePath)}; printf ready > ${quotePosix(remoteReadyPath)}; sleep 30`,
		);
		void request.promise.catch(() => {});
		await waitForRemoteFile(connection.workspace, remoteReadyPath);
		execFileSync("docker", ["kill", container], { stdio: "ignore" });
		await assert.rejects(() => request.promise, /Worker transport closed|protocol stream ended|closed/);
		await assert.rejects(() => connection.workspace.read(evidencePath));
	} finally {
		await close(connection);
	}
	await ensureEndpointRunning();
	await assertEvidence("e");
	await removeRemotePath(connection.remoteDirectory);
}

async function assertEvidence(expected: string): Promise<void> {
	const connection = await connect();
	try {
		assert.equal((await connection.workspace.read(remoteEvidencePath)).toString("utf8"), expected);
		assert.equal(await readFile(localEvidencePath, "utf8"), "local-decoy");
	} finally {
		await close(connection);
	}
}

async function resetEvidence(): Promise<void> {
	const connection = await connect();
	try {
		await connection.workspace.remove(remoteEvidencePath, { force: true });
		await connection.workspace.remove(remoteReadyPath, { force: true });
	} finally {
		await close(connection);
	}
}

async function removeRemotePath(path: string): Promise<void> {
	const connection = await connect();
	try {
		await connection.workspace.remove(path, { recursive: true, force: true });
	} finally {
		await close(connection);
	}
}

interface Connection {
	master: MasterConnection;
	client: WorkerClient;
	workspace: WorkspaceClient;
	remoteDirectory: string;
}

async function connect(): Promise<Connection> {
	const nonce = randomBytes(16).toString("hex");
	const remoteDirectory = `/tmp/pi-teleport-${nonce}`;
	const remoteWorker = `${remoteDirectory}/worker.mjs`;
	const master = new MasterConnection({
		destination,
		sshConfigPath: configPath,
	});
	let client: WorkerClient | undefined;
	const scratch = new RemoteScratch(master, nonce);
	try {
		await master.start();
		await scratch.create();
		await scratch.installWorker(workerPath);
		const command = `exec node ${quotePosix(remoteWorker)} ${quotePosix(nonce)} ${quotePosix("/workspace")} ${quotePosix(remoteDirectory)}`;
		client = new WorkerClient(master.spawnChannel(command), nonce);
		await client.ready();
		return {
			master,
			client,
			workspace: new WorkspaceClient(client),
			remoteDirectory,
		};
	} catch (error) {
		if (client) await client.close().catch(() => {});
		await scratch.remove().catch(() => {});
		await master.close();
		throw error;
	}
}

async function close(connection: Connection): Promise<void> {
	await connection.client.close().catch(() => {});
	await connection.master.close();
}

async function waitForRemoteFile(workspace: WorkspaceClient, path: string): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		try {
			await workspace.stat(path);
			return;
		} catch (error) {
			if (!(error instanceof WorkerRequestError) || error.code !== "NOT_FOUND") throw error;
		}
		await new Promise((resolveWait) => setTimeout(resolveWait, 25));
	}
	throw new Error(`Timed out waiting for remote file: ${path}`);
}

async function ensureEndpointRunning(): Promise<void> {
	let running = false;
	try {
		running =
			execFileSync("docker", ["container", "inspect", "--format", "{{.State.Running}}", container], {
				encoding: "utf8",
			}).trim() === "true";
	} catch {
		throw new Error(`Test container does not exist: ${container}`);
	}
	if (!running) execFileSync("docker", ["start", container], { stdio: "ignore" });
	await refreshFixturePort();

	for (let attempt = 0; attempt < 100; attempt += 1) {
		try {
			execFileSync("/usr/bin/ssh", ["-F", configPath, "-o", "ConnectTimeout=1", destination, "true"], {
				stdio: "ignore",
			});
			return;
		} catch {
			await new Promise((resolveWait) => setTimeout(resolveWait, 50));
		}
	}
	throw new Error("Timed out waiting for restarted test endpoint");
}

async function refreshFixturePort(): Promise<void> {
	const port = execFileSync(
		"docker",
		["container", "inspect", "--format", '{{(index (index .NetworkSettings.Ports "2222/tcp") 0).HostPort}}', container],
		{ encoding: "utf8" },
	).trim();
	if (!/^[0-9]+$/.test(port)) throw new Error(`Test container has no published SSH port: ${port}`);
	const config = await readFile(configPath, "utf8");
	const matches = config.match(/^\s*Port\s+[0-9]+\s*$/gm) ?? [];
	if (matches.length !== 1) throw new Error("Isolated SSH config must contain exactly one Port line");
	await writeFile(configPath, config.replace(/^\s*Port\s+[0-9]+\s*$/m, `  Port ${port}`));

	for (let attempt = 0; attempt < 100; attempt += 1) {
		try {
			const hostKey = execFileSync("ssh-keyscan", ["-T", "1", "-p", port, "127.0.0.1"], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			});
			if (hostKey.trim()) {
				await writeFile(join(fixtureDirectory, "known_hosts"), hostKey, {
					mode: 0o600,
				});
				return;
			}
		} catch {
			// sshd may not yet be listening after the container restart.
		}
		await new Promise((resolveWait) => setTimeout(resolveWait, 50));
	}
	throw new Error("Timed out refreshing the isolated fixture host key");
}
