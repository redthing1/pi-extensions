import { strict as assert } from "node:assert";
import { mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { SessionOutputs } from "../outputs.ts";
import type { WorkspaceClient } from "../workspace/client.ts";

const parent = await mkdtemp(join(tmpdir(), "pi-teleport-output-contract-"));
const store = new SessionOutputs(parent);
const other = new SessionOutputs(parent);
let reader: ((params: Record<string, unknown>) => Promise<AgentToolResult<unknown>>) | undefined;
store.register({
	registerTool(tool) {
		reader = (params) =>
			tool.execute("fixture", params as Parameters<typeof tool.execute>[1], undefined, undefined, {
				cwd: "/",
			} as ExtensionToolContext);
	},
});
const invoke = (reference: string, extra: Record<string, unknown> = {}) => {
	assert(reader);
	return reader({ reference, ...extra });
};

try {
	const reference = await store.save("fixture", ".txt", "α\nsecond\nthird\n");
	assert.match(reference, /^pi-output:[a-f0-9]{32}$/u);
	assert(!reference.includes(parent));
	const result = await invoke(reference, { offset: 2, limit: 1 });
	assert.equal(result.content[0]?.type === "text" && result.content[0].text.split("\n")[0], "second");
	const binary = Buffer.from([0, 255, 1, 2, 128]);
	const binaryReference = await store.save("fixture", ".bin", binary);
	const encoded = await invoke(binaryReference, { encoding: "base64", offset: 2, limit: 3 });
	assert.equal(
		encoded.content[0]?.type === "text" && encoded.content[0].text,
		binary.subarray(1, 4).toString("base64"),
	);
	await assert.rejects(
		() => invoke(binaryReference, { encoding: "base64", limit: 32769 }),
		/Invalid output byte range/,
	);
	await invoke(binaryReference, { encoding: "base64", release: true });
	await assert.rejects(() => invoke(binaryReference), /Unknown or expired/);
	const imageReference = await store.save(
		"fixture",
		".png",
		Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
			"base64",
		),
	);
	const image = await invoke(imageReference, { release: true });
	assert(image.content.some((part) => part.type === "image" && part.mimeType === "image/png"));
	await assert.rejects(() => invoke(imageReference), /Unknown or expired/);
	const longReference = await store.save("fixture", ".txt", "x".repeat(70_000));
	const longResult = await invoke(longReference);
	assert(longResult.content.some((part) => part.type === "text" && part.text.includes("encoding=base64")));
	await invoke(longReference, { encoding: "base64", limit: 8, release: true });
	const remoteDirectory = `/tmp/pi-teleport-${"a".repeat(32)}`;
	const removed: string[] = [];
	const remote = store.attachRemote(
		{
			read: async () => Buffer.from("remote fixture\n"),
			stat: async () => ({ kind: "file" }),
			mime: async () => null,
			remove: async (path: string) => {
				removed.push(path);
			},
		} as unknown as WorkspaceClient,
		remoteDirectory,
	);
	for (const path of [
		"/etc/passwd",
		`${remoteDirectory}/../output-r1.log`,
		`${remoteDirectory}/nested/output-r1.log`,
		`${remoteDirectory}/output-r0.log`,
	]) {
		await assert.rejects(() => remote.registerRemote(path), /invalid output location/);
	}
	assert.equal(removed.length, 0, "invalid locations must never trigger deletion");
	const remoteReference = await remote.registerRemote(`${remoteDirectory}/output-r1.log`);
	const remoteResult = await invoke(remoteReference, { release: true });
	assert(remoteResult.content.some((part) => part.type === "text" && part.text.includes("remote fixture")));
	assert.deepEqual(removed, [`${remoteDirectory}/output-r1.log`]);
	await assert.rejects(() => invoke(remoteReference), /Unknown or expired/);
	const concurrent = await remote.registerRemote(`${remoteDirectory}/output-r3.log`);
	await Promise.all([store.release(concurrent), store.release(concurrent)]);
	assert.equal(
		removed.filter((path) => path.endsWith("/output-r3.log")).length,
		1,
		"concurrent release must dispose one owned output once",
	);
	const lostReference = await remote.registerRemote(`${remoteDirectory}/output-r4.log`);
	remote.invalidate();
	await assert.rejects(() => invoke(lostReference), /Unknown or expired/);
	assert((await invoke(reference)).content.some((part) => part.type === "text" && part.text.includes("second")));
	const replacement = store.attachRemote(
		{
			read: async () => Buffer.from("replacement worker"),
			stat: async () => ({ kind: "file" }),
			mime: async () => null,
		} as unknown as WorkspaceClient,
		`/tmp/pi-teleport-${"b".repeat(32)}`,
	);
	const replacementReference = await replacement.registerRemote(`/tmp/pi-teleport-${"b".repeat(32)}/output-r1.log`);
	remote.invalidate();
	assert(
		(await invoke(replacementReference)).content.some(
			(part) => part.type === "text" && part.text.includes("replacement worker"),
		),
	);
	await assert.rejects(() => remote.registerRemote(`${remoteDirectory}/output-r5.log`), /unavailable/);
	const foreign = await other.save("fixture", ".txt", "other session's fixture");
	for (const invalid of [parent, "/etc/passwd", "../fixture", "pi-output:../../fixture", foreign]) {
		await assert.rejects(() => invoke(invalid), /Unknown or expired/);
	}
	await assert.rejects(() => store.save("../escape", ".txt", "fixture"), /Invalid output/);
	await assert.rejects(() => store.save("fixture", ".txt", new Uint8Array(33 * 1024 * 1024)), /limit exceeded/);
	const directories = await readdir(parent);
	assert.equal(directories.length, 2);
	for (const directory of directories) {
		const path = join(parent, directory);
		assert.equal((await stat(path)).mode & 0o777, 0o700);
		for (const file of await readdir(path)) assert.equal((await stat(join(path, file))).mode & 0o777, 0o600);
	}
	// Replace one registered fixture file with a link to another task-owned file.
	const ownDirectory = (
		await Promise.all(directories.map(async (name) => ({ name, files: await readdir(join(parent, name)) })))
	).find(({ files }) => files.some((name) => name.startsWith(reference.slice(10))));
	assert(ownDirectory);
	const path = join(parent, ownDirectory.name, `${reference.slice(10)}.txt`);
	const decoy = join(parent, "decoy");
	await writeFile(decoy, "synthetic local decoy");
	await rm(path);
	await symlink(decoy, path);
	await assert.rejects(() => invoke(reference), /unavailable/);
	const pending = store.save("fixture", ".txt", "pending output");
	await store.close();
	await pending;
	await assert.rejects(() => invoke(binaryReference), /Unknown or expired/);
	await assert.rejects(() => store.save("fixture", ".txt", "late output"), /unavailable/);
	await assert.rejects(() => remote.registerRemote(`${remoteDirectory}/output-r2.log`), /unavailable/);
	assert.deepEqual(
		removed,
		[
			`${remoteDirectory}/output-r1.log`,
			`${remoteDirectory}/output-r3.log`,
			`${remoteDirectory}/output-r5.log`,
			`${remoteDirectory}/output-r2.log`,
		],
		"unregisterable overflow must not be orphaned",
	);
	assert.equal(await readFile(decoy, "utf8"), "synthetic local decoy");
	assert(!(await readdir(parent)).includes(ownDirectory.name));
	console.log(
		"teleport local output checks passed: scoped references, bounded reads, private storage, links, and teardown",
	);
} finally {
	await Promise.allSettled([store.close(), other.close()]);
	await rm(parent, { recursive: true, force: true });
}
