import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { MasterConnection, quotePosix } from "../transport/master.ts";
import { RemoteScratch } from "../transport/scratch.ts";
import { WorkerClient, WorkerRequestError } from "../transport/worker-client.ts";
import { WorkspaceClient } from "../workspace/client.ts";
import { RemoteMutationQueue } from "../workspace/mutation-queue.ts";

const { values } = parseArgs({
	options: {
		config: { type: "string" },
		destination: { type: "string", default: "teleport-test" },
		worker: { type: "string" },
	},
});

if (!values.config) throw new Error("--config is required");
if (
	(await readFile(join(resolve(values.config), "..", ".fixture-marker"), "utf8")).trim() !==
	"pi-teleport-isolated-fixture"
)
	throw new Error("An isolated SSH fixture is required");
const workerPath = resolve(values.worker ?? new URL("../worker/worker.mjs", import.meta.url).pathname);
const nonce = randomBytes(16).toString("hex");
const remoteDirectory = `/tmp/pi-teleport-${nonce}`;
const remoteWorker = `${remoteDirectory}/worker.mjs`;
const master = new MasterConnection({
	destination: values.destination,
	sshConfigPath: resolve(values.config),
});
const scratch = new RemoteScratch(master, nonce);
const originalCwd = process.cwd();
const localRoot = await mkdtemp(join(tmpdir(), "pi-teleport-local-decoy-"));
const workspaceRoot = `teleport-smoke-${nonce}`;
const hostileName = "space ' dollar$ newline\n雪.bin";
const binaryContent = Buffer.from([0, 1, 2, 10, 39, 36, 127, 128, 255]);

await mkdir(join(localRoot, workspaceRoot), { recursive: true });
await writeFile(join(localRoot, workspaceRoot, hostileName), "local-decoy");
process.chdir(localRoot);

try {
	await master.start();
	const check = await master.check();
	if (!check.ok) throw new Error(`Master check failed: ${check.output}`);
	await scratch.create();
	await scratch.installWorker(workerPath);

	const command = `exec node ${quotePosix(remoteWorker)} ${quotePosix(nonce)} ${quotePosix("/workspace")} ${quotePosix(remoteDirectory)}`;
	const workerProcess = master.spawnChannel(command);
	let workerStderr = "";
	workerProcess.stderr.on("data", (chunk: Buffer) => {
		workerStderr = `${workerStderr}${chunk.toString("utf8")}`.slice(-8_192);
	});
	const client = new WorkerClient(workerProcess, nonce);
	const ready = await client.ready();
	assert.equal(ready.cwd, "/workspace");
	assert.deepEqual(ready.capabilities, { find: true, grep: true });
	const workspace = new WorkspaceClient(client);

	const ping = await client.request("ping", {}).promise;
	const sentinel = await workspace.read("sentinel.txt");
	assert.equal(sentinel.toString("utf8"), "remote-sentinel\n");
	const globalContextPath = `${ready.home}/.pi/agent/AGENTS.override.md`;
	await assert.rejects(
		() => workspace.stat(globalContextPath),
		(error) => error instanceof WorkerRequestError && error.code === "NOT_FOUND",
	);
	await workspace.write(globalContextPath, Buffer.from("remote global context\n", "utf8"));
	await workspace.write("AGENTS.md", Buffer.from("remote context\n", "utf8"));
	assert.deepEqual(await workspace.context(), [
		{ path: globalContextPath, content: "remote global context\n" },
		{ path: "/workspace/AGENTS.md", content: "remote context\n" },
	]);
	const skillPrefix = `teleport-${nonce.slice(0, 12)}`;
	const projectPiSkill = `/workspace/.pi/skills/${skillPrefix}-project.md`;
	const projectAgentsSkill = `/workspace/.agents/skills/${skillPrefix}/project.md`;
	const userPiSkill = `${ready.home}/.pi/agent/skills/${skillPrefix}-user.md`;
	const userAgentsSkill = `${ready.home}/.agents/skills/${skillPrefix}/user.md`;
	await workspace.write(projectPiSkill, Buffer.from(skillDocument(`${skillPrefix}-project`, "project pi"), "utf8"));
	await workspace.write(
		projectAgentsSkill,
		Buffer.from(skillDocument(`${skillPrefix}-project-agents`, "project agents"), "utf8"),
	);
	await workspace.write(userPiSkill, Buffer.from(skillDocument(`${skillPrefix}-user`, "user pi"), "utf8"));
	await workspace.write(
		userAgentsSkill,
		Buffer.from(skillDocument(`${skillPrefix}-user-agents`, "user agents"), "utf8"),
	);
	const skillDocuments = (await workspace.skills()).filter((document) => document.path.includes(skillPrefix));
	assert.deepEqual(
		skillDocuments.map(({ path, scope }) => ({ path, scope })),
		[
			{ path: projectPiSkill, scope: "project" },
			{ path: projectAgentsSkill, scope: "project" },
			{ path: userPiSkill, scope: "user" },
			{ path: userAgentsSkill, scope: "user" },
		],
	);
	assert(skillDocuments.every((document) => document.content.includes("REMOTE SKILL BODY")));
	const projectPrompt = `/workspace/.pi/prompts/${skillPrefix}.md`;
	const userPrompt = `${ready.home}/.pi/agent/prompts/${skillPrefix}.md`;
	await workspace.write(projectPrompt, Buffer.from("PROJECT REMOTE PROMPT\n"));
	await workspace.write(userPrompt, Buffer.from("USER REMOTE PROMPT\n"));
	const promptDocuments = (await workspace.prompts()).filter((document) => document.path.includes(skillPrefix));
	assert.deepEqual(promptDocuments, [
		{ path: projectPrompt, content: "PROJECT REMOTE PROMPT\n", scope: "project" },
		{ path: userPrompt, content: "USER REMOTE PROMPT\n", scope: "user" },
	]);
	await workspace.write(`${workspaceRoot}/image.png`, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
	assert.equal(await workspace.mime(`${workspaceRoot}/image.png`), "image/png");
	assert.equal(await workspace.mime("sentinel.txt"), null);

	await workspace.write(`${workspaceRoot}/${hostileName}`, binaryContent);
	assert.deepEqual(await workspace.read(`${workspaceRoot}/${hostileName}`), binaryContent);
	const metadata = await workspace.stat(`${workspaceRoot}/${hostileName}`);
	assert.equal(metadata.kind, "file");
	assert.equal(metadata.bytes, binaryContent.length);
	const canonical = await workspace.canonicalize(`${workspaceRoot}/${hostileName}`);
	assert.equal(canonical, `/workspace/${workspaceRoot}/${hostileName}`);
	const listing = await workspace.list(workspaceRoot);
	assert.equal(listing.truncated, false);
	assert(listing.entries.some((entry) => entry.name === hostileName && entry.kind === "file"));

	const searchPath = `${workspaceRoot}/search target.txt`;
	const renamedPath = `${workspaceRoot}/renamed target.txt`;
	await workspace.write(searchPath, Buffer.from("first line\nteleport-search-token\n", "utf8"));
	const grep = await workspace.grep({
		pattern: "teleport-search-token",
		path: workspaceRoot,
		literal: true,
	});
	assert.match(grep, /teleport-search-token/);
	const found = await workspace.find({ pattern: "*.txt", path: workspaceRoot });
	assert(found.some((path) => path.endsWith("search target.txt")));
	await workspace.rename(searchPath, renamedPath);
	await assert.rejects(
		() => workspace.stat(searchPath),
		(error) => error instanceof WorkerRequestError && error.code === "NOT_FOUND",
	);
	assert.equal((await workspace.stat(renamedPath)).kind, "file");
	assert.equal(await readFile(join(localRoot, workspaceRoot, hostileName), "utf8"), "local-decoy");

	await workspace.mkdir(`${workspaceRoot}/real`);
	const link = workspace.exec(
		`ln -s -- ${quotePosix(`/workspace/${workspaceRoot}/real`)} ${quotePosix(`/workspace/${workspaceRoot}/alias`)}`,
	);
	assert.equal((await link.promise).exitCode, 0);
	const queue = new RemoteMutationQueue(workspace);
	const order: string[] = [];
	let markStarted = (): void => {};
	const started = new Promise<void>((resolveStarted) => {
		markStarted = resolveStarted;
	});
	let releaseFirst = (): void => {};
	const holdFirst = new Promise<void>((resolveFirst) => {
		releaseFirst = resolveFirst;
	});
	const first = queue.run(`/workspace/${workspaceRoot}/alias/shared.txt`, async () => {
		order.push("first-start");
		markStarted();
		await holdFirst;
		order.push("first-end");
	});
	await started;
	const second = queue.run(`/workspace/${workspaceRoot}/real/shared.txt`, async () => {
		order.push("second-start");
	});
	await new Promise((resolveWait) => setTimeout(resolveWait, 50));
	assert.deepEqual(order, ["first-start"]);
	releaseFirst();
	await Promise.all([first, second]);
	assert.deepEqual(order, ["first-start", "first-end", "second-start"]);

	const isolatedRoot = `/tmp/pi-ultra-isolation-${nonce}`;
	const isolated = await workspace.prepareIsolatedWorkspace({
		namespace: "ultra",
		date: "2026-08-26",
		id: `ultra-${nonce}`,
		root: isolatedRoot,
		source: `/workspace/${workspaceRoot}`,
		mode: "copy",
		retention: "ephemeral",
		stages: ["attempt-01", "attempt-02", "synthesis"],
	});
	assert.match(isolated.digest, /^[a-f0-9]{64}$/u);
	assert.equal(
		(await workspace.read(`${isolated.stages["attempt-01"]}/renamed target.txt`)).toString("utf8"),
		"first line\nteleport-search-token\n",
	);
	await workspace.write(`${isolated.stages["attempt-01"]}/candidate.txt`, Buffer.from("first\n"));
	await assert.rejects(() => workspace.stat(`${isolated.stages["attempt-02"]}/candidate.txt`), /NOT_FOUND/u);
	await assert.rejects(() => workspace.stat(`/workspace/${workspaceRoot}/candidate.txt`), /NOT_FOUND/u);
	await workspace.remove(isolatedRoot, { recursive: true, force: true });

	const output: string[] = [];
	const execRequest = workspace.exec("printf 'stdout-ok'; printf 'stderr-ok' >&2", (stream, chunk) => {
		output.push(`${stream}:${chunk.toString("utf8")}`);
	});
	const exec = await execRequest.promise;
	assert.deepEqual(exec, { exitCode: 0, signal: null, cancelled: false });
	const largeOutput = await workspace.exec(`node -e ${quotePosix("process.stdout.write('x'.repeat(60 * 1024))")}`)
		.promise;
	assert.equal(largeOutput.exitCode, 0);
	const fullOutputPath = largeOutput.fullOutputPath;
	if (!fullOutputPath) throw new Error("Large command output was not persisted remotely");
	assert(fullOutputPath.startsWith(`${remoteDirectory}/output-`));
	assert.equal((await workspace.read(fullOutputPath)).length, 60 * 1024);
	assert.equal((await workspace.stat(fullOutputPath)).mode & 0o777, 0o600);
	await assert.rejects(
		() =>
			client.request(
				"save_output",
				{ prefix: "fixture", extension: ".txt" },
				undefined,
				Buffer.from("local-only canary"),
			).promise,
		/unsupported operation/,
	);

	const long = workspace.exec("sleep 30 & child=$!; wait $child");
	await new Promise((resolveWait) => setTimeout(resolveWait, 250));
	const cancel = await workspace.cancel(long.id);
	const cancelled = await long.promise;
	assert.equal(cancel, true);
	assert.equal(cancelled.cancelled, true);

	const stubbornPidPath = `${remoteDirectory}/stubborn.pid`;
	const stubborn = workspace.exec(
		`trap '' TERM; while :; do sleep 30; done & child=$!; printf %s "$child" > ${quotePosix(stubbornPidPath)}; wait "$child"`,
	);
	await waitForRemoteFile(workspace, stubbornPidPath);
	assert.equal(await workspace.cancel(stubborn.id), true);
	assert.equal((await stubborn.promise).cancelled, true);
	const stubbornGone = workspace.exec(`pid=$(cat ${quotePosix(stubbornPidPath)}); ! kill -0 "$pid" 2>/dev/null`);
	assert.equal((await stubbornGone.promise).exitCode, 0);

	await workspace.remove(workspaceRoot, { recursive: true });
	await workspace.remove("AGENTS.md");
	await workspace.remove(globalContextPath);
	await workspace.remove(projectPiSkill);
	await workspace.remove(`/workspace/.agents/skills/${skillPrefix}`, {
		recursive: true,
	});
	await workspace.remove(userPiSkill);
	await workspace.remove(`${ready.home}/.agents/skills/${skillPrefix}`, {
		recursive: true,
	});
	await workspace.remove(projectPrompt);
	await workspace.remove(userPrompt);
	await assert.rejects(() => workspace.stat(workspaceRoot), /NOT_FOUND/);

	const shutdownPidPath = `${remoteDirectory}/shutdown-stubborn.pid`;
	const shutdownStubborn = workspace.exec(
		`trap '' TERM; while :; do sleep 30; done & child=$!; printf %s "$child" > ${quotePosix(shutdownPidPath)}; wait "$child"`,
	);
	void shutdownStubborn.promise.catch(() => {});
	await waitForRemoteFile(workspace, shutdownPidPath);
	const shutdownPid = (await workspace.read(shutdownPidPath)).toString("utf8").trim();
	assert.match(shutdownPid, /^[0-9]+$/);
	await client.close();
	const cleanupCheck = master.spawnChannel(
		`test ! -e ${quotePosix(remoteDirectory)} && ! kill -0 ${shutdownPid} 2>/dev/null`,
	);
	cleanupCheck.stdin.end();
	cleanupCheck.stdout.resume();
	cleanupCheck.stderr.resume();
	const cleanupCode = await new Promise<number | null>((resolveCleanup) => {
		cleanupCheck.once("close", resolveCleanup);
	});
	assert.equal(cleanupCode, 0);
	if (workerStderr.trim()) throw new Error(`Worker stderr was not empty: ${workerStderr.trim()}`);

	console.log(
		JSON.stringify({
			ready,
			ping: ping.result,
			workspace: {
				binaryBytes: metadata.bytes,
				canonical,
				findCount: found.length,
				localDecoy: "unchanged",
			},
			exec,
			largeOutput,
			output,
			cancel,
			cancelled,
		}),
	);
} finally {
	process.chdir(originalCwd);
	await rm(localRoot, { recursive: true, force: true });
	await scratch.remove();
	await master.close();
}

function skillDocument(name: string, description: string): string {
	return `---\nname: ${name}\ndescription: ${description}\n---\n\nREMOTE SKILL BODY\n`;
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
