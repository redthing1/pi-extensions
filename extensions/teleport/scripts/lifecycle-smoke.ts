import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { TeleportConnection } from "../transport/connection.ts";
import { MasterConnection, quotePosix } from "../transport/master.ts";
import { encodeFrame, FRAME, PROTOCOL_VERSION } from "../transport/protocol.ts";

const { values } = parseArgs({ options: { config: { type: "string" } } });
if (!values.config) throw new Error("--config must name an isolated fixture configuration");
const config = resolve(values.config);
assert.equal((await readFile(join(dirname(config), ".fixture-marker"), "utf8")).trim(), "pi-teleport-isolated-fixture");
const localRoot = await mkdtemp(join(tmpdir(), "pi-teleport-lifecycle-"));
const observer = new MasterConnection({ destination: "teleport-test", sshConfigPath: config });
const connections: TeleportConnection[] = [];
const ownedRemote = new Set<string>();
const failures: Error[] = [];
const cleanupFailures: Error[] = [];
function connection(borrowedSocketPath?: string): TeleportConnection {
	const result = new TeleportConnection({
		destination: "teleport-test",
		sshConfigPath: config,
		borrowedSocketPath,
		onFailure: (error) => failures.push(error),
		onCleanupFailure: (error) => cleanupFailures.push(error),
	});
	connections.push(result);
	ownedRemote.add(result.scratch.path);
	return result;
}
async function remote(command: string): Promise<string> {
	const result = await observer.run(command);
	assert.equal(result.code, 0, result.stderr);
	return result.stdout;
}
async function gone(path: string): Promise<void> {
	await remote(`test ! -e ${quotePosix(path)} && test ! -L ${quotePosix(path)}`);
}
async function waitForFile(path: string): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if ((await observer.run(`test -f ${quotePosix(path)}`)).code === 0) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error("The synthetic operation did not reach its ready marker");
}

try {
	await observer.start();
	const parent = connection();
	await parent.start("/workspace");
	const localSocketDirectory = dirname(parent.master.handoff().socketPath);
	assert.deepEqual(
		(await parent.workspace.list(parent.scratch.path)).entries.map(({ name }) => name),
		[".owner"],
		"loaded worker sources must already be removed",
	);
	await assert.rejects(() => parent.workspace.exec("head -c 34603008 /dev/zero").promise, /32MB limit/);
	assert.deepEqual(
		(await parent.workspace.list(parent.scratch.path)).entries.map(({ name }) => name),
		[".owner"],
		"failed overflow must be discarded immediately",
	);
	const gate = `${parent.scratch.path}/capture-gate`;
	const failedCapture = parent.workspace.exec(
		`head -c 60000 /dev/zero; while [ ! -f ${quotePosix(gate)} ]; do sleep 0.02; done; chmod 500 ${quotePosix(parent.scratch.path)}; head -c 34603008 /dev/zero`,
	);
	const captureFailure = assert.rejects(failedCapture.promise, /temporary output could not be removed/);
	const failedOutput = `${parent.scratch.path}/output-${failedCapture.id}.log`;
	try {
		await waitForFile(failedOutput);
		await parent.workspace.write(gate, Buffer.alloc(0));
		await captureFailure;
	} finally {
		await remote(`chmod 700 ${quotePosix(parent.scratch.path)}`);
	}
	await parent.workspace.remove(failedOutput);
	await parent.workspace.remove(gate);
	await parent.workspace.stat("/workspace"); // A cleanup error must settle the request, not hang or crash the worker.
	const child = connection(parent.master.handoff().socketPath);
	await child.start("/workspace");
	assert.notEqual(child.scratch.path, parent.scratch.path);
	await child.close();
	await gone(child.scratch.path);
	assert((await parent.master.check()).ok);
	await parent.workspace.stat("/workspace");
	await parent.close();
	await parent.close();
	await gone(parent.scratch.path);
	assert(!existsSync(localSocketDirectory));
	const missingSocket = new MasterConnection({ destination: "teleport-test", sshConfigPath: config });
	await missingSocket.start();
	const missingSocketPath = missingSocket.handoff().socketPath;
	// Keep the authenticated master alive but remove its socket name. A session
	// must fail instead of independently using host config to reconnect.
	await rm(missingSocketPath);
	const fallback = await missingSocket.run("printf unexpected-direct-connection");
	assert.notEqual(fallback.code, 0);
	assert.equal(fallback.stdout, "");
	await missingSocket.close();

	const invalidCwd = connection();
	await assert.rejects(
		() => invalidCwd.start(`/missing-teleport-fixture-${randomBytes(8).toString("hex")}`),
		/ENOENT|closed|protocol stream ended/,
	);
	await gone(invalidCwd.scratch.path);

	const uploadFailure = connection();
	const upload = uploadFailure.master.upload.bind(uploadFailure.master);
	let uploads = 0;
	uploadFailure.master.upload = async (source, destination) => {
		if (++uploads === 2) throw new Error("synthetic partial upload failure");
		await upload(source, destination);
	};
	await assert.rejects(() => uploadFailure.start("/workspace"), /partial upload failure/);
	await gone(uploadFailure.scratch.path);

	const malformed = connection();
	const fake = join(localRoot, "worker.mjs");
	const frame = encodeFrame(FRAME.ready, { nonce: "wrong", protocolVersion: PROTOCOL_VERSION });
	await writeFile(
		fake,
		`process.stdout.write(Buffer.from(${JSON.stringify(frame.toString("base64"))}, "base64")); process.stdin.resume(); process.stdin.on("end", () => process.exit(0));\n`,
		{ mode: 0o600 },
	);
	const actualUpload = malformed.master.upload.bind(malformed.master);
	malformed.master.upload = (source, destination) =>
		actualUpload(destination.endsWith("/worker.mjs") ? fake : source, destination);
	await assert.rejects(() => malformed.start("/workspace"), /handshake is invalid/);
	await gone(malformed.scratch.path);
	const waitingHandshake = connection();
	await writeFile(fake, "process.stdin.resume(); process.stdin.on('end', () => process.exit(0));\n");
	const waitingUpload = waitingHandshake.master.upload.bind(waitingHandshake.master);
	waitingHandshake.master.upload = (source, destination) =>
		waitingUpload(destination.endsWith("/worker.mjs") ? fake : source, destination);
	let spawned!: () => void;
	const spawnedChannel = new Promise<void>((resolve) => {
		spawned = resolve;
	});
	const spawnChannel = waitingHandshake.master.spawnChannel.bind(waitingHandshake.master);
	waitingHandshake.master.spawnChannel = (command) => {
		const channel = spawnChannel(command);
		if (command.startsWith("exec 3>&1")) spawned();
		return channel;
	};
	const waitingStart = assert.rejects(waitingHandshake.start("/workspace"), /closed|closing|ended/);
	await spawnedChannel;
	await waitingHandshake.close();
	await waitingStart;
	await gone(waitingHandshake.scratch.path);

	const killedWorker = connection();
	await killedWorker.start("/workspace");
	const killedSocketDirectory = dirname(killedWorker.master.handoff().socketPath);
	await assert.rejects(() => killedWorker.workspace.exec('kill -KILL "$PPID"').promise, /closed|protocol stream ended/);
	await killedWorker.close();
	await gone(killedWorker.scratch.path);
	assert(!existsSync(killedSocketDirectory));
	const hungUp = connection();
	await hungUp.start("/workspace");
	try {
		const result = await hungUp.workspace.exec('kill -HUP "$PPID"; sleep 30').promise;
		assert(result.cancelled, "hangup must stop the owned command");
	} catch (error) {
		assert.match(String(error), /closed|protocol stream ended/);
	}
	await hungUp.close();
	await gone(hungUp.scratch.path);

	const redirected = connection();
	await redirected.start("/workspace");
	const backup = `${redirected.scratch.path}.original`;
	const decoy = `${redirected.scratch.path}.decoy`;
	ownedRemote.add(backup);
	ownedRemote.add(decoy);
	await remote(
		`mkdir -- ${quotePosix(decoy)} && printf %s sentinel > ${quotePosix(`${decoy}/sentinel`)} && mv -- ${quotePosix(redirected.scratch.path)} ${quotePosix(backup)} && ln -s -- ${quotePosix(decoy)} ${quotePosix(redirected.scratch.path)}`,
	);
	const redirectSocketDirectory = dirname(redirected.master.handoff().socketPath);
	await assert.rejects(() => redirected.close(), /cleanup was incomplete/);
	assert(!existsSync(redirectSocketDirectory), "local cleanup must complete despite a remote cleanup failure");
	assert.equal(await remote(`cat -- ${quotePosix(`${decoy}/sentinel`)}`), "sentinel");

	const lostMaster = connection();
	await lostMaster.start("/workspace");
	const evidence = `/workspace/teleport-lifecycle-${randomBytes(8).toString("hex")}.txt`;
	ownedRemote.add(evidence);
	const ready = `${lostMaster.scratch.path}/ready`;
	const request = lostMaster.workspace.exec(
		`printf x >> ${quotePosix(evidence)}; printf ready > ${quotePosix(ready)}; sleep 30`,
	);
	void request.promise.catch(() => {});
	await waitForFile(ready);
	await lostMaster.master.close();
	await assert.rejects(() => request.promise, /closed|protocol stream ended/);
	await assert.rejects(() => lostMaster.close(), /cleanup was incomplete/);
	assert.equal(await remote(`cat -- ${quotePosix(evidence)}`), "x", "uncertain operations must not be replayed");
	assert(failures.length >= 3);
	console.log(
		"teleport lifecycle smoke passed: source retirement, child ownership, early/partial startup, malformed handshake, worker loss, scoped cleanup refusal, master loss, and no replay",
	);
} finally {
	await Promise.allSettled(connections.map((connection) => connection.close()));
	// These exact paths were allocated by this test in its disposable endpoint.
	// No discovery, user-state inspection, or cleanup by directory pattern.
	for (const path of ownedRemote) await observer.run(`rm -rf -- ${quotePosix(path)}`).catch(() => {});
	await observer.close();
	await rm(localRoot, { recursive: true, force: true });
}
