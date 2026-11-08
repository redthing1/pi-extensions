import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { getEventListeners } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { createActiveWorkspacePublisher } from "../../shared/active-workspace.ts";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { type ToolCall, validateToolArguments } from "@earendil-works/pi-ai";
import {
	initTheme,
	type KeybindingsManager,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionToolContext,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
	getKeybindings,
	setKeybindings,
	stripTerminalSequences,
	visibleWidth,
	KeybindingsManager as TuiKeybindingsManager,
	TUI_KEYBINDINGS,
	type TUI,
} from "@earendil-works/pi-tui";
import type { ChildToolProviderObserver } from "../../shared/child-runtime.ts";
import { completeOutput, createChildArtifacts, finishChildArtifacts, writeChildStatus } from "../src/artifacts.ts";
import { analyzeSubagentEffects, childIntent, resolveCommission } from "../src/commission.ts";
import {
	renderSubagentCall,
	renderSubagentResult,
	renderSubagentSendCall,
	renderSubagentUpdates,
} from "../src/render.ts";
import {
	childPresentations,
	compactTargets,
	formatList,
	formatTargets,
	inspectionPresentations,
	resultPage,
} from "../src/results.ts";
import { runChild } from "../src/runner.ts";
import { SubagentScheduler } from "../src/scheduler.ts";
import { registerBackgroundRuns } from "../src/background.ts";
import { StartSchema } from "../src/schema.ts";
import { SubagentPanel } from "../src/panel.ts";
import { registerSubagentCommands } from "../src/commands.ts";
import { registerSubagentTools } from "../src/tool.ts";
import registerParentMessage from "../child.ts";
import type {
	BatchView,
	ChildExecutionResult,
	ChildLaunchRequest,
	ChildToolCall,
	ChildUsage,
	ChildView,
	PreparedCommission,
	ResolvedCommission,
	SubagentToolDetails,
	SubagentUpdate,
} from "../src/types.ts";

const fixture = process.env.PI_SUBAGENT_CHECK_CHILD;
if (fixture) {
	const emit = (event: unknown) => console.log(JSON.stringify(event));
	let idle = false;
	const assistant = (text: string, error?: string) =>
		emit({
			type: "message_end",
			message: {
				role: "assistant",
				model: "reported-model",
				stopReason: error ? "error" : "stop",
				content: [{ type: "text", text }],
				errorMessage: error,
				usage: { input: 3, output: 2, cacheRead: 1, cacheWrite: 0, cost: { total: 0.25 } },
			},
		});
	for await (const line of createInterface({ input: process.stdin })) {
		const command = JSON.parse(line);
		if (command.type === "get_state") {
			emit({
				type: "response",
				command: "get_state",
				id: command.id,
				success: true,
				data: fixture === "invalid-state" ? {} : { isStreaming: !idle, isCompacting: false, pendingMessageCount: 0 },
			});
			continue;
		}
		if (fixture === "input-rejection" && !command.message.startsWith("Task:")) {
			emit({
				type: "response",
				command: "prompt",
				id: command.id,
				success: false,
				error: "Input intentionally rejected.",
			});
			continue;
		}
		emit({ type: "response", command: "prompt", id: command.id, success: true });
		emit({ type: "agent_start" });
		idle = false;
		if (fixture === "signal-exit") process.kill(process.pid, "SIGTERM");
		if (fixture === "empty-success") process.exit(0);
		if (fixture === "cancel-wait") {
			emit({ type: "tool_execution_start", toolCallId: "fixture-wait", toolName: "fixture_wait", args: {} });
			process.on("SIGTERM", () => process.exit(0));
			continue;
		}
		if (fixture.startsWith("cancel-inherited-")) {
			const writer = fixture !== "cancel-inherited-quiet";
			const descendant = spawn(
				process.execPath,
				[
					"-e",
					writer ? "setInterval(() => process.stdout.write('fixture output\\n'), 10)" : "setInterval(() => {}, 1000)",
				],
				{ stdio: ["ignore", "inherit", "inherit"] },
			);
			assistant("Useful partial output before cancellation.");
			emit({
				type: "tool_execution_start",
				toolCallId: "fixture-wait",
				toolName: "fixture_wait",
				args: { descendantPid: descendant.pid },
			});
			process.on("SIGTERM", fixture === "cancel-inherited-hard" ? () => {} : () => process.exit(0));
			continue;
		}
		if (fixture === "inherited-tail") {
			const message =
				JSON.stringify({
					type: "message_end",
					message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Trailing response." }] },
				}) + "\n";
			spawn(
				process.execPath,
				[
					"-e",
					`
				const message = ${JSON.stringify(message)};
				let offset = 0;
				const timer = setInterval(() => {
					process.stdout.write(message.slice(offset, offset += 20));
					if (offset >= message.length) { clearInterval(timer); process.exit(0); }
				}, 40);
			`,
				],
				{ stdio: ["ignore", "inherit", "inherit"] },
			);
			process.exit(0);
		}
		if (fixture === "launch-options") {
			const args = process.argv.slice(2);
			assistant(
				JSON.stringify({
					thinking: args.includes("--thinking") ? args[args.indexOf("--thinking") + 1] : null,
					model: args[args.indexOf("--model") + 1],
					clientZdr: args.includes("--zdr-client"),
				}),
			);
		} else if (fixture === "provider-error") {
			assistant("useful partial response", "intentional provider failure");
		} else if (fixture === "context-usage") {
			assistant("Before compaction.");
			emit({ type: "compaction_end", aborted: true });
			assistant("Failed response.", "intentional failure");
			emit({ type: "compaction_end", result: { summary: "compact" }, aborted: false });
			assistant("Failed after compaction.", "intentional failure");
			emit({
				type: "message_end",
				message: {
					role: "assistant",
					stopReason: "aborted",
					content: [],
					usage: { input: 99, output: 0, cacheRead: 0, cacheWrite: 0 },
				},
			});
			emit({
				type: "message_end",
				message: {
					role: "assistant",
					stopReason: "stop",
					content: [{ type: "text", text: "Zero usage." }],
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				},
			});
			assistant("Fresh response.");
		} else if (fixture === "activity-log") {
			for (const event of [
				{
					type: "message_end",
					message: {
						role: "assistant",
						model: "reported-model",
						content: [],
						stopReason: "toolUse",
						usage: { input: 10, output: 2, cacheRead: 4, cacheWrite: 0, cost: { total: 0.01 } },
					},
				},
				{ type: "tool_execution_start", toolCallId: "read-1", toolName: "read", args: { path: "README.md" } },
				{ type: "tool_execution_start", toolCallId: "bash-1", toolName: "bash", args: { command: "false" } },
				{
					type: "tool_execution_end",
					toolCallId: "read-1",
					toolName: "read",
					result: { content: [{ type: "text", text: "contents" }] },
					isError: false,
				},
				{
					type: "tool_execution_end",
					toolCallId: "bash-1",
					toolName: "bash",
					result: { content: [{ type: "text", text: "command failed" }] },
					isError: true,
				},
				{
					type: "message_end",
					message: {
						role: "assistant",
						model: "reported-model",
						content: [{ type: "text", text: "activity complete" }],
						stopReason: "stop",
						usage: { input: 20, output: 3, cacheRead: 6, cacheWrite: 1, totalTokens: 32, cost: { total: 0.02 } },
					},
				},
			])
				emit(event);
		} else if (["interactive", "input-rejection", "invalid-state"].includes(fixture)) {
			if (command.message.startsWith("Task:")) {
				emit({
					type: "tool_execution_start",
					toolCallId: "parent-1",
					toolName: "parent_message",
					args: { message: "A useful finding." },
				});
				emit({ type: "tool_execution_end", toolCallId: "parent-1", toolName: "parent_message", isError: false });
				emit({
					type: "tool_execution_start",
					toolCallId: "parent-failed",
					toolName: "parent_message",
					args: { message: "Must not be delivered." },
				});
				emit({ type: "tool_execution_end", toolCallId: "parent-failed", toolName: "parent_message", isError: true });
				assistant("Initial progress.");
			} else {
				assistant(command.message);
			}
		}
		idle = true;
		emit({ type: "agent_settled" });
	}
	process.exit(0);
}

const isolatedRoot = mkdtempSync(join(tmpdir(), "pi-subagents-check-"));
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = join(isolatedRoot, "agent");

const noExtensionTools: ChildToolProviderObserver = {
	definition: () => undefined,
	prepare: async () => [],
};

initTheme("dark");

function checkCommissionResolution(): void {
	const webTools: ChildToolProviderObserver = {
		definition: (name) => (name === "web_search" ? { name, effects: ["network"] } : undefined),
		prepare: async () => [],
	};
	const batchId = `batch-${randomUUID()}`;
	const resolved = resolveCommission({
		commission: {
			label: "research",
			task: "Find the relevant primary source.",
			tools: ["read", "web_search"],
		},
		index: 0,
		batchId,
		toolCallId: "tool-call",
		cwd: "/workspace/project",
		parentModel: { provider: "provider", id: "model" },
		thinkingLevel: "high",
		privacy: { clientZdr: true, remoteZdr: false },
		toolProviders: webTools,
	});
	assert.equal(resolved.batchId, batchId);
	assert.equal(resolved.model, "provider/model");
	assert.equal(resolved.modelId, "model");
	assert.equal(resolved.modelSource, "inherited");
	assert.equal(resolved.thinkingLevel, "high");
	assert.deepEqual(resolved.extensionTools, ["web_search"]);
	assert.deepEqual(resolved.capabilities, ["read_files", "network"]);
	assert.throws(
		() =>
			resolveCommission({
				commission: { task: "Use a missing tool.", tools: ["missing"] },
				index: 0,
				batchId,
				toolCallId: "tool-call",
				cwd: "/workspace/project",
				parentModel: { provider: "provider", id: "model" },
				privacy: { clientZdr: true, remoteZdr: false },
				toolProviders: noExtensionTools,
			}),
		/Tool 'missing' is not available to children/,
	);
	assert.throws(
		() =>
			resolveCommission({
				commission: { task: "Switch provider.", tools: [], model: "other/model" },
				index: 0,
				batchId,
				toolCallId: "tool-call",
				cwd: "/workspace/project",
				parentModel: { provider: "provider", id: "model" },
				privacy: { clientZdr: true, remoteZdr: false },
				toolProviders: noExtensionTools,
			}),
		/Cross-provider selection is not enabled/,
	);
}

function checkEffectAnalysis(): void {
	const readOnly = analyzeSubagentEffects(
		{
			tasks: [{ task: "Inspect.", cwd: "/workspace/read", tools: ["read", "grep"] }],
		},
		{ cwd: "/workspace" },
		noExtensionTools,
	);
	assert.equal(readOnly.risk, "safe_read");
	assert(readOnly.effects.includes("run_command"));
	assert(readOnly.effects.includes("read_files"));
	assert(!readOnly.effects.includes("write_files"));
	assert.deepEqual(readOnly.pathReferences, [
		{ path: "/workspace/read", operation: "list" },
		{ path: "/workspace/read", operation: "read" },
	]);

	const write = analyzeSubagentEffects(
		{
			tasks: [
				{ task: "Inspect.", cwd: "/workspace/read", tools: ["read"] },
				{ task: "Edit.", cwd: "/workspace/write", tools: ["write"] },
			],
		},
		{ cwd: "/workspace" },
		noExtensionTools,
	);
	assert.equal(write.risk, "unknown");
	assert(write.effects.includes("write_files"));
	assert.deepEqual(write.pathReferences, [
		{ path: "/workspace/read", operation: "read" },
		{ path: "/workspace/write", operation: "write" },
	]);

	const unresolved = analyzeSubagentEffects(
		{
			tasks: [
				{
					task: "Inspect.",
					cwd: "/external/project",
				},
			],
		},
		{ cwd: "/workspace" },
		noExtensionTools,
	);
	assert.equal(unresolved.risk, "unknown");
	assert.deepEqual(unresolved.pathReferences, [
		{ path: "/external/project", operation: "list" },
		{ path: "/external/project", operation: "read" },
		{ path: "/external/project", operation: "write" },
	]);
}

async function checkSchedulerWaves(): Promise<void> {
	const gates = new Map<string, () => void>();
	const started: string[] = [];
	let active = 0;
	let maxActive = 0;
	const execute: typeof runChild = async (request, signal) => {
		started.push(request.commission.id);
		active += 1;
		maxActive = Math.max(maxActive, active);
		await new Promise<void>((resolve) => {
			const finish = () => {
				gates.delete(request.commission.id);
				resolve();
			};
			gates.set(request.commission.id, finish);
			signal.addEventListener("abort", finish, { once: true });
		});
		active -= 1;
		return executionResult(signal.aborted ? "cancelled" : "completed", request);
	};
	const scheduler = new SubagentScheduler(4, execute);
	const disposed: string[] = [];
	const prepared = Array.from({ length: 6 }, (_, index) => preparedCommission(index, disposed));
	const batch = await scheduler.admit({
		batchId: prepared[0].spec.batchId,
		background: true,
		prepared,
	});
	assert.equal(batch.background, true);
	await until(() => started.length === 4);
	const current = scheduler.list()[0];
	assert.equal(current.kind, "batch");
	if (current.kind !== "batch") throw new Error("expected batch");
	assert.equal(current.children.filter((child) => child.state === "running").length, 4);
	assert.equal(current.children.filter((child) => child.state === "queued").length, 2);
	for (const id of started.slice(0, 4)) gates.get(id)?.();
	await until(() => started.length === 6);
	for (const id of started.slice(4)) gates.get(id)?.();
	const complete = await scheduler.wait(prepared.map((entry) => entry.spec.id));
	assert(complete.every((child) => child.state === "completed"));
	const selected = await scheduler.wait([prepared[0].spec.id, prepared[1].spec.id, prepared[0].spec.id]);
	assert.deepEqual(
		selected.map((target) => target.id),
		[prepared[0].spec.id, prepared[1].spec.id],
	);
	assert.equal(maxActive, 4);
	assert.deepEqual(
		started,
		prepared.map((entry) => entry.spec.id),
	);
	assert.equal(disposed.length, 6);
	const listed = formatList(scheduler.list());
	assert(listed.includes(prepared[0].spec.id));
	assert(listed.includes(prepared[0].spec.label));
	assert(listed.includes("completed"));
	assert(listed.includes("result ready"));
	const twoChildren = formatTargets(scheduler.targets([prepared[0].spec.id, prepared[1].spec.id]));
	assert(twoChildren.includes(`## ${prepared[0].spec.label} (${prepared[0].spec.id})`));
	assert(twoChildren.includes(`## ${prepared[1].spec.label} (${prepared[1].spec.id})`));
	await scheduler.shutdown();
}

async function checkQueuedAndRunningCancellation(): Promise<void> {
	const started: string[] = [];
	const execute: typeof runChild = async (request, signal) => {
		started.push(request.commission.id);
		await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
		return executionResult("cancelled", request);
	};
	const scheduler = new SubagentScheduler(1, execute);
	const disposed: string[] = [];
	const prepared = [preparedCommission(0, disposed), preparedCommission(1, disposed)];
	const batch = await scheduler.admit({
		batchId: prepared[0].spec.batchId,
		background: true,
		prepared,
	});
	await until(() => started.length === 1);
	const queuedId = prepared[1].spec.id;
	const [cancelledChild] = await scheduler.cancel([queuedId]);
	assert.equal(cancelledChild.state, "cancelled");
	assert(!started.includes(queuedId));
	const [cancelledBatch] = await scheduler.cancel(prepared.map((entry) => entry.spec.id));
	assert.equal(cancelledBatch.state, "cancelled");
	assert.equal(disposed.length, 2);
	await scheduler.shutdown();
}

async function checkBoundedWaiting(): Promise<void> {
	let release = () => {};
	const scheduler = new SubagentScheduler(1, async (request, signal) => {
		if (request.commission.index === 1) {
			await new Promise<void>((resolve) => {
				const finish = () => {
					signal.removeEventListener("abort", finish);
					resolve();
				};
				release = finish;
				signal.addEventListener("abort", finish, { once: true });
			});
		}
		return executionResult(signal.aborted ? "cancelled" : "completed", request);
	});
	const tools = new Map<string, ToolDefinition>();
	registerSubagentTools(
		{
			on() {},
			registerMessageRenderer() {},
			registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
			events: { on: () => () => {}, emit() {} },
		} as unknown as ExtensionAPI,
		scheduler,
		{ tools: noExtensionTools, policies: { prepare: async () => [] }, providers: { prepare: async () => [] } },
	);
	const waitTool = tools.get("subagent_wait")!;
	const invoke = (params: ToolCall["arguments"]) => {
		const args = validateToolArguments(waitTool, {
			type: "toolCall",
			id: "wait-check",
			name: "subagent_wait",
			arguments: params,
		});
		return waitTool.execute("wait-check", args, undefined, undefined, {} as ExtensionToolContext);
	};
	const prepared = Array.from({ length: 3 }, (_, index) => preparedCommission(index, []));
	const ids = prepared.map((child) => child.spec.id);
	const controller = new AbortController();
	try {
		await scheduler.admit({ batchId: prepared[0].spec.batchId, background: true, prepared });
		await until(() => scheduler.runs()[1].state === "running");
		for (const timeoutSeconds of [0, -1, 0.5, false, "", "invalid"]) {
			assert.throws(() => invoke({ ids, timeoutSeconds }), /timeoutSeconds/);
		}
		let changes = 0;
		const updates = setInterval(() => scheduler.markNotified(ids[1], false, []), 5);
		const started = performance.now();
		try {
			const targets = await scheduler.wait(ids, controller.signal, () => changes++, 30);
			assert.deepEqual(
				targets.map((child) => child.state),
				["completed", "running", "queued"],
			);
			assert(changes > 1, "Activity must wake the wait without extending its deadline.");
			assert(performance.now() - started < 500);
		} finally {
			clearInterval(updates);
		}
		assert.equal(getEventListeners(controller.signal, "abort").length, 0);
		const expired = (await invoke({ ids, timeoutSeconds: 1 })) as AgentToolResult<SubagentToolDetails>;
		assert.equal(expired.details?.timedOut, true);
		assert.equal(expired.details?.error, undefined);
		assert(expired.content.some((entry) => entry.type === "text" && entry.text.includes("no results collected")));
		assert(!expired.content.some((entry) => entry.type === "text" && entry.text.includes("completed child-0")));
		assert(scheduler.runs().every((child) => !child.collected));
		assert.equal(scheduler.notices().filter((notice) => notice.completion).length, 1);
		for (const expanded of [false, true]) {
			assert(renderText(renderSubagentResult(expired, expanded, plainTheme)).includes("Wait ended"));
		}
		const interrupted = scheduler.wait(ids, controller.signal, undefined, 10_000);
		controller.abort();
		await assert.rejects(interrupted, /interrupted/);
		assert.equal(getEventListeners(controller.signal, "abort").length, 0);
		assert.equal(scheduler.runs()[1].state, "running");
		const ready = await invoke({ ids: [ids[0]] });
		assert.equal((ready.details as SubagentToolDetails).timedOut, undefined);
		assert.equal(scheduler.runs({ ids: [ids[0]] })[0].collected, true);
		const cancelController = new AbortController();
		const cancel = tools
			.get("subagent_cancel")!
			.execute("cancel-check", { ids: [ids[1]] }, cancelController.signal, undefined, {} as ExtensionToolContext);
		cancelController.abort();
		const stopped = await cancel;
		assert((stopped.details as SubagentToolDetails).error?.includes("Stopped waiting for cancellation"));
		assert.equal(scheduler.runs({ ids: [ids[1]] })[0].collected, false);
		const unbounded = invoke({ ids: ids.slice(1), timeoutSeconds: null });
		release();
		const result = await unbounded;
		assert.equal((result.details as SubagentToolDetails).error, undefined);
		assert.equal((result.details as SubagentToolDetails).timedOut, undefined);
		assert.equal(scheduler.runs().length, 0);
	} finally {
		await scheduler.shutdown();
	}
}

async function checkCancellationSettlement(): Promise<void> {
	let releaseCleanup!: () => void;
	const cleanup = new Promise<void>((resolve) => {
		releaseCleanup = resolve;
	});
	const scheduler = new SubagentScheduler(1, async (request, signal) => {
		await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
		return executionResult("cancelled", request);
	});
	const queued = preparedCommission(1, []);
	const batch = await scheduler.admit({
		batchId: queued.spec.batchId,
		background: true,
		prepared: [
			preparedCommission(0, []),
			{
				...queued,
				contributions: [
					{
						id: "deferred-cleanup",
						args: [],
						metadata: {},
						dispose: () => cleanup,
					},
				],
			},
		],
	});
	const controller = new AbortController();
	const cancel = scheduler.cancel([queued.spec.id], controller.signal);
	let returned = false;
	const wait = scheduler.wait([queued.spec.id]).then(() => {
		returned = true;
	});
	await Promise.resolve();
	assert.equal(returned, false);
	assert.equal(scheduler.targets([queued.spec.id])[0].state, "queued");
	controller.abort();
	await assert.rejects(cancel, /Stopped waiting for cancellation/);
	assert.equal(scheduler.runs({ ids: [queued.spec.id] })[0].collected, false);
	const settledCancel = scheduler.cancel([queued.spec.id]);
	releaseCleanup();
	await Promise.all([settledCancel, wait]);
	assert.equal(scheduler.targets([queued.spec.id])[0].state, "cancelled");
	await scheduler.cancel(batch.children.map((child) => child.id));
	await scheduler.shutdown();
}

async function checkBackgroundDelivery(): Promise<void> {
	for (const scenario of [
		"idle",
		"busy",
		"fast",
		"failed",
		"collected",
		"cancelled",
		"stopped",
		"shutdown",
		"new",
		"compact",
		"compact-failed",
		"compact-aborted",
		"dialog",
		"dialog-stopped",
	] as const) {
		let finish!: () => void;
		const scheduler = new SubagentScheduler(1, async (request, signal) => {
			if (scenario === "fast") return executionResult("completed", request);
			await new Promise<void>((resolve) => {
				finish = resolve;
				signal.addEventListener("abort", resolve.bind(null, undefined), {
					once: true,
				});
			});
			return executionResult(signal.aborted ? "cancelled" : scenario === "failed" ? "failed" : "completed", request);
		});
		const handlers = new Map<string, (event: unknown, context: ExtensionContext) => unknown>();
		const messages: string[] = [];
		const statuses: (string | undefined)[] = [];
		const compaction = scenario.startsWith("compact");
		const dialog = scenario.startsWith("dialog");
		let idle = scenario === "idle" || dialog;
		const controller = new AbortController();
		const ctx = {
			isIdle: () => idle,
			hasPendingMessages: () => false,
			signal: controller.signal,
			ui: {
				setStatus: (_key: string, value: string | undefined) => statuses.push(value),
			},
		} as unknown as ExtensionToolContext;
		const pi = {
			registerMessageRenderer() {},
			on: (name: string, handler: (event: unknown, context: ExtensionContext) => unknown) => {
				handlers.set(name, handler);
			},
			sendMessage: (message: { content: string }, options: { triggerTurn: boolean; deliverAs: string }) => {
				assert.equal(options.triggerTurn, true);
				assert.equal(options.deliverAs, "followUp");
				messages.push(message.content);
			},
		} as unknown as ExtensionAPI;
		registerBackgroundRuns(pi, scheduler);
		const emit = async (name: string, event: unknown = {}) => {
			await handlers.get(name)?.(event, ctx);
		};
		await emit("session_start");
		if (!idle && !compaction) await emit("agent_start");
		if (dialog) await emit("ui_prompt_start");
		if (scenario === "dialog-stopped") {
			await emit("agent_start");
			controller.abort();
			await emit("agent_settled");
		}
		const prepared = preparedCommission(0, []);
		const batch = await scheduler.admit({
			batchId: prepared.spec.batchId,
			background: true,
			prepared: [prepared],
		});
		if (scenario === "shutdown") await emit("session_shutdown");
		if (scenario === "new") {
			await emit("session_start", { reason: "new" });
			assert.deepEqual(scheduler.list(), []);
			assert.deepEqual(messages, []);
			await emit("session_shutdown");
			await scheduler.shutdown();
			continue;
		}
		if (scenario === "stopped") controller.abort();
		if (scenario === "cancelled") {
			scheduler.acknowledge(batch.children.map((child) => child.id));
			await scheduler.cancel(batch.children.map((child) => child.id));
		} else if (scenario !== "fast") finish();
		const targets = await scheduler.wait(batch.children.map((child) => child.id));
		if (scenario === "collected") scheduler.acknowledge(targets.map((target) => target.id));
		if (scenario !== "idle") assert.equal(messages.length, 0);
		idle = true;
		if (compaction) {
			await emit(scenario === "compact" ? "session_compact" : "session_compact_failed", {
				aborted: scenario === "compact-aborted",
			});
		} else if (dialog) {
			await emit("ui_prompt_end");
		} else await emit("agent_settled");
		await Promise.resolve();
		assert.equal(
			messages.length,
			["idle", "busy", "fast", "failed", "compact", "compact-failed", "dialog"].includes(scenario) ? 1 : 0,
			scenario,
		);
		await emit("agent_settled");
		assert(messages.length <= 1);
		if (scenario !== "fast")
			assert(
				statuses.some((status) => status?.includes("running")),
				scenario,
			);
		await emit("session_shutdown");
		await scheduler.shutdown();
	}
}

async function checkParentMessageTool(): Promise<void> {
	const events = new Map<string, ((value: unknown) => void)[]>();
	const tools = new Map<string, ToolDefinition>();
	const compatible = new Set<string>();
	const pi = {
		registerTool: (tool: ToolDefinition) => {
			tools.set(tool.name, tool);
		},
		events: {
			on(name: string, handler: (value: unknown) => void) {
				const handlers = events.get(name) ?? [];
				handlers.push(handler);
				events.set(name, handlers);
				return () => {};
			},
			emit(name: string, value: unknown) {
				for (const handler of events.get(name) ?? []) handler(value);
			},
		},
	} as unknown as ExtensionAPI;
	const workspace = createActiveWorkspacePublisher(pi);
	registerParentMessage(pi);
	workspace.publish({
		phase: "ready",
		workspace: {
			identity: { label: "fixture", cwd: "/workspace", root: "/workspace" },
			assertActive() {},
			registerCompatibleTool: (name) => {
				compatible.add(name);
			},
		},
	});
	assert.deepEqual([...tools.keys()], ["parent_message"]);
	assert(compatible.has("parent_message"));
	const tool = tools.get("parent_message")!;
	await assert.rejects(
		tool.execute("invalid", { message: "雪".repeat(3000) }, undefined, undefined, {} as ExtensionToolContext),
		/8000 UTF-8 bytes/,
	);
	assert(
		(
			await tool.execute("valid", { message: "A useful finding." }, undefined, undefined, {} as ExtensionToolContext)
		).content.some((item) => item.type === "text" && item.text === "Published to parent."),
	);
}

function checkTaskSchema(): void {
	assert.deepEqual(StartSchema.required, ["tasks", "background"]);
	assert.deepEqual(Object.keys(StartSchema.properties.tasks.items.properties), [
		"label",
		"task",
		"cwd",
		"model",
		"tools",
	]);
	assert.equal(Reflect.get(StartSchema.properties.tasks.items, "additionalProperties"), false);
	assert.deepEqual(StartSchema.properties.tasks.items.required, ["task", "tools"]);
}

async function checkUserPanel(): Promise<void> {
	const originalKeys = getKeybindings();
	const keys = new TuiKeybindingsManager(TUI_KEYBINDINGS, {
		"tui.select.confirm": "ctrl+x",
		"tui.select.cancel": "ctrl+g",
	}) as KeybindingsManager;
	setKeybindings(keys);
	const enter = "\x18";
	const back = "\x07";
	const down = "\x1b[B";
	let renders = 0;
	let closed = 0;
	const terminal = { rows: 42 };
	const tui = { terminal, requestRender: () => renders++ } as unknown as TUI;
	const releases = new Map<string, () => void>();
	const requests = new Map<string, ChildLaunchRequest>();
	const scheduler = new SubagentScheduler(2, async (request, signal, update) => {
		requests.set(request.commission.id, request);
		update?.({ ...executionResult("completed"), latestText: `Working on ${request.commission.label}.` });
		await new Promise<void>((resolve) => {
			releases.set(request.commission.id, resolve);
			signal.addEventListener("abort", () => resolve(), { once: true });
		});
		return {
			...executionResult(signal.aborted ? "cancelled" : "completed", request),
			output: signal.aborted ? "Useful partial work." : `${"A result line.\n".repeat(64)}END_OF_RESULT`,
		};
	});
	const panel = new SubagentPanel(scheduler, tui, plainTheme, keys, () => closed++);
	try {
		assert(renderText(panel).includes("No subagents in this session."));
		assert(!renderText(panel).includes("inspect"), "An empty view should offer only useful actions.");
		panel.handleInput(back);
		assert.equal(closed, 1);
		const prepared = [0, 1, 2].map((index) => preparedCommission(index, []));
		const [first, second, third] = prepared.map((entry) => entry.spec.id);
		await scheduler.admit({ batchId: prepared[0].spec.batchId, background: true, prepared });
		await until(() => requests.size === 2);
		assert(renderText(panel).includes("3 outstanding"));
		panel.handleInput(down);
		panel.handleInput(down);
		panel.handleInput(enter);
		assert(renderText(panel).includes("child-2"));
		panel.handleInput(enter);
		assert(renderText(panel).includes("Cancel child-2?"));
		panel.handleInput(enter); // Safe default: do not cancel.
		assert.equal(scheduler.targets([third])[0].state, "queued");
		panel.handleInput(enter);
		panel.handleInput(down);
		panel.handleInput(enter);
		await until(() => scheduler.targets([third])[0].state === "cancelled");
		await until(() => renderText(panel).includes("back"));
		assert.equal(scheduler.targets([first])[0].state, "running");
		assert.equal(scheduler.targets([second])[0].state, "running");
		panel.handleInput(back);
		assert(renderText(panel).includes("Show collected history"));
		panel.handleInput(enter); // First child remains selected after returning.
		requests.get(first)!.onMessage?.("A useful finding, not yet delivered to the parent.");
		assert(renderText(panel).includes("child-0"));
		assert.equal(scheduler.targets([first])[0].messages?.[0].delivered, false);
		panel.handleInput(enter);
		assert(renderText(panel).includes("Cancel child-0?"));
		releases.get(first)!();
		await until(() => scheduler.targets([first])[0].state === "completed");
		assert(!renderText(panel).includes("Cancel child-0?"), "Completion must retire stale confirmation.");
		assert(
			scheduler.runs().some((run) => run.id === first),
			"Human inspection must not collect a parent result.",
		);
		for (let page = 0; page < 12; page++) {
			panel.render(80);
			panel.handleInput("\x1b[6~");
		}
		assert(renderText(panel).includes("END_OF_RESULT"), "The full result must be reachable.");
		for (const width of [24, 44, 80, 120]) {
			terminal.rows = 24;
			panel.invalidate();
			assert(panel.render(width).every((line) => visibleWidth(line) <= width));
		}
		const notice = scheduler.notices().find((entry) => entry.child.id === first)!;
		scheduler.markNotified(first, notice.completion, notice.messages);
		scheduler.acknowledge([first]);
		for (let page = 0; page < 12; page++) {
			panel.render(120);
			panel.handleInput("\x1b[6~");
		}
		assert(renderText(panel).includes("END_OF_RESULT"), "Collection must not discard the selected human view.");
		panel.handleInput(back);
		panel.handleInput(enter); // Inspect the remaining running child.
		assert(renderText(panel).includes("child-1"));
		panel.handleInput(enter);
		panel.handleInput(down);
		panel.handleInput(enter);
		await until(() => scheduler.targets([second])[0].state === "cancelled");
		await until(() => renderText(panel).includes("back"));
		assert(renderText(panel).includes("Useful partial work."));
		panel.handleInput(back);
		panel.handleInput(enter); // Only the history toggle remains.
		assert(renderText(panel).includes("Subagents · history"));
		assert(renderText(panel).includes("child-0"));
		panel.handleInput(enter);
		await scheduler.reset();
		assert(!renderText(panel).includes("child-0"), "Reset must clear stale selection and details.");
		panel.dispose();
		const before = renders;
		await scheduler.admit({ batchId: "batch-positive", background: true, prepared: [preparedCommission(3, [])] });
		assert.equal(renders, before, "Disposed panels must unsubscribe.");

		let registered = false;
		registerSubagentCommands(
			{
				registerCommand: (name, command) => {
					assert.equal(name, "subagents");
					assert.equal(typeof command.handler, "function");
					registered = true;
				},
			} as ExtensionAPI,
			scheduler,
		);
		assert(registered);
	} finally {
		panel.dispose();
		await scheduler.shutdown();
		setKeybindings(originalKeys);
	}
}

async function checkSiblingFailureIsolation(): Promise<void> {
	const completed: string[] = [];
	const execute: typeof runChild = async (request) => {
		if (request.commission.index === 1) {
			return {
				...executionResult("failed", request),
				error: "intentional child failure",
			};
		}
		completed.push(request.commission.id);
		return executionResult("completed", request);
	};
	const scheduler = new SubagentScheduler(2, execute);
	const disposed: string[] = [];
	const prepared = Array.from({ length: 3 }, (_, index) => preparedCommission(index, disposed));
	const batch = await scheduler.admit({
		batchId: prepared[0].spec.batchId,
		background: false,
		prepared,
	});
	const settled = await scheduler.wait(prepared.map((entry) => entry.spec.id));
	assert.deepEqual(
		settled.map((child) => child.state),
		["completed", "failed", "completed"],
	);
	assert.deepEqual(completed, [prepared[0].spec.id, prepared[2].spec.id]);
	assert.equal(disposed.length, 3);
	await scheduler.shutdown();
}

async function checkSessionShutdown(): Promise<void> {
	const started: string[] = [];
	const execute: typeof runChild = async (request, signal) => {
		started.push(request.commission.id);
		await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
		return executionResult("cancelled", request);
	};
	const scheduler = new SubagentScheduler(1, execute);
	const disposed: string[] = [];
	const prepared = [preparedCommission(0, disposed), preparedCommission(1, disposed)];
	const batch = await scheduler.admit({
		batchId: prepared[0].spec.batchId,
		background: true,
		prepared,
	});
	await until(() => started.length === 1);
	await scheduler.shutdown();
	const [settled] = scheduler.targets(prepared.map((entry) => entry.spec.id));
	assert.equal(settled.state, "cancelled");
	assert.equal(disposed.length, 2);
	const rejectedDisposed: string[] = [];
	await assert.rejects(
		scheduler.admit({
			batchId: "batch-after-shutdown",
			background: true,
			prepared: [preparedCommission(2, rejectedDisposed)],
		}),
		/shutting down/,
	);
	assert.equal(rejectedDisposed.length, 1);
	await scheduler.reset();
	assert.deepEqual(scheduler.list(), []);
	const fresh = preparedCommission(3, []);
	await scheduler.admit({ batchId: fresh.spec.batchId, background: true, prepared: [fresh] });
	await scheduler.shutdown();
}

async function checkCleanupFailureIsVisible(): Promise<void> {
	const execute: typeof runChild = async (request) => executionResult("completed", request);
	const scheduler = new SubagentScheduler(1, execute);
	const prepared: PreparedCommission = {
		...preparedCommission(0, []),
		contributions: [
			{
				id: "failing-cleanup",
				args: [],
				metadata: {},
				dispose: async () => {
					throw new Error("intentional cleanup failure");
				},
			},
		],
	};
	const batch = await scheduler.admit({
		batchId: prepared.spec.batchId,
		background: false,
		prepared: [prepared],
	});
	const [settled] = await scheduler.wait([prepared.spec.id]);
	assert.equal(settled.state, "failed");
	assert(settled.kind === "child" && settled.result?.error?.includes("intentional cleanup failure"));
	assert(formatTargets([settled]).includes("intentional cleanup failure"));
	await scheduler.shutdown();
}

async function checkWorkspaceCleanupFailureIsVisible(): Promise<void> {
	const prepared = preparedCommission(0, []);
	const controller = new AbortController();
	controller.abort();
	const result = await runChild(
		{
			commission: prepared.spec,
			intent: prepared.intent,
			contributions: [],
			workspaceChildren: {
				async prepareChild() {
					return {
						args: [],
						hostCwd: prepared.spec.cwd,
						dispose: async () => {
							throw new Error("intentional workspace cleanup failure");
						},
					};
				},
			},
			artifacts: { persistent: false },
			systemPrompt: "Complete the commission.",
		},
		controller.signal,
	);
	assert.equal(result.outcome, "failed");
	assert(result.error?.includes("Child run was cancelled."));
	assert(result.error?.includes("intentional workspace cleanup failure"));
}

async function checkLaunchAndCleanupFailuresAreBothVisible(): Promise<void> {
	const prepared = preparedCommission(0, []);
	await assert.rejects(
		runChild(
			{
				commission: prepared.spec,
				intent: prepared.intent,
				contributions: [
					{
						id: "environment-collision",
						args: [],
						env: { DUPLICATE_ENV: "contribution" },
						metadata: {},
						dispose: async () => undefined,
					},
				],
				workspaceChildren: {
					async prepareChild() {
						return {
							args: [],
							hostCwd: prepared.spec.cwd,
							env: { DUPLICATE_ENV: "workspace" },
							dispose: async () => {
								throw new Error("intentional workspace cleanup failure");
							},
						};
					},
				},
				artifacts: { persistent: false },
				systemPrompt: "Complete the commission.",
			},
			new AbortController().signal,
		),
		(error: unknown) =>
			error instanceof Error &&
			error.message.includes("both set environment variable") &&
			error.message.includes("intentional workspace cleanup failure"),
	);
}

async function checkProviderFailureIsVisible(): Promise<void> {
	const batchId = `batch-${randomUUID()}`;
	const spec = resolveCommission({
		commission: { task: "Exercise provider failure handling.", tools: [] },
		index: 0,
		batchId,
		toolCallId: "tool-provider-failure",
		cwd: process.cwd(),
		parentModel: { provider: "provider", id: "model" },
		privacy: { clientZdr: true, remoteZdr: false },
		toolProviders: noExtensionTools,
	});
	const result = await runChild(
		{
			commission: spec,
			intent: childIntent(spec),
			contributions: [
				{
					id: "provider-error-fixture",
					args: [],
					env: { PI_SUBAGENT_CHECK_CHILD: "provider-error" },
					metadata: {},
					dispose: async () => undefined,
				},
			],
			artifacts: { persistent: false },
			systemPrompt: "Complete the commission.",
		},
		new AbortController().signal,
	);
	assert.equal(result.exitCode, 0, completeOutput(result));
	assert.equal(result.outcome, "failed");
	assert.equal(result.output, "useful partial response");
	assert.equal(result.error, "intentional provider failure");
	assert.equal(result.model, "reported-model");
	assert.equal(result.usage.input, 3);
	assert.equal(result.usage.cost, 0.25);
}

async function runChildFixture(
	name:
		| "signal-exit"
		| "empty-success"
		| "cancel-wait"
		| "cancel-inherited-quiet"
		| "cancel-inherited-writer"
		| "cancel-inherited-hard"
		| "inherited-tail"
		| "activity-log"
		| "context-usage"
		| "launch-options",
	signal = new AbortController().signal,
	onProgress?: Parameters<typeof runChild>[2],
	thinkingLevel?: ResolvedCommission["thinkingLevel"],
): Promise<ChildExecutionResult> {
	const batchId = `batch-${randomUUID()}`;
	const spec = resolveCommission({
		commission: { task: `Exercise ${name} handling.`, tools: [] },
		index: 0,
		batchId,
		toolCallId: `tool-${name}`,
		cwd: process.cwd(),
		thinkingLevel,
		parentModel: { provider: "provider", id: "model" },
		privacy: { clientZdr: true, remoteZdr: false },
		toolProviders: noExtensionTools,
	});
	return runChild(
		{
			commission: spec,
			intent: childIntent(spec),
			contributions: [
				{
					id: `${name}-fixture`,
					args: [],
					env: { PI_SUBAGENT_CHECK_CHILD: name },
					metadata: {},
					dispose: async () => undefined,
				},
			],
			artifacts: { persistent: false },
			systemPrompt: "Complete the commission.",
		},
		signal,
		onProgress,
	);
}

async function checkSignalAndProtocolFailuresAreVisible(): Promise<void> {
	const signalled = await runChildFixture("signal-exit");
	assert.equal(signalled.outcome, "failed");
	assert.equal(signalled.exitSignal, "SIGTERM");
	assert(signalled.error?.includes("terminated by SIGTERM"));

	const empty = await runChildFixture("empty-success");
	assert.equal(empty.exitCode, 0);
	assert.equal(empty.outcome, "failed");
	assert(empty.error?.includes("without a final assistant message"));
}

async function checkRealChildCancellation(): Promise<void> {
	const tail = await runChildFixture("inherited-tail");
	assert.equal(tail.outcome, "completed", completeOutput(tail));
	assert.equal(tail.output, "Trailing response.");
	const controller = new AbortController();
	let cancellationRequested = false;
	const result = await runChildFixture("cancel-wait", controller.signal, (update) => {
		if (!update.toolCalls.some((tool) => tool.name === "fixture_wait" && tool.status === "running")) return;
		cancellationRequested = true;
		controller.abort();
	});
	assert.equal(cancellationRequested, true);
	assert.equal(result.outcome, "cancelled");
	assert(result.error?.includes("cancelled"));
	assert.equal(result.toolCalls[0]?.status, "cancelled");
	for (const mode of ["cancel-inherited-quiet", "cancel-inherited-writer", "cancel-inherited-hard"] as const) {
		const controller = new AbortController();
		let descendantPid: number | undefined;
		let started = 0;
		try {
			const result = await runChildFixture(mode, controller.signal, (update) => {
				if (controller.signal.aborted) return;
				const call = update.toolCalls.find((tool) => tool.name === "fixture_wait");
				if (!call) return;
				descendantPid = JSON.parse(call.preview).descendantPid;
				started = performance.now();
				controller.abort();
			});
			assert(descendantPid !== undefined);
			assert.equal(result.outcome, "cancelled", completeOutput(result));
			assert.equal(result.output, "Useful partial output before cancellation.");
			assert(performance.now() - started < (mode === "cancel-inherited-hard" ? 5_000 : 1_500));
		} finally {
			controller.abort();
			if (descendantPid !== undefined) {
				try {
					process.kill(descendantPid, "SIGTERM");
				} catch {
					/* Fixture may already have exited. */
				}
			}
		}
	}
}

async function checkLiveChildInput(): Promise<void> {
	for (const mode of ["interactive", "input-rejection", "invalid-state"]) {
		const seed = preparedCommission(0, []);
		const prepared = {
			...seed,
			spec: { ...seed.spec, cwd: process.cwd() },
			intent: { ...seed.intent, cwd: process.cwd() },
		};
		let control: Parameters<NonNullable<ChildLaunchRequest["onControl"]>>[0] | undefined;
		const messages: string[] = [];
		const inputs: Promise<void>[] = [];
		let finalSteer = false;
		const result = await runChild(
			{
				commission: prepared.spec,
				intent: prepared.intent,
				artifacts: { persistent: false },
				contributions: [
					{
						id: "rpc-fixture",
						args: [],
						env: { PI_SUBAGENT_CHECK_CHILD: mode },
						metadata: {},
						dispose: async () => {},
					},
				],
				systemPrompt: "Complete the task.",
				onControl(value) {
					control = value;
					if (mode === "interactive") inputs.push(value.send("Early direction."));
				},
				onMessage(message) {
					messages.push(message);
					if (mode === "interactive") inputs.push(control!.send("Follow the finding."));
					if (mode === "input-rejection")
						inputs.push(assert.rejects(control!.send("Rejected direction."), /Input intentionally rejected/));
				},
			},
			new AbortController().signal,
			(update) => {
				if (mode === "interactive" && update.latestText === "Follow the finding." && !finalSteer) {
					finalSteer = true;
					inputs.push(control!.send("Final correction."));
				}
			},
		);
		await Promise.all(inputs);
		assert.deepEqual(messages, ["A useful finding."]);
		assert.equal(result.outcome, mode === "invalid-state" ? "failed" : "completed", completeOutput(result));
		if (mode === "interactive") assert.equal(result.output, "Final correction.");
		if (mode === "invalid-state") assert(result.error?.includes("invalid settlement state"));
		await assert.rejects(control!.send("Too late."), /no longer accepting/);
	}
}

async function checkMessageOwnershipAndIndividualDelivery(): Promise<void> {
	const finish = new Map<string, () => void>();
	const received: string[] = [];
	const scheduler = new SubagentScheduler(1, async (request, signal, update) => {
		request.onControl?.({
			send: async (message) => {
				received.push(message);
			},
		});
		request.onMessage?.(`Finding from ${request.commission.label}.`);
		update?.({ ...executionResult("completed"), latestText: "Useful ordinary progress." });
		await new Promise<void>((resolve) => {
			finish.set(request.commission.id, resolve);
			signal.addEventListener("abort", () => resolve(), { once: true });
		});
		return executionResult(signal.aborted ? "cancelled" : "completed", request);
	});
	const handlers = new Map<string, (event: unknown, context: ExtensionContext) => unknown>();
	const announcements: string[] = [];
	const updateDetails: (readonly SubagentUpdate[])[] = [];
	let idle = true;
	const ctx = {
		isIdle: () => idle,
		hasPendingMessages: () => false,
		ui: { setStatus() {} },
	} as unknown as ExtensionToolContext;
	registerBackgroundRuns(
		{
			registerMessageRenderer() {},
			on: (name: string, handler: (event: unknown, context: ExtensionContext) => unknown) => {
				handlers.set(name, handler);
			},
			sendMessage: (message: { content: string; details: readonly SubagentUpdate[] }) => {
				announcements.push(message.content);
				updateDetails.push(message.details);
				idle = false;
			},
		} as unknown as ExtensionAPI,
		scheduler,
	);
	await handlers.get("session_start")?.({}, ctx);
	const children = [0, 1, 2].map((index) => preparedCommission(index, []));
	await scheduler.admit({ batchId: children[0].spec.batchId, background: true, prepared: children });
	const [first, second, third] = children.map((child) => child.spec.id);
	assert((await scheduler.send(second, "Queued direction.")).startsWith("Queued"));
	await scheduler.send(third, "Cancelled direction.");
	await scheduler.cancel([third]);
	assert(scheduler.targets([third])[0].messages?.[0].error?.includes("cancelled"));
	assert.equal(
		scheduler.runs().some((child) => child.id === third),
		false,
	);
	await Promise.resolve();
	assert(announcements[0].includes("Finding from child-0"));
	assert(formatList(scheduler.targets([first]), true).includes("From child (announced)"));
	assert(!formatList(scheduler.targets([first]), true).includes("From child (notification pending)"));
	assert.deepEqual(updateDetails[0], [
		{ id: first, label: "child-0", messages: ["Finding from child-0."], state: undefined, error: undefined },
	]);
	assert.equal(scheduler.targets([first])[0].latestText, "Useful ordinary progress.");
	finish.get(first)!();
	await scheduler.wait([first]);
	assert.equal(scheduler.targets([second])[0].state, "running");
	assert.deepEqual(received, ["Queued direction."]);
	idle = true;
	await handlers.get("agent_settled")?.({}, ctx);
	await Promise.resolve();
	assert(announcements[1].includes(`${first} (child-0): completed`));
	assert(!announcements[1].includes(`${second} (child-1): completed`));
	assert.equal(updateDetails[1].find((update) => update.id === first)?.state, "completed");
	assert.equal(scheduler.targets([first])[0].collected, false);
	scheduler.acknowledge([first]);
	assert(!scheduler.runs().some((child) => child.id === first));
	assert(scheduler.runs({ includeCollected: true }).some((child) => child.id === first));
	await assert.rejects(scheduler.send(first, "Too late."), /completed/);
	finish.get(second)!();
	await scheduler.wait([second]);
	idle = true;
	await handlers.get("agent_settled")?.({}, ctx);
	await Promise.resolve();
	assert(announcements[2].includes(`${second} (child-1): completed`));
	await handlers.get("session_shutdown")?.({}, ctx);
	await scheduler.shutdown();
}

async function checkInputDuringCleanup(): Promise<void> {
	let cleanupStarted = false;
	let release!: () => void;
	const prepared = preparedCommission(0, []);
	prepared.contributions[0].dispose = async () => {
		cleanupStarted = true;
		await new Promise<void>((resolve) => {
			release = resolve;
		});
	};
	const scheduler = new SubagentScheduler(1, async () => executionResult("completed"));
	await scheduler.admit({ batchId: prepared.spec.batchId, background: true, prepared: [prepared] });
	await until(() => cleanupStarted);
	await assert.rejects(
		scheduler.send(prepared.spec.id, "Too late for execution."),
		/finished execution and is cleaning up/,
	);
	assert.equal(scheduler.targets([prepared.spec.id])[0].activity, "cleaning up");
	assert.equal(scheduler.targets([prepared.spec.id])[0].messages?.length, 0);
	release();
	await scheduler.wait([prepared.spec.id]);
	assert.equal(scheduler.targets([prepared.spec.id])[0].state, "completed");
	await scheduler.shutdown();
}

async function checkCollectionAndInspection(): Promise<void> {
	const scheduler = new SubagentScheduler(4, async (request) => ({
		...executionResult("completed", request),
		output: "雪".repeat(30_000),
	}));
	const tools = new Map<string, ToolDefinition>();
	registerSubagentTools(
		{
			on() {},
			registerMessageRenderer() {},
			registerTool: (tool: ToolDefinition) => {
				tools.set(tool.name, tool);
			},
			events: { on: () => () => {}, emit() {} },
		} as unknown as ExtensionAPI,
		scheduler,
		{ tools: noExtensionTools, policies: { prepare: async () => [] }, providers: { prepare: async () => [] } },
	);
	const invoke = async (name: string, params: ToolCall["arguments"], ctx = {} as ExtensionToolContext) => {
		const tool = tools.get(name)!;
		const args = validateToolArguments(tool, {
			type: "toolCall",
			id: "check",
			name,
			arguments: params,
		});
		return tool.execute("check", args, undefined, undefined, ctx);
	};
	const ctx = {
		cwd: isolatedRoot,
		privacy: { clientZdr: true, remoteZdr: false },
		thinkingLevel: "high",
		model: { provider: "provider", id: "model" },
		scopedModels: [],
		modelRegistry: {
			find: (_provider: string, id: string) => ({
				provider: "provider",
				id,
				contextWindow: id === "small" ? 32_000 : 128_000,
			}),
		},
	} as unknown as ExtensionToolContext;
	await assert.rejects(
		invoke("subagent", { tasks: [{ task: "Choose an execution mode.", tools: [] }] }, ctx),
		/background/,
	);
	assert.equal(scheduler.runs().length, 0, "Missing execution mode must fail before admission.");
	const foreground = await invoke(
		"subagent",
		{ tasks: [{ task: "A synthetic task.", tools: [] }], background: false },
		ctx,
	);
	assert(scheduler.runs().length === 1, "First foreground page must not collect a large result.");
	const id = scheduler.runs()[0].id;
	assert.equal(scheduler.runs()[0].contextWindow, 128_000);
	const page = resultPage(scheduler.targets([id]));
	assert(page.nextOffset !== undefined);
	const firstText = foreground.content.find((entry) => entry.type === "text")?.text;
	assert.equal(firstText, page.text);
	await invoke("subagent_wait", { ids: [id], offset: page.nextOffset });
	assert.equal(scheduler.runs().length, 0);
	const overview = await invoke("subagent_list", {});
	assert.equal((overview.details as SubagentToolDetails).omittedChildren, 1);
	const emptyView = renderText(
		renderSubagentResult(overview as AgentToolResult<SubagentToolDetails>, false, plainTheme),
	);
	assert(emptyView.includes("No outstanding subagents"));
	assert(emptyView.includes("1 collected · retained in history"));
	assert(!emptyView.includes("includeCollected="));
	assert(
		overview.content.some((entry) => entry.type === "text" && entry.text.includes("1 collected children omitted")),
	);
	const inspected = await invoke("subagent_list", { ids: [id] });
	assert(
		inspected.content.some((entry) => entry.type === "text" && entry.text.includes("Task preview: A synthetic task.")),
	);
	const compact = compactTargets([
		{
			...scheduler.targets([id])[0],
			latestText: "large".repeat(20_000),
			messages: [{ direction: "child", text: "message", createdAt: 0, delivered: false }],
		},
	])[0] as ChildView;
	assert.equal(compact.latestText, undefined);
	assert.equal(compact.messages, undefined);
	const detailed = {
		...scheduler.targets([id])[0],
		task: "雪".repeat(30_000),
		latestText: "雪".repeat(30_000),
		messages: Array.from({ length: 7 }, (_, index) => ({
			direction: "child" as const,
			text: `message-${index}: ${"雪".repeat(2600)}`,
			createdAt: index,
			delivered: false,
		})),
	};
	const recent = formatList([detailed], true);
	assert(Buffer.byteLength(recent) < 35_000);
	assert(recent.includes("message-6:"));
	assert(!recent.includes("message-0:"));
	assert(recent.includes('"messageOffset":0'));
	const earlier = formatList([detailed], true, 0);
	assert(earlier.includes("message-0:"));
	assert(earlier.includes('"messageOffset":3'));
	const history = Array.from({ length: 52 }, (_, index) => preparedCommission(index, []));
	await scheduler.admit({ batchId: history[0].spec.batchId, background: true, prepared: history });
	await scheduler.wait(history.map((child) => child.spec.id));
	const listing = await invoke("subagent_list", {});
	const compactList = renderText(
		renderSubagentResult(listing as AgentToolResult<SubagentToolDetails>, false, plainTheme),
	);
	assert(compactList.includes("44 more children"));
	assert(!compactList.includes(history[6].spec.id));
	assert((listing.details as SubagentToolDetails).moreChildren);
	const text = listing.content.find((entry) => entry.type === "text")?.text ?? "";
	assert(text.includes('"after":'));
	assert(text.includes(history[49].spec.id));
	assert(!text.includes(`${history[50].spec.id}:`));
	const continuation = await invoke("subagent_list", { after: history[49].spec.id });
	assert(continuation.content.some((entry) => entry.type === "text" && entry.text.includes(history[51].spec.id)));
	const lateParams = { id, message: "A late synthetic correction." };
	const late = await invoke("subagent_send", lateParams);
	const retainedLabel = (late.details as SubagentToolDetails).recipientLabel;
	assert(retainedLabel);
	await scheduler.reset();
	const sendTool = tools.get("subagent_send")!;
	const context = { args: lateParams, expanded: false, state: {} } as Parameters<
		NonNullable<ToolDefinition["renderCall"]>
	>[2];
	const restoredCall = sendTool.renderCall!(lateParams, plainTheme, context);
	sendTool.renderResult!(late, { expanded: false, isPartial: false }, plainTheme, context);
	assert(renderText(restoredCall).includes(retainedLabel));
	await invoke(
		"subagent",
		{ tasks: [{ task: "Use a smaller model.", tools: [], model: "small" }], background: true },
		ctx,
	);
	assert.equal(scheduler.runs().at(-1)?.contextWindow, 32_000);
	await scheduler.shutdown();
}

async function checkActivityLifecycleAndUsage(): Promise<void> {
	const updates: Parameters<NonNullable<Parameters<typeof runChild>[2]>>[0][] = [];
	const result = await runChildFixture("activity-log", new AbortController().signal, (update) => updates.push(update));
	assert.equal(result.outcome, "completed");
	assert.equal(result.output, "activity complete");
	assert.equal(result.usage.input, 30);
	assert.equal(result.usage.output, 5);
	assert.equal(result.usage.cacheRead, 10);
	assert.equal(result.usage.cacheWrite, 1);
	assert.equal(result.usage.cost, 0.03);
	assert.equal(result.progress.contextTokens, 32);
	assert.deepEqual(
		result.toolCalls.map((tool) => ({ id: tool.id, name: tool.name, status: tool.status, error: tool.error })),
		[
			{ id: "read-1", name: "read", status: "completed", error: undefined },
			{ id: "bash-1", name: "bash", status: "failed", error: "command failed" },
		],
	);
	assert(result.toolCalls.every((tool) => tool.finishedAt !== undefined && tool.finishedAt >= tool.startedAt));
	assert(updates.some((update) => update.usage.input === 10));
	assert(updates.some((update) => update.usage.input === 30));
	assert(updates.some((update) => update.progress.contextTokens === 16));
	assert(updates.some((update) => update.toolCalls.some((tool) => tool.id === "read-1" && tool.status === "running")));
	assert(
		updates.some(
			(update) =>
				update.toolCalls.filter((tool) => tool.status === "running").length === 2 &&
				update.toolCalls.map((tool) => tool.id).join(",") === "read-1,bash-1",
		),
	);
	assert(updates.some((update) => update.toolCalls.some((tool) => tool.id === "bash-1" && tool.status === "failed")));
	const contextUpdates: typeof updates = [];
	const contextResult = await runChildFixture("context-usage", new AbortController().signal, (update) =>
		contextUpdates.push(update),
	);
	assert.equal(contextResult.outcome, "completed");
	assert.equal(contextResult.progress.contextTokens, 6);
	assert(contextResult.usage.input > contextResult.progress.contextTokens);
	assert.equal(contextUpdates.find((update) => update.latestText === "Failed response.")?.progress.contextTokens, 6);
	assert.equal(
		contextUpdates.find((update) => update.latestText === "Failed after compaction.")?.progress.contextTokens,
		undefined,
	);
	assert.equal(contextUpdates.find((update) => update.latestText === "Zero usage.")?.progress.contextTokens, undefined);
	assert.equal(contextUpdates.at(-1)?.progress.contextTokens, 6);
}

function checkRecoverablePresentation(): void {
	const prepared = preparedCommission(0, []);
	const output = "line\n".repeat(20_000);
	const result = { ...executionResult("completed"), output };
	const runtimeDir = mkdtempSync(join(tmpdir(), "pi-subagent-output-"));
	const outputPath = join(runtimeDir, "output.md");
	const child: ChildView = {
		kind: "child" as const,
		id: prepared.spec.id,
		batchId: prepared.spec.batchId,
		index: 0,
		label: prepared.spec.label,
		state: "completed" as const,
		task: prepared.spec.task,
		cwd: prepared.spec.cwd,
		provider: prepared.spec.provider,
		model: prepared.spec.model,
		modelSource: prepared.spec.modelSource,
		tools: prepared.spec.tools,
		capabilities: prepared.spec.capabilities,
		runDir: runtimeDir,
		outputPath,
		createdAt: 1,
		finishedAt: 2,
		result,
	};
	try {
		finishChildArtifacts({ persistent: true, runDir: runtimeDir, outputPath }, child, result, []);
		const shortened = formatTargets([child]);
		assert(shortened.includes("More result: subagent_wait"));
		assert(!shortened.includes(outputPath));
		assert.equal(readFileSync(outputPath, "utf8"), output);
		assert.equal(child.result?.output, output);
		const ephemeral = formatTargets([{ ...child, outputPath: undefined }]);
		assert.equal(ephemeral, shortened);
		for (const content of [output, "🙂漢字".repeat(20_000)]) {
			const pagedChild = { ...child, result: { ...result, output: content } };
			let recovered = "";
			let offset = 0;
			for (;;) {
				const page = formatTargets([pagedChild], offset);
				const marker = page.lastIndexOf("\n\n[More result: subagent_wait ");
				if (marker === -1) {
					recovered += page;
					break;
				}
				recovered += page.slice(0, marker);
				const next = JSON.parse(page.slice(marker + "\n\n[More result: subagent_wait ".length, -1)) as {
					offset: number;
				};
				assert(next.offset > offset);
				offset = next.offset;
			}
			assert.equal(recovered, content);
		}
		assert.throws(() => formatTargets([child], -1), /Invalid result offset/);
		assert.throws(() => formatTargets([child], output.length + 1), /Invalid result offset/);
		const compact = compactTargets([child]);
		assert(!JSON.stringify(compact).includes(output));
		assert.equal(compact[0]?.kind, "child");
		if (compact[0]?.kind === "child") {
			assert.equal(compact[0].result, undefined);
			assert.equal(compact[0].usage, undefined);
			assert.equal(compact[0].toolCalls, undefined);
		}
	} finally {
		rmSync(runtimeDir, { recursive: true, force: true });
	}
}

function checkToolPresentationBounding(): void {
	const calls = Array.from({ length: 600 }, (_, index) => fixtureToolCall(`call-${index}`, "read", `file-${index}.ts`));
	const persistent = renderedChild(0, "large-log", "complete");
	const withCalls: ChildView = {
		...persistent,
		eventsPath: "/runs/large-log/events.jsonl",
		toolCalls: calls,
		result: persistent.result ? { ...persistent.result, toolCalls: calls } : undefined,
	};
	const [bounded] = childPresentations([withCalls]);
	assert.equal(bounded?.totalToolCalls, 600);
	assert.equal(bounded?.toolCalls.length, 500);
	assert.equal(bounded?.omittedToolCalls, 100);
	assert.equal(bounded?.toolCallHeadCount, 250);
	assert.equal(bounded?.toolCalls[0]?.id, "call-0");
	assert.equal(bounded?.toolCalls.at(-1)?.id, "call-599");

	const [ephemeral] = childPresentations([{ ...withCalls, eventsPath: undefined }]);
	assert.equal(ephemeral?.toolCalls.length, 600);
	assert.equal(ephemeral?.omittedToolCalls, 0);
}

function checkCompactArtifactStatusAndSafeNaming(): void {
	const runtimeDir = mkdtempSync(join(tmpdir(), "pi-subagent-status-"));
	const prepared = preparedCommission(0, []);
	const longLabelPrepared: PreparedCommission = {
		...prepared,
		spec: { ...prepared.spec, label: "x".repeat(10_000) },
	};
	try {
		const artifacts = createChildArtifacts({ persistent: true, childrenDir: runtimeDir }, longLabelPrepared);
		assert(artifacts.runDir);
		assert(basename(artifacts.runDir).length < 255);

		const child = renderedChild(0, "status", "complete");
		const toolCalls = [
			fixtureToolCall("completed", "read", "README.md"),
			fixtureToolCall("active", "grep", "pattern", "running"),
		];
		const statusPath = join(runtimeDir, "status.json");
		writeChildStatus({ persistent: true, statusPath }, { ...child, toolCalls });
		const status = JSON.parse(readFileSync(statusPath, "utf8")) as Record<string, unknown>;
		assert.equal(status.toolCalls, undefined);
		const activity = status.toolActivity as {
			total: number;
			active: Array<{ id: string }>;
			latest: { id: string };
		};
		assert.equal(activity.total, 2);
		assert.deepEqual(
			activity.active.map((tool) => tool.id),
			["active"],
		);
		assert.equal(activity.latest.id, "active");
	} finally {
		rmSync(runtimeDir, { recursive: true, force: true });
	}
}

function checkFailureDetailsPreserved(): void {
	const prepared = preparedCommission(0, []);
	const result: ChildExecutionResult = {
		...executionResult("failed"),
		output: "useful partial output",
		error: "specific failure",
		stderr: "diagnostic details\n",
	};
	const combined = completeOutput(result);
	assert(combined.includes(result.output));
	assert(combined.includes(result.error ?? ""));
	assert(combined.includes(result.stderr));

	const runtimeDir = mkdtempSync(join(tmpdir(), "pi-subagent-failure-"));
	const outputPath = join(runtimeDir, "output.md");
	const metaPath = join(runtimeDir, "meta.json");
	const child: ChildView = {
		kind: "child",
		id: prepared.spec.id,
		batchId: prepared.spec.batchId,
		index: 0,
		label: prepared.spec.label,
		state: "failed",
		task: prepared.spec.task,
		cwd: prepared.spec.cwd,
		provider: prepared.spec.provider,
		model: prepared.spec.model,
		modelSource: prepared.spec.modelSource,
		tools: prepared.spec.tools,
		capabilities: prepared.spec.capabilities,
		runDir: runtimeDir,
		outputPath,
		createdAt: 1,
		finishedAt: 2,
		result,
	};
	try {
		finishChildArtifacts({ persistent: true, runDir: runtimeDir, outputPath, metaPath }, child, result, []);
		assert.equal(readFileSync(outputPath, "utf8"), combined);
		const metadata = JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, unknown>;
		assert.equal(metadata.error, result.error);
		assert.equal(metadata.stderr, result.stderr);
	} finally {
		rmSync(runtimeDir, { recursive: true, force: true });
	}
}

function checkContextualRendering(): void {
	const first = renderedChild(0, "inspect-scheduler", "Scheduler capacity is released correctly.\nAdditional detail.");
	const second = renderedChild(1, "review-safety", "Safety grants remain scoped to each child.\nAdditional detail.");
	const batch: BatchView = {
		kind: "batch",
		id: "batch-11f72c78-fb56-4741-8d22-91d4c4b2df56",
		background: false,
		state: "completed",
		createdAt: 1_000,
		finishedAt: 8_000,
		children: [first, second],
	};
	const output = formatTargets([batch]);
	const result = renderedResult("wait", [batch], output);
	const compact = renderText(renderSubagentResult(result, false, plainTheme));
	assert(compact.includes("✓ 2 completed"));
	assert(compact.includes("2 completed"));
	assert(compact.split("\n")[0]?.includes("7.0s"));
	assert(compact.includes("4.0s"));
	assert(compact.includes("3 tools"));
	assert(compact.includes("↑4.0k ↓1.0k R8.0k"));
	assert(!compact.includes("$"));
	assert(compact.includes("inspect-scheduler"));
	assert(compact.includes("Scheduler capacity is released correctly."));
	assert(compact.includes("review-safety"));
	assert(compact.includes("Safety grants remain scoped to each child."));
	assert.equal(compact.match(/3 tools/gu)?.length, 1);
	assert(compact.includes("1 tool · ↑2.5k ↓700 R5.0k"));
	assert(compact.includes("2 tools · ↑1.5k ↓300 R3.0k"));

	const expanded = renderText(renderSubagentResult(result, true, plainTheme));
	assert(expanded.includes("Inspect scheduler behavior."));
	assert(expanded.includes("Review Safety behavior."));
	assert(expanded.includes("provider/model"));
	assert(expanded.includes("tools: read, grep"));
	assert(expanded.includes(first.id));
	assert(expanded.includes("context (last response) 8.2k/128k"));
	assert(!expanded.includes("$"));
	assert(expanded.includes("Tool calls · 1"));
	assert(expanded.includes("✓ read"));
	assert(expanded.includes("Tool calls · 2"));
	assert(expanded.includes("✗ grep"));
	assert(expanded.includes("pattern not found"));
	assert(expanded.includes("Result"));
	assert.equal(expanded.match(/Additional detail\./gu)?.length, 2);

	const running: ChildView = {
		...first,
		state: "running" as const,
		finishedAt: undefined,
		result: undefined,
		progress: first.progress ? { ...first.progress, durationMs: 2_000 } : undefined,
		usage: first.usage ? { ...first.usage } : undefined,
		toolCalls: [fixtureToolCall("active-read", "read", "scheduler.ts", "running")],
	};
	const queued: ChildView = {
		...second,
		state: "queued" as const,
		startedAt: undefined,
		finishedAt: undefined,
		result: undefined,
		progress: undefined,
		usage: undefined,
		toolCalls: undefined,
	};
	const activeBatch: BatchView = {
		...batch,
		state: "running",
		createdAt: Date.now() - 2_000,
		finishedAt: undefined,
		children: [running, queued],
	};
	const active = renderText(
		renderSubagentResult(renderedResult("start", [activeBatch], formatTargets([activeBatch])), false, plainTheme),
	);
	assert(active.includes("1 running · 1 queued"));
	assert(active.includes("read scheduler.ts"));
	assert(active.includes("review-safety"));
	assert(active.includes("↑2.5k ↓700 R5.0k"));
	const backgroundStart = renderText(
		renderSubagentResult(renderedResult("start", [{ ...activeBatch, background: true }], "Started"), false, plainTheme),
	);
	assert(backgroundStart.startsWith("Started in background"));
	assert(backgroundStart.includes(activeBatch.children[0].label));
	assert(!backgroundStart.includes(activeBatch.children[0].id));
	const pageResult = renderedResult("wait", [first], "SECOND_PAGE_CONTENT");
	pageResult.details.offset = 50_000;
	assert(renderText(renderSubagentResult(pageResult, false, plainTheme)).includes("SECOND_PAGE_CONTENT"));

	const call = renderText(
		renderSubagentCall(
			{
				tasks: [
					{ label: "inspect-scheduler", task: first.task },
					{ label: "review-safety", task: second.task },
				],
				background: true,
			},
			plainTheme,
		),
	);
	assert(call.includes("subagent ×2 background inspect-scheduler · review-safety"));

	const sent = { id: "child-9691cfaa-cbb5-43fe-9835-b25fae511bda", message: "Focus on cancellation, not scheduling." };
	const sendCall = renderText(renderSubagentSendCall(sent, false, plainTheme));
	assert(sendCall.includes("subagent → child-9691cfaa"));
	assert(sendCall.includes(sent.message));
	assert(!sendCall.includes("Ctrl+O"));
	const longMessage = { ...sent, message: "A deliberately long steering message. ".repeat(20) + "FINAL_INSTRUCTION" };
	const compactSend = renderSubagentSendCall(longMessage, false, plainTheme)
		.render(40)
		.map(stripTerminalSequences)
		.join("\n");
	assert(compactSend.replace(/\s+/gu, " ").includes("A deliberately long steering message."));
	assert(compactSend.includes("Ctrl+O full message"));
	assert(!compactSend.includes("FINAL_INSTRUCTION"));
	const expandedSend = renderText(renderSubagentSendCall(longMessage, true, plainTheme));
	assert(expandedSend.includes("FINAL_INSTRUCTION"));
	assert(!expandedSend.includes("Ctrl+O"));
	const multilineSend = renderText(
		renderSubagentSendCall(
			{ ...sent, message: "First line.\nSecond line.\nThird line.\nFourth line." },
			true,
			plainTheme,
		),
	);
	assert(multilineSend.includes("Second line."));
	assert(multilineSend.includes("Fourth line."));
	assert.doesNotThrow(() => renderText(renderSubagentSendCall({}, false, plainTheme)));

	const listed = renderText(
		renderSubagentResult(renderedResult("list", [batch], formatList([batch])), false, plainTheme),
	);
	assert(listed.includes("2 children"));
	assert(!listed.includes("batch-11f72c78"));
	assert(listed.includes("child-render-0"));
	assert(listed.includes("1 tool"));
	assert(listed.includes("↑2.5k ↓700 R5.0k"));
	assert(listed.includes("result"));

	if (!first.result) throw new Error("expected rendered child result");
	const cancelledChild: ChildView = {
		...first,
		state: "cancelled" as const,
		result: {
			...first.result,
			outcome: "cancelled" as const,
			output: "Useful partial output.",
			error: "Child run was cancelled.",
		},
	};
	const cancelled = renderText(
		renderSubagentResult(
			renderedResult("cancel", [cancelledChild], formatTargets([cancelledChild])),
			false,
			plainTheme,
		),
	);
	assert(cancelled.includes("– 1 cancelled"));
	assert(cancelled.includes("Useful partial output."));
	assert.equal(cancelled.match(/Child run was cancelled\./gu)?.length, 1);
	assert.equal(formatTargets([cancelledChild]), "Useful partial output.\n\nChild run was cancelled.");
	assert(!cancelled.includes("Cancellation settled"));
}

function checkCommunicationRendering(): void {
	const id = "child-9691cfaa-cbb5-43fe-9835-b25fae511bda";
	const update: SubagentUpdate = {
		id,
		label: "slow file census",
		messages: ["ACK-TO-PARENT — 5/25 files processed; stopping per-file census now per steering."],
	};
	const compact = renderText(
		renderSubagentUpdates({ details: [update] }, { expanded: false, outputPad: 1 }, plainTheme)!,
	);
	assert(compact.includes("← slow file census · child-9691cfaa"));
	assert(compact.includes("ACK-TO-PARENT"));
	assert(!compact.includes(id));
	assert(!compact.includes("subagent-update"));
	assert(!compact.includes("Subagent updates:"));
	assert.equal(renderSubagentUpdates({}, { expanded: false, outputPad: 1 }, plainTheme), undefined);
	const long = { ...update, messages: ["First finding.\nSecond finding.\nThird finding.\nFINAL_FINDING"] };
	const collapsed = renderText(
		renderSubagentUpdates({ details: [long] }, { expanded: false, outputPad: 1 }, plainTheme)!,
	);
	assert(collapsed.includes("Ctrl+O full message"));
	assert(!collapsed.includes("FINAL_FINDING"));
	const expanded = renderText(
		renderSubagentUpdates({ details: [long] }, { expanded: true, outputPad: 1 }, plainTheme)!,
	);
	assert(expanded.includes("FINAL_FINDING"));
	assert(expanded.includes(id));
	const terminal = renderText(
		renderSubagentUpdates(
			{ details: [{ ...update, messages: [], state: "failed", error: "Worker upload refused." }] },
			{ expanded: false, outputPad: 1 },
			plainTheme,
		)!,
	);
	assert(terminal.includes("✗ slow file census"));
	assert(terminal.includes("failed · result ready"));
	assert(terminal.includes("Worker upload refused."));
	assert(!terminal.includes("subagent_wait"));
	const many = {
		...update,
		messages: Array.from({ length: 8 }, (_, index) => `FINDING_${index}`),
		state: "completed" as const,
	};
	const bounded = renderText(
		renderSubagentUpdates({ details: [many] }, { expanded: false, outputPad: 1 }, plainTheme)!,
	);
	assert(bounded.includes("FINDING_5"));
	assert(!bounded.includes("FINDING_6"));
	assert(bounded.includes("3 more updates"));
	const complete = renderText(
		renderSubagentUpdates({ details: [many] }, { expanded: true, outputPad: 1 }, plainTheme)!,
	);
	assert(complete.includes("FINDING_7"));
	assert(complete.includes("result ready"));
	const hiddenFailure = renderText(
		renderSubagentUpdates(
			{ details: [{ ...many, state: "failed", error: "Worker failed." }] },
			{ expanded: false, outputPad: 1 },
			plainTheme,
		)!,
	);
	assert(hiddenFailure.includes("1 failed"));
	for (const width of [20, 40, 80, 120]) {
		const component = renderSubagentUpdates(
			{ details: [long, { ...update, messages: [], state: "completed" }] },
			{ expanded: false, outputPad: 1 },
			plainTheme,
		)!;
		assert(component.render(width).every((line) => visibleWidth(line) <= width));
	}
	const child = {
		...renderedChild(0, "slow file census", "Result text."),
		id,
		latestText: "Latest ordinary assistant text.",
		messages: [
			{ direction: "parent" as const, text: "Change direction.", createdAt: 0, delivered: true },
			{ direction: "child" as const, text: "Direction changed.", createdAt: 1, delivered: true },
		],
	};
	const inspection = renderedResult("list", [child], formatList([child], true));
	inspection.details.presentations = inspectionPresentations([child]);
	const focused = renderText(renderSubagentResult(inspection, true, plainTheme));
	assert(focused.includes("→ To child · accepted for processing"));
	assert(focused.includes("← From child · announced"));
	const modelInspection = formatList([child], true);
	assert(modelInspection.includes("Tokens (cumulative): 2500 input, 700 output, 5000 cache read, 0 cache write"));
	assert(!modelInspection.includes("cost"));
	assert(modelInspection.includes("Context (last response): 8200 / 128000 tokens."));
	assert(formatList([{ ...child, progress: undefined }]).includes("Context (last response): unknown / 128000 tokens."));
	assert(focused.includes("Direction changed."));
	assert(focused.includes("Latest ordinary assistant text."));
	assert(focused.includes(id));
	assert(!focused.includes("Task preview:"));
	const send = renderText(
		renderSubagentSendCall({ id, label: child.label, message: "Change direction." }, false, plainTheme),
	);
	assert(send.includes("subagent → slow file census · child-9691cfaa"));
	const receipt = renderText(
		renderSubagentResult(renderedResult("send", [], "Accepted for processing."), false, plainTheme),
	);
	assert.equal(receipt, "Accepted for processing");
	const rejected = renderedResult("send", [], "Child has finished execution; collect its result.");
	rejected.details.error = "Child has finished execution; collect its result.";
	assert(renderText(renderSubagentResult(rejected, false, plainTheme)).includes("finished execution"));
}

function renderedChild(index: number, label: string, output: string): ChildView {
	const startedAt = 2_000 + index * 2_000;
	const durationMs = 3_000 + index * 1_000;
	const usage: ChildUsage = {
		input: index === 0 ? 2_500 : 1_500,
		output: index === 0 ? 700 : 300,
		cacheRead: index === 0 ? 5_000 : 3_000,
		cacheWrite: 0,
		cost: 0.25,
	};
	const toolCalls = Array.from({ length: index + 1 }, (_, toolIndex) =>
		fixtureToolCall(
			`${label}-${toolIndex}`,
			toolIndex === 0 ? "read" : "grep",
			toolIndex === 0 ? "README.md" : "pattern",
		),
	);
	if (index === 1 && toolCalls[1]) {
		toolCalls[1] = { ...toolCalls[1], status: "failed", error: "pattern not found" };
	}
	const result: ChildExecutionResult = {
		outcome: "completed",
		output,
		stderr: "",
		toolCalls,
		usage,
		progress: {
			startedAt,
			durationMs,
			lastActivityAt: startedAt + durationMs,
			contextTokens: 8_200,
		},
	};
	return {
		kind: "child",
		id: `child-render-${index}-01234567-89ab-cdef`,
		batchId: "batch-11f72c78-fb56-4741-8d22-91d4c4b2df56",
		index,
		label,
		state: "completed",
		task: index === 0 ? "Inspect scheduler behavior." : "Review Safety behavior.",
		cwd: "/workspace/project",
		provider: "provider",
		model: "provider/model",
		contextWindow: 128_000,
		modelSource: "inherited",
		tools: ["read", "grep"],
		capabilities: ["read_files"],
		outputPath: `/runs/${label}/output.md`,
		createdAt: 1_000,
		startedAt,
		finishedAt: startedAt + durationMs,
		result,
		progress: result.progress,
		usage,
		toolCalls,
	};
}

function fixtureToolCall(
	id: string,
	name: string,
	preview: string,
	status: ChildToolCall["status"] = "completed",
): ChildToolCall {
	return {
		id,
		name,
		preview,
		status,
		startedAt: 2_000,
		finishedAt: status === "running" ? undefined : 2_100,
	};
}

function renderedResult(
	operation: SubagentToolDetails["operation"],
	targets: readonly (BatchView | ChildView)[],
	output: string,
): AgentToolResult<SubagentToolDetails> {
	return {
		content: [{ type: "text", text: output }],
		details: {
			operation,
			targets: compactTargets(targets),
			presentations: childPresentations(targets, operation !== "list"),
		},
	};
}

type RenderTheme = Parameters<typeof renderSubagentResult>[2];

const plainTheme = {
	fg: (_color: string, value: string) => value,
	bg: (_color: string, value: string) => value,
	bold: (value: string) => value,
} as unknown as RenderTheme;

function renderText(component: { render(width: number): string[] }): string {
	return component
		.render(120)
		.map((line) => stripTerminalSequences(line).trimEnd())
		.join("\n")
		.trim();
}

function preparedCommission(index: number, disposed: string[]): PreparedCommission {
	const batchId = "batch-positive";
	const spec = resolveCommission({
		commission: { label: `child-${index}`, task: `Complete task ${index}.`, tools: [] },
		index,
		batchId,
		toolCallId: "tool-positive",
		cwd: "/workspace/project",
		parentModel: { provider: "provider", id: "model" },
		privacy: { clientZdr: true, remoteZdr: false },
		toolProviders: noExtensionTools,
	});
	return {
		spec,
		intent: childIntent(spec),
		contributions: [
			{
				id: `policy-${index}`,
				args: [],
				metadata: {},
				dispose: async () => {
					disposed.push(spec.id);
				},
			},
		],
	};
}

function executionResult(outcome: ChildExecutionResult["outcome"], request?: ChildLaunchRequest): ChildExecutionResult {
	const now = Date.now();
	return {
		outcome,
		output: request ? `completed ${request.commission.label}` : "complete",
		error: outcome === "completed" ? undefined : "cancelled",
		stderr: "",
		toolCalls: [],
		usage: zeroUsage(),
		progress: {
			startedAt: now,
			durationMs: 1,
			lastActivityAt: now,
		},
	};
}

function zeroUsage(): ChildUsage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

async function until(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (predicate()) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}
	throw new Error("condition did not become true");
}

try {
	checkCommissionResolution();
	checkEffectAnalysis();
	await checkSchedulerWaves();
	await checkQueuedAndRunningCancellation();
	await checkBoundedWaiting();
	await checkCancellationSettlement();
	await checkBackgroundDelivery();
	checkTaskSchema();
	await checkUserPanel();
	await checkParentMessageTool();
	for (const thinking of ["high", "off", undefined] as const) {
		const result = await runChildFixture("launch-options", undefined, undefined, thinking);
		assert.equal(result.outcome, "completed", completeOutput(result));
		assert.deepEqual(JSON.parse(result.output), {
			thinking: thinking ?? null,
			model: "provider/model",
			clientZdr: true,
		});
	}
	await checkSiblingFailureIsolation();
	await checkSessionShutdown();
	await checkCleanupFailureIsVisible();
	await checkWorkspaceCleanupFailureIsVisible();
	await checkLaunchAndCleanupFailuresAreBothVisible();
	await checkProviderFailureIsVisible();
	await checkSignalAndProtocolFailuresAreVisible();
	await checkRealChildCancellation();
	await checkLiveChildInput();
	await checkMessageOwnershipAndIndividualDelivery();
	await checkInputDuringCleanup();
	await checkCollectionAndInspection();
	await checkActivityLifecycleAndUsage();
	checkRecoverablePresentation();
	checkToolPresentationBounding();
	checkCompactArtifactStatusAndSafeNaming();
	checkFailureDetailsPreserved();
	checkContextualRendering();
	checkCommunicationRendering();
	console.log("subagents positive checks: ok");
} finally {
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	rmSync(isolatedRoot, { recursive: true, force: true });
}
