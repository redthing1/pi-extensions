import { it } from "vitest";
import { strict as assert } from "node:assert";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { WorkspaceClient } from "../../teleport/workspace/client.ts";
import { createActiveWorkspacePublisher } from "../../shared/active-workspace.ts";
import { observeChildPolicyContributors, type ChildRunIntent } from "../../shared/child-runtime.ts";
import executionGuard from "../index.ts";

it("guards Teleport dispatch and inherits policy into children", async () => {
	if (!process.env.PI_GUARD_TEST_CHECKOUT) throw new Error("PI_GUARD_TEST_CHECKOUT must name the source checkout");
	const root = resolve(process.env.PI_GUARD_TEST_CHECKOUT);
	const { registerRemoteTools, createRemoteBashOperations } = await import(
		new URL("../../teleport/tools.ts", import.meta.url).href
	);
	const { createHarness, getToolResult } = await import(
		pathToFileURL(resolve(root, "packages/coding-agent/test/suite/harness.ts")).href
	);
	const { fauxAssistantMessage, fauxToolCall } = await import(
		pathToFileURL(resolve(root, "packages/ai/src/index.ts")).href
	);
	const destination = { cwd: "/srv/project", home: "/home/remote" };
	const dispatched: string[] = [];
	const workspace = {
		exec(command: string, onData: (stream: string, chunk: Buffer) => void) {
			dispatched.push(command);
			onData("stdout", Buffer.from("allowed remote output"));
			return { id: "fake-request", promise: Promise.resolve({ exitCode: 0, cancelled: false }) };
		},
	} as unknown as WorkspaceClient;

	const harness = await createHarness({
		extensionFactories: [
			(pi: ExtensionAPI) => {
				executionGuard(pi);
				createActiveWorkspacePublisher(pi).publish({
					phase: "ready",
					workspace: {
						identity: { ...destination, label: "synthetic remote", root: destination.cwd },
						assertActive() {},
						registerCompatibleTool() {},
					},
				});
				registerRemoteTools(pi, workspace, destination);
				pi.on("session_start", () => pi.setActiveTools(["bash", "find", "grep"]));
			},
		],
	});
	try {
		for (const [tool, input, category] of [
			["bash", { command: "rm -r /home/remote" }, "catastrophic"],
			["bash", { command: "find / -name needle" }, "reckless"],
			["find", { path: "/", pattern: "needle" }, "reckless"],
			["grep", { path: "/", pattern: "needle" }, "reckless"],
		] as const) {
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall(tool, input)], { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("synthetic guarded operation");
			const result = getToolResult(harness, tool);
			assert(result.isError, JSON.stringify({ tool, input, result, dispatched }));
			assert.match(JSON.stringify(result.content), new RegExp(category));
		}
		assert.deepEqual(dispatched, []);
		const operations = createRemoteBashOperations(workspace, destination);
		await assert.rejects(
			harness.session.executeBash("rm -r /home/remote", undefined, { operations }),
			/catastrophic/u,
		);
		await assert.rejects(harness.session.executeBash("find / -name needle", undefined, { operations }), /reckless/u);
		assert.deepEqual(dispatched, []);
		const result = await harness.session.executeBash("ls /", undefined, { operations });
		assert.match(result.output, /allowed remote output/u);
		assert.deepEqual(dispatched, ["ls /"]);
	} finally {
		harness.cleanup();
	}

	// The real child contributor contract must explicitly load the guard, including in grandchildren.
	const handlers = new Map<string, ((value: unknown) => void)[]>();
	const api = {
		on() {},
		events: {
			on(name: string, handler: (value: unknown) => void) {
				handlers.set(name, [...(handlers.get(name) ?? []), handler]);
				return () => {};
			},
			emit(name: string, value: unknown) {
				for (const handler of handlers.get(name) ?? []) handler(value);
			},
		},
	} as unknown as ExtensionAPI;
	process.env.PI_EXECUTION_GUARD_PROTECTED_PATHS = JSON.stringify(["/inherited-reference"]);
	executionGuard(api);
	assert.equal(process.env.PI_EXECUTION_GUARD_PROTECTED_PATHS, undefined);
	const observer = observeChildPolicyContributors(api);
	const intent: ChildRunIntent = {
		origin: { kind: "interactive" },
		runId: "test",
		batchId: "test",
		cwd: destination.cwd,
		model: "faux/test",
		provider: "faux",
		tools: ["bash"],
		capabilities: ["run_command"],
		references: [{ root: "/new-reference", label: "reference", access: "read-only" }],
		privacy: { clientZdr: true, remoteZdr: false },
	};
	const [contribution] = await observer.prepare(intent);
	assert.deepEqual(contribution.args, ["--extension", new URL("../index.ts", import.meta.url).pathname]);
	assert.deepEqual(JSON.parse(contribution.env!.PI_EXECUTION_GUARD_PROTECTED_PATHS), [
		"/inherited-reference",
		"/new-reference",
	]);
	await contribution.dispose();
});
