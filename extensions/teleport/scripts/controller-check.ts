import { strict as assert } from "node:assert";
import { TeleportController } from "../controller.ts";
import { teleportSummary } from "../command.ts";
import { TeleportConnection } from "../transport/connection.ts";
import type { WorkerReady } from "../transport/worker-client.ts";
import type { WorkspaceClient } from "../workspace/client.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
const prototype = TeleportConnection.prototype;
const descriptors = new Map(
	["start", "close", "assertReady", "ready", "workspace"].map((key) => [
		key,
		Object.getOwnPropertyDescriptor(prototype, key)!,
	]),
);
const owners: TeleportConnection[] = [];
const closed = new Set<TeleportConnection>();
let startGate: ReturnType<typeof deferred> | undefined;
let prepareGate: ReturnType<typeof deferred> | undefined;
let resourcesFail = false;
let canonicalCwd = "/workspace";
let onPrepare: (() => void) | undefined;
let closes = 0;
const client = {
	context: async () => {
		if (resourcesFail) throw new Error("synthetic resource failure");
		return [];
	},
	skills: async () => [],
	prompts: async () => [],
} as unknown as WorkspaceClient;
prototype.start = async function () {
	owners.push(this);
	await startGate?.promise;
	this.assertReady();
};
prototype.close = async function () {
	assert(!closed.has(this));
	closed.add(this);
	closes++;
};
prototype.assertReady = function () {
	if (closed.has(this)) throw new Error("synthetic closed connection");
};
Object.defineProperty(prototype, "ready", {
	configurable: true,
	get() {
		this.assertReady();
		return { cwd: canonicalCwd, root: canonicalCwd, home: "/home/fixture" } as WorkerReady;
	},
});
Object.defineProperty(prototype, "workspace", {
	configurable: true,
	get() {
		this.assertReady();
		return client;
	},
});
const controllers: TeleportController[] = [];
function create(throwOnChange = false) {
	const controller = new TeleportController({
		target: { destination: "fixture", requestedPath: "/workspace" },
		extensionPath: "/fixture/extension.ts",
		prepare: async () => {
			onPrepare?.();
			await prepareGate?.promise;
		},
		onChange: () => {
			if (throwOnChange) throw new Error("synthetic reporter failure");
		},
	});
	controllers.push(controller);
	return controller;
}
try {
	const controller = create();
	const local = await controller.outputs.save("fixture", ".txt", "retained client output");
	assert.match(local, /^pi-output:/);
	startGate = deferred();
	const first = controller.reconnect();
	assert.equal(controller.reconnect(), first, "concurrent reconnects share the same attempt");
	await Promise.resolve();
	assert.equal(owners.length, 1);
	const canceled = controller.disconnect();
	assert.equal(controller.disconnect(), canceled);
	await canceled;
	assert.equal(controller.state.phase, "disconnected");
	const oldGate = startGate;
	startGate = undefined;
	await controller.reconnect();
	const replacement = controller.workspace!;
	oldGate.resolve();
	await first;
	assert.equal(controller.workspace, replacement, "a late canceled attempt cannot replace the current workspace");
	const count = owners.length;
	await controller.reconnect();
	assert.equal(owners.length, count, "connected reconnect is a no-op");
	const stopped = controller.disconnect();
	assert.throws(() => replacement.provider.workspace.assertActive(), /unavailable/);
	await stopped;
	resourcesFail = true;
	await assert.rejects(() => controller.reconnect(), /resource failure/);
	assert.equal(controller.state.phase, "disconnected");
	assert.equal(controller.marker?.cwd, "/workspace");
	resourcesFail = false;
	canonicalCwd = "/other-workspace";
	await assert.rejects(() => controller.reconnect(), /target mismatch/);
	canonicalCwd = "/workspace";
	prepareGate = deferred();
	const reachedPrepare = deferred();
	onPrepare = reachedPrepare.resolve;
	const pending = controller.reconnect();
	await reachedPrepare.promise;
	onPrepare = undefined;
	const preparingGate = prepareGate;
	await controller.disconnect();
	prepareGate = undefined;
	await controller.reconnect();
	const next = controller.workspace;
	preparingGate.resolve();
	await pending;
	assert.equal(controller.workspace, next, "late preparation cannot publish a retired workspace");
	const disposal = controller.dispose();
	assert.equal(controller.dispose(), disposal);
	await disposal;
	assert.equal(controller.state.phase, "closed");
	await assert.rejects(() => controller.reconnect(), /closed/);
	await assert.rejects(() => controller.outputs.save("fixture", ".txt", "late"), /unavailable/);
	const reporting = create(true);
	await reporting.reconnect();
	await reporting.disconnect();
	assert.equal(reporting.state.phase, "disconnected");
	canonicalCwd = "/workspace\nConnection: spoofed\u001b";
	const hostile = create();
	await hostile.reconnect();
	const summary = teleportSummary(hostile, true);
	assert(!summary.includes("\nConnection: spoofed"));
	assert(!summary.includes("\u001b"));
	assert(summary.includes("\nConnection: connected"));
	assert(closes >= 6);
	console.log(
		"teleport controller checks passed: coalescing, cancellation, stale owners, binding, retries, and disposal",
	);
} finally {
	startGate?.resolve();
	prepareGate?.resolve();
	await Promise.allSettled(controllers.map((controller) => controller.dispose()));
	for (const [key, descriptor] of descriptors) Object.defineProperty(prototype, key, descriptor);
}
