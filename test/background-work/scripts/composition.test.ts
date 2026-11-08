import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { afterEach, expect, test, vi } from "vitest";
import { Type } from "typebox";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import {
	createBashToolDefinition,
	initTheme,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { registerBackgroundWork } from "../../../extensions/background-work/index.ts";
import permissionGate from "../../../extensions/permission-gate.ts";
import safety from "../../../extensions/safety/index.ts";
import executionGuard from "../../../extensions/execution-guard/index.ts";
import teleport from "../../../extensions/teleport/index.ts";
import {
	createActiveWorkspacePublisher,
	type WorkspaceFileOperations,
} from "../../../extensions/shared/active-workspace.ts";

const { createHarness, getMessageText, getToolResult } = await import(
	pathToFileURL(
		join(
			process.env.PI_BACKGROUND_CHECKOUT!,
			"packages/coding-agent/test/suite/harness.ts",
		),
	).href
);
const harnesses: Awaited<ReturnType<typeof createHarness>>[] = [];
const call = (name: string, args: Record<string, unknown>) =>
	fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
const answer = (text: string) => fauxAssistantMessage(text);
afterEach(async () => {
	for (const h of harnesses.splice(0)) {
		await h.session.extensionRunner.emit({
			type: "session_shutdown",
			reason: "exit",
		});
		h.cleanup();
	}
});

for (const policy of [
	"permission",
	"safety",
	"execution",
	"remote-containment",
] as const) {
	test(`${policy} policy sees ordinary and background Bash before any dispatch`, async () => {
		initTheme("dark", false);
		let dispatches = 0;
		const h = await createHarness({
			extensionFactories: [
				(pi) => {
					registerBackgroundWork(pi);
					if (policy === "remote-containment")
						createActiveWorkspacePublisher(pi, {
							phase: "ready",
							workspace: {
								files: {} as WorkspaceFileOperations,
								identity: {
									label: "synthetic remote",
									cwd: "/workspace",
									root: "/workspace",
									home: "/home/fixture",
								},
								assertActive() {},
								registerCompatibleTool() {},
							},
						});
					pi.registerTool(
						createBashToolDefinition("/", {
							operations: {
								async exec() {
									dispatches++;
									return { exitCode: 0 };
								},
							},
						}),
					);
				},
				policy === "permission"
					? permissionGate
					: policy === "safety" || policy === "remote-containment"
						? safety
						: executionGuard,
			],
		});
		harnesses.push(h);
		if (policy === "permission")
			h.session.extensionRunner.setFlagValue("permission-gate", true);
		if (policy === "safety" || policy === "remote-containment")
			for (const [name, value] of [
				["safety", true],
				["safety-profile", "explore"],
				[
					"safety-containment",
					policy === "remote-containment" ? "read-only" : "off",
				],
			] as const)
				h.session.extensionRunner.setFlagValue(name, value);
		await h.session.bindExtensions({ mode: "tui" });
		const command =
			policy === "permission"
				? "sudo synthetic-fixture-command"
				: policy === "safety"
					? "touch synthetic-rejected"
					: policy === "remote-containment"
						? "printf harmless"
						: "rm -rf /";
		for (const background of [false, true]) {
			h.setResponses([
				call("bash", { command, background }),
				answer("Rejected."),
			]);
			await h.session.prompt(
				"Test a synthetic rejection; the backend only records dispatch.",
			);
			expect(getToolResult(h, "bash").isError).toBe(true);
			if (policy === "remote-containment")
				expect(getMessageText(getToolResult(h, "bash"))).toContain(
					"does not provide command containment",
				);
		}
		h.setResponses([call("monitor", { command }), answer("Rejected monitor.")]);
		await h.session.prompt("Test the same policy through a monitor.");
		expect(getToolResult(h, "monitor").isError).toBe(true);
		expect(dispatches).toBe(0);
		if (policy === "safety") {
			h.setResponses([
				call("background_status", {}),
				answer("Status checked."),
			]);
			await h.session.prompt("Inspect owned jobs.");
			expect(getToolResult(h, "background_status").isError).toBeFalsy();
		}
		expect(h.session.messages.filter((m) => m.role === "custom")).toHaveLength(
			0,
		);
	});
}

test("nested Bash keeps its completed-result contract under user promotion", async () => {
	initTheme("dark", false);
	let finish!: () => void;
	let started = false;
	const pending = new Promise<void>((resolve) => {
		finish = resolve;
	});
	let owner!: ReturnType<typeof registerBackgroundWork>;
	const h = await createHarness({
		extensionFactories: [
			(pi) => {
				owner = registerBackgroundWork(pi);
				pi.registerTool(
					createBashToolDefinition("/", {
						operations: {
							async exec(_c, _d, { onData }) {
								started = true;
								await pending;
								onData(Buffer.from("nested output"));
								return { exitCode: 0 };
							},
						},
					}),
				);
				pi.registerTool({
					name: "script",
					label: "Script",
					description: "Synthetic nested caller",
					parameters: Type.Object({}),
					async execute(_id, _args, _signal, _update, ctx) {
						return (await ctx.executeTool("bash", { command: "synthetic" }))
							.result;
					},
				});
			},
		],
	});
	harnesses.push(h);
	await h.session.bindExtensions({ mode: "tui" });
	h.setResponses([call("script", {}), answer("Done.")]);
	const run = h.session.prompt("Run nested shell.");
	await vi.waitFor(() => expect(started).toBe(true));
	expect(owner.promote()).toBeUndefined();
	finish();
	await run;
	const result = h
		.eventsOfType("tool_execution_end")
		.find((e) => e.toolName === "script")!.result;
	expect(result.structuredContent.exit_code).toBe(0);
	expect(result.structuredContent.status).toBeUndefined();
	expect(h.session.messages.filter((m) => m.role === "custom")).toHaveLength(0);
});

const containerTest = process.env.PI_BACKGROUND_SSH_CONFIG ? test : test.skip;
containerTest.each([false, true])(
	"real Teleport disconnect/reconnect preserves shell ownership and output boundaries (reversed=%s)",
	async (reversed) => {
		initTheme("dark", false);
		const argv = process.argv;
		const target = `background-fixture:${process.env.PI_BACKGROUND_REMOTE_CWD}`;
		process.argv = [process.execPath, "pi", "--teleport", target];
		let h: Awaited<ReturnType<typeof createHarness>>;
		try {
			const factories = [
				(pi: ExtensionAPI) => {
					registerBackgroundWork(pi);
				},
				teleport,
				executionGuard,
				safety,
			];
			h = await createHarness({
				extensionFactories: reversed ? factories.reverse() : factories,
				settings: { compaction: { enabled: false }, retry: { enabled: false } },
			});
		} finally {
			process.argv = argv;
		}
		harnesses.push(h!);
		h!.session.extensionRunner.setFlagValue("teleport", target);
		h!.session.extensionRunner.setFlagValue("safety", true);
		h!.session.extensionRunner.setFlagValue("safety-profile", "monitor");
		await h!.session.bindExtensions({ mode: "tui" });
		expect(h!.session.getActiveToolNames()).toContain("bash");
		expect(h!.session.getActiveToolNames()).toContain("background_status");
		const original = h!.session.getToolDefinition("bash")!;
		expect(original.parameters).toMatchObject({
			properties: { background: { type: "boolean" } },
		});
		const count = `count-${randomUUID()}`;
		h!.setResponses([
			call("bash", {
				command: `printf one >> ${count}; sleep 0.2; id -u; printf remote-result`,
				background: true,
			}),
			answer("Started."),
			answer("Completed."),
		]);
		await h!.session.prompt("Run synthetic container work.");
		await vi.waitFor(
			() =>
				expect(
					h!.session.messages.some((m) => getMessageText(m) === "Completed."),
				).toBe(true),
			{ timeout: 5000 },
		);
		const notices = () =>
			h!.session.messages.filter(
				(m) => m.role === "custom" && m.customType === "background-result",
			);
		expect(notices()).toHaveLength(1);
		expect(getMessageText(notices()[0])).toContain("10001");
		const runner = h!.session.extensionRunner;
		const command = runner.getCommand("teleport")!;
		const saved = await runner
			.createContext()
			.writeOutputFile("fixture", ".txt", "synthetic-client-only-result");
		h!.setResponses([
			call("bash", { command: "sleep 120", background: true }),
			answer("Started long work."),
		]);
		await h!.session.prompt("Start another synthetic job.");
		await command.handler("disconnect", runner.createCommandContext());
		expect(h!.session.getActiveToolNames()).not.toContain("bash");
		const hostPath = join(h!.tempDir, "must-not-exist");
		await expect(
			original.execute(
				"stale-native",
				{ command: `touch '${hostPath}'`, background: true },
				undefined,
				undefined,
				runner.createToolContext("stale-native", undefined),
			),
		).rejects.toThrow(/unavailable/i);
		expect(existsSync(hostPath)).toBe(false);
		h!.setResponses([
			call("read_output", { reference: saved }),
			answer("Client output remains readable."),
		]);
		await h!.session.prompt("Read the saved client result while disconnected.");
		expect(getToolResult(h!, "read_output").isError).toBe(true); // Safety preserves its stricter disconnected-workspace policy.
		await command.handler("reconnect", runner.createCommandContext());
		expect(h!.session.getActiveToolNames()).toContain("bash");
		expect(h!.session.getToolDefinition("bash")).not.toBe(original);
		h!.setResponses([
			call("read_output", { reference: saved }),
			answer("Read retained client output."),
		]);
		await h!.session.prompt("Read the retained client result after reconnect.");
		expect(getMessageText(getToolResult(h!, "read_output"))).toContain(
			"synthetic-client-only-result",
		);
		expect(h!.session.getActiveToolNames()).toContain("background_stop");
		h!.setResponses([
			call("bash", { command: `cat ${count}; id -u`, background: true }),
			answer("Restarted shell access."),
			answer("New connection completed."),
		]);
		await h!.session.prompt(
			"Check the original count through the new connection.",
		);
		await vi.waitFor(
			() =>
				expect(
					h!.session.messages.some(
						(m) => getMessageText(m) === "New connection completed.",
					),
				).toBe(true),
			{ timeout: 5000 },
		);
		expect(notices()).toHaveLength(2);
		expect(getMessageText(notices()[1])).toContain("one10001");
		expect(getMessageText(notices()[1])).not.toContain("oneone");
		expect(h!.getPendingResponseCount()).toBe(0);
	},
	30000,
);
