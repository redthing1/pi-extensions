import { execFileSync } from "node:child_process";
import { strict as assert } from "node:assert";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import { createRemoteAutocompleteProvider } from "../autocomplete.ts";
import { teleportCustomPrompt } from "../prompt.ts";
import { hasTeleportMarker, readTeleportMarker, TELEPORT_MARKER_TYPE, type TeleportMarker } from "../session-marker.ts";
import { FRAME, FrameDecoder, encodeFrame } from "../transport/protocol.ts";
import { quotePosix } from "../transport/master.ts";
import { parseTeleportTarget, teleportStartupPath } from "../target.ts";
import { createWorkspaceProvider } from "../workspace/provider.ts";
import type { WorkspaceClient } from "../workspace/client.ts";
import { resolveWorkspacePath } from "../workspace/path.ts";
import "./worker-command-check.ts";
import "./outputs-check.ts";
import "./client-check.ts";
import "./connection-check.ts";
import "./scratch-check.ts";
import "./workspace-check.ts";
import { checkWorkerPaths } from "./worker-paths-check.ts";

function checkTargets(): void {
	assert.deepEqual(parseTeleportTarget("devbox"), { destination: "devbox", requestedPath: undefined });
	assert.deepEqual(parseTeleportTarget("devbox:/srv/project"), {
		destination: "devbox",
		requestedPath: "/srv/project",
	});
	assert.deepEqual(parseTeleportTarget("devbox:project:with:colons"), {
		destination: "devbox",
		requestedPath: "project:with:colons",
	});
	assert.deepEqual(parseTeleportTarget("alice@[2001:db8::1]:/srv/project"), {
		destination: "alice@[2001:db8::1]",
		requestedPath: "/srv/project",
	});
	assert.deepEqual(parseTeleportTarget("devbox:"), { destination: "devbox", requestedPath: "" });
	assert.equal(teleportStartupPath(parseTeleportTarget("devbox")), ".");
	assert.equal(teleportStartupPath(parseTeleportTarget("devbox:")), ".");
	assert.equal(teleportStartupPath(parseTeleportTarget("devbox:~")), "~");
	assert.equal(teleportStartupPath(parseTeleportTarget("devbox:/srv/project")), "/srv/project");

	for (const value of [
		"",
		":/srv",
		"-oProxyCommand=bad:/srv",
		"bad host:/srv",
		"[2001:db8::1",
		"2001:db8::1",
		"alice@::1",
	]) {
		assert.throws(() => parseTeleportTarget(value), `target ${JSON.stringify(value)}`);
	}
}

function checkProtocol(): void {
	const encoded = encodeFrame(FRAME.result, { id: "r1", result: { ok: true } }, Buffer.from([0, 1, 2, 255]));
	for (let split = 0; split <= encoded.length; split += 1) {
		const decoder = new FrameDecoder();
		const frames = [...decoder.push(encoded.subarray(0, split)), ...decoder.push(encoded.subarray(split))];
		decoder.finish();
		assert.equal(frames.length, 1);
		assert.equal(frames[0]?.type, FRAME.result);
		assert.deepEqual(frames[0]?.header, { id: "r1", result: { ok: true } });
		assert.deepEqual(frames[0]?.payload, Buffer.from([0, 1, 2, 255]));
	}

	const decoder = new FrameDecoder();
	const combined = Buffer.concat([
		encodeFrame(FRAME.data, { id: "r1", stream: "stdout" }, Buffer.from("one")),
		encodeFrame(FRAME.result, { id: "r1", result: { exitCode: 0 } }),
	]);
	const frames = decoder.push(combined);
	decoder.finish();
	assert.equal(frames.length, 2);
	assert.equal(frames[0]?.payload.toString("utf8"), "one");

	const unknownType = Buffer.from(encoded);
	unknownType.writeUInt8(255, 0);
	assert.throws(() => new FrameDecoder().push(unknownType), /Unknown protocol frame type/);

	const oversizedPayload = Buffer.alloc(13);
	oversizedPayload.writeUInt8(FRAME.result, 0);
	oversizedPayload.writeUInt32BE(0, 1);
	oversizedPayload.writeBigUInt64BE(BigInt(32 * 1024 * 1024 + 1), 5);
	assert.throws(() => new FrameDecoder().push(oversizedPayload), /payload exceeds limit/);

	const partial = new FrameDecoder();
	partial.push(encoded.subarray(0, encoded.length - 1));
	assert.throws(() => partial.finish(), /partial frame/);
	assert.throws(() => encodeFrame(FRAME.request, { text: "x".repeat(70_000) }), /header exceeds limit/);
}

function checkQuoting(): void {
	for (const value of ["simple", "space here", "single'quote", "$dollar", "`backtick`", "line\nbreak", "雪"]) {
		const output = execFileSync("/bin/sh", ["-c", `printf %s ${quotePosix(value)}`]);
		assert.equal(output.toString("utf8"), value);
	}
	assert.throws(() => quotePosix("nul\0byte"), /NUL/);
}

function checkWorkspacePaths(): void {
	const location = { cwd: "/workspace/project", home: "/home/remote" };
	assert.equal(resolveWorkspacePath("file.txt", location), "/workspace/project/file.txt");
	assert.equal(resolveWorkspacePath("~/file.txt", location), "/home/remote/file.txt");
	assert.equal(resolveWorkspacePath("~", location), "/home/remote");
	assert.equal(resolveWorkspacePath("@/tmp/file.txt", location), "/tmp/file.txt");
	assert.equal(resolveWorkspacePath("space\u202ffile.txt", location), "/workspace/project/space file.txt");
	assert.throws(() => resolveWorkspacePath("nul\0path", location), /Invalid workspace path/u);
}

function checkSessionMarkers(): void {
	const marker: TeleportMarker = {
		protocolVersion: 1,
		destination: "devbox",
		cwd: "/srv/project",
	};
	const entry = markerEntry(marker, "m1");
	assert.equal(hasTeleportMarker([]), false);
	assert.equal(hasTeleportMarker([entry]), true);
	assert.equal(readTeleportMarker([]), undefined);
	assert.deepEqual(readTeleportMarker([entry]), marker);
	assert.deepEqual(readTeleportMarker([entry, markerEntry({ ...marker }, "m2")]), marker);

	for (const data of [
		undefined,
		null,
		{},
		{ ...marker, protocolVersion: 2 },
		{ ...marker, destination: "bad host" },
		{ ...marker, destination: "devbox:/other" },
		{ ...marker, cwd: "relative" },
	]) {
		assert.equal(hasTeleportMarker([markerEntry(data, "bad")]), true);
		assert.throws(() => readTeleportMarker([markerEntry(data, "bad")]));
	}

	assert.throws(
		() => readTeleportMarker([entry, markerEntry({ ...marker, cwd: "/other" }, "m2")]),
		/conflicting Teleport markers/,
	);
}

function markerEntry(data: unknown, id: string): SessionEntry {
	return {
		type: "custom",
		id,
		parentId: null,
		timestamp: "2026-08-09T00:00:00.000Z",
		customType: TELEPORT_MARKER_TYPE,
		data,
	};
}

async function checkAutocomplete(): Promise<void> {
	const localSuggestions = {
		items: [{ value: "local", label: "local", description: undefined }],
		prefix: "",
	};
	const current: AutocompleteProvider = {
		getSuggestions: async () => localSuggestions,
		applyCompletion: (lines, cursorLine, cursorCol) => ({
			lines,
			cursorLine,
			cursorCol,
		}),
	};
	const listed: string[] = [];
	const workspace: Pick<WorkspaceClient, "list"> = {
		list: async (path?: string) => {
			listed.push(path ?? ".");
			return {
				entries: [
					{ name: "src", kind: "directory" },
					{ name: "space file.txt", kind: "file" },
					{ name: "src\u001b]52;c;fixture\u0007", kind: "file" },
					{ name: "src\nfixture", kind: "file" },
				],
				truncated: false,
			};
		},
	};
	let available: Pick<WorkspaceClient, "list"> | undefined = workspace;
	const provider = createRemoteAutocompleteProvider(current, () => available);
	const signal = new AbortController().signal;

	const remote = await provider.getSuggestions(["@sr"], 0, 3, { signal });
	assert.deepEqual(remote?.items[0], {
		value: "@src/",
		label: "src/",
		description: "src/",
	});
	assert.deepEqual(listed, ["."]);
	assert.equal(remote?.items.length, 1, "control-character filenames must not be inserted into the editor");
	assert.deepEqual(await provider.getSuggestions(["hello"], 0, 5, { signal }), localSuggestions);
	assert.deepEqual(await provider.getSuggestions(["/model"], 0, 6, { signal }), localSuggestions);
	const unsafe = "\u001b]52;c;fixture\u0007";
	localSuggestions.items.push({ value: `bad${unsafe}`, label: "hidden", description: undefined });
	localSuggestions.items[0]!.label = unsafe;
	const safe = await provider.getSuggestions(["/skill"], 0, 6, { signal });
	assert.equal(safe?.items.length, 1);
	assert(!safe?.items[0]?.label.includes("\u001b"));
	assert.equal(localSuggestions.items[0]?.label, unsafe, "display filtering must not change operational metadata");
	available = undefined;
	assert.equal(
		await provider.getSuggestions(["@sr"], 0, 3, { signal }),
		null,
		"disconnected path completion cannot fall back locally",
	);
	let complete!: (value: Awaited<ReturnType<WorkspaceClient["list"]>>) => void;
	available = {
		list: () =>
			new Promise((resolve) => {
				complete = resolve;
			}),
	};
	const stale = provider.getSuggestions(["@sr"], 0, 3, { signal });
	available = workspace;
	complete({ entries: [{ name: "src-old-worker", kind: "directory" }], truncated: false });
	assert.equal(await stale, null, "a retired connection cannot publish late completion results");
}

async function checkChildWorkspaceIntent(): Promise<void> {
	let requestedCwd: string | undefined;
	let isolatedRoot: string | undefined;
	let removedRoot: string | undefined;
	const provider = createWorkspaceProvider({
		client: {
			async prepareIsolatedWorkspace(request: Parameters<WorkspaceClient["prepareIsolatedWorkspace"]>[0]) {
				isolatedRoot = request.root;
				return {
					root: request.root,
					base: `${request.root}/base`,
					digest: "digest",
					stages: { "attempt-01": `${request.root}/attempt-01/workspace` },
				};
			},
			async remove(path: string) {
				removedRoot = path;
			},
		} as unknown as WorkspaceClient,
		identity: { label: "remote", cwd: "/workspace", root: "/workspace", home: "/home/remote" },
		children: {
			async prepareChild(request) {
				requestedCwd = request.cwd;
				return {
					args: [],
					hostCwd: "/runtime",
					dispose: async () => undefined,
				};
			},
		},
	});
	await provider.workspace.children?.prepareChild({ cwd: "/workspace/project" });
	assert.equal(requestedCwd, "/workspace/project", "the workspace provider should preserve the requested child cwd");
	await provider.workspace.isolation?.prepare({
		namespace: "ultra",
		date: "2026-08-26",
		id: "ultra-run",
		source: "/workspace",
		mode: "blank",
		retention: "retain",
		stages: ["attempt-01"],
	});
	assert.equal(isolatedRoot, "/home/remote/.pi/workspaces/ultra/2026-08-26/ultra-run");
	const ephemeral = await provider.workspace.isolation?.prepare({
		namespace: "ultra",
		date: "2026-08-26",
		id: "ultra-ephemeral",
		source: "/workspace",
		mode: "blank",
		retention: "ephemeral",
		stages: ["attempt-01"],
	});
	await ephemeral?.dispose();
	assert.equal(removedRoot, "/home/remote/.pi/workspaces/ultra/2026-08-26/ultra-ephemeral");
	const isolation = provider.workspace.isolation;
	assert(isolation);
	await assert.rejects(
		() =>
			isolation.prepare({
				namespace: "../escape",
				date: "2026-08-26",
				id: "ultra-run",
				source: "/workspace",
				mode: "blank",
				retention: "retain",
				stages: ["attempt-01"],
			}),
		/Invalid isolated workspace path segment/u,
	);
}

function checkChildPromptPreservation(): void {
	const prompt = "managed child role orientation";
	assert.equal(teleportCustomPrompt(false, prompt), undefined);
	assert.equal(teleportCustomPrompt(true, prompt), prompt);
}

checkTargets();
checkProtocol();
checkQuoting();
checkWorkspacePaths();
checkSessionMarkers();
await checkAutocomplete();
await checkChildWorkspaceIntent();
checkChildPromptPreservation();
await checkWorkerPaths();
await import("./controller-check.ts");
console.log("teleport deterministic checks passed");
