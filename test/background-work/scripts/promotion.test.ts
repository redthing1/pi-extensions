import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import {
	createBashToolDefinition,
	createLocalBashOperations,
	initTheme,
} from "@earendil-works/pi-coding-agent";
import { registerBackgroundWork } from "../../../extensions/background-work/index.ts";

const { createHarness, createTestUiContext, getMessageText, getToolResult } =
	await import(
		pathToFileURL(
			join(
				process.env.PI_BACKGROUND_CHECKOUT!,
				"packages/coding-agent/test/suite/harness.ts",
			),
		).href
	);
const harnesses: Awaited<ReturnType<typeof createHarness>>[] = [];
const call = (args: Record<string, unknown>) =>
	fauxAssistantMessage(fauxToolCall("bash", args), { stopReason: "toolUse" });
const answer = (text: string) => fauxAssistantMessage(text);
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
async function setup() {
	initTheme("dark", false);
	let owner!: ReturnType<typeof registerBackgroundWork>;
	let launches = 0;
	const h = await createHarness({
		extensionFactories: [
			(pi) => {
				owner = registerBackgroundWork(pi);
				const native = createBashToolDefinition("/", {
					commandPrefix: "export SYNTHETIC_PREFIX=preserved",
					operations: {
						...createLocalBashOperations(),
						exec(...args) {
							launches++;
							return createLocalBashOperations().exec(...args);
						},
					},
				});
				pi.registerTool(native);
			},
		],
		settings: { compaction: { enabled: false }, retry: { enabled: false } },
	});
	harnesses.push(h);
	await h.session.bindExtensions({
		mode: "tui",
		uiContext: createTestUiContext(),
	});
	const script = join(h.tempDir, "worker.mjs");
	writeFileSync(
		script,
		`import fs from 'node:fs';import {setTimeout as delay} from 'node:timers/promises';fs.appendFileSync('launches','one\\n');fs.writeFileSync('pid',String(process.pid));console.log('before:'+process.env.SYNTHETIC_PREFIX);while(!fs.existsSync('release'))await delay(10);console.log('after');fs.writeFileSync('finished','done');`,
	);
	return {
		h,
		owner,
		command: `exec ${quote(process.execPath)} ${quote(script)}`,
		launches: () => launches,
	};
}
afterEach(async () => {
	vi.useRealTimers();
	for (const h of harnesses.splice(0)) {
		await h.session.extensionRunner.emit({
			type: "session_shutdown",
			reason: "exit",
		});
		h.cleanup();
	}
});

test("automatic promotion returns a receipt and retains the original execution deadline", async () => {
	initTheme("dark", false);
	let launched!: () => void;
	const started = new Promise<void>((resolve) => {
		launched = resolve;
	});
	let executions = 0;
	const h = await createHarness({
		extensionFactories: [
			(pi) => {
				registerBackgroundWork(pi);
				pi.registerTool(
					createBashToolDefinition("/", {
						operations: {
							async exec(_command, _cwd, { timeout, onData, signal }) {
								executions++;
								onData(Buffer.from("partial output"));
								await new Promise<void>((_resolve, reject) => {
									const timer = setTimeout(() => reject(new Error(`timeout:${timeout}`)), timeout! * 1000);
									signal?.addEventListener(
										"abort",
										() => {
											clearTimeout(timer);
											reject(new Error("aborted"));
										},
										{ once: true },
									);
									launched();
								});
								return { exitCode: 0 };
							},
						},
					}),
				);
			},
		],
		settings: { compaction: { enabled: false }, retry: { enabled: false } },
	});
	harnesses.push(h);
	await h.session.bindExtensions({ mode: "tui", uiContext: createTestUiContext() });
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	h.setResponses([call({ command: "controlled", timeout: 40 }), answer("Continued."), answer("Collected timeout.")]);
	const running = h.session.prompt("Run controlled work.");
	await started;
	await vi.advanceTimersByTimeAsync(30_000);
	await running;
	const receipt = h.eventsOfType("tool_execution_end").find((event) => event.toolName === "bash")!.result;
	expect(receipt.structuredContent).toEqual({ status: "running", jobId: "1" });
	expect(getMessageText(receipt)).toContain("Job 1 (controlled) is running in the background");
	expect(getMessageText(receipt)).not.toContain("The user chose");
	await vi.advanceTimersByTimeAsync(10_000);
	h.setResponses([
		fauxAssistantMessage(fauxToolCall("background_wait", { id: "1" }), { stopReason: "toolUse" }),
		answer("Inspected."),
	]);
	await h.session.prompt("Inspect the completed job.");
	const result = getMessageText(getToolResult(h, "background_wait"));
	expect(result).toContain("Command timed out after 40 seconds");
	expect(result).toContain("partial output");
	expect(executions).toBe(1);
});

test("ordinary calls preserve the native result and cannot be promoted after completion", async () => {
	const { h, owner } = await setup();
	h.setResponses([
		call({ command: 'printf "$SYNTHETIC_PREFIX"' }),
		answer("Done."),
	]);
	await h.session.prompt("Run normal Bash.");
	expect(getMessageText(getToolResult(h, "bash"))).toBe("preserved");
	expect(
		h.eventsOfType("tool_execution_end").find((e) => e.toolName === "bash")!
			.result.structuredContent.exit_code,
	).toBe(0);
	expect(
		h.eventsOfType("tool_execution_end").find((e) => e.toolName === "bash")!
			.result.structuredContent.status,
	).toBeUndefined();
	expect(owner.promote()).toBeUndefined();
	expect(h.session.messages.filter((m) => m.role === "custom")).toHaveLength(0);
});

test("promotion preserves the process, native prefix, output on both sides, and exactly one completion", async () => {
	const { h, owner, command, launches } = await setup();
	h.setResponses([
		call({ command }),
		answer("Foreground freed."),
		answer("Background completed."),
	]);
	const run = h.session.prompt("Run foreground work.");
	await vi.waitFor(() => expect(existsSync(join(h.tempDir, "pid"))).toBe(true));
	const pid = readFileSync(join(h.tempDir, "pid"), "utf8");
	const job = owner.promote();
	expect(job).toBeDefined();
	await run;
	const receipt = h
		.eventsOfType("tool_execution_end")
		.find((e) => e.toolName === "bash")!.result;
	expect(receipt.structuredContent).toEqual({
		status: "running",
		jobId: job!.id,
	});
	expect(receipt.structuredContent.exit_code).toBeUndefined();
	expect(getMessageText(receipt)).toContain(
		"The user chose to continue without waiting for job",
	);
	expect(owner.promote()).toBeUndefined();
	writeFileSync(join(h.tempDir, "release"), "go");
	await vi.waitFor(() =>
		expect(
			h.session.messages.some(
				(m) => getMessageText(m) === "Background completed.",
			),
		).toBe(true),
	);
	const notices = h.session.messages.filter((m) => m.role === "custom");
	expect(notices).toHaveLength(1);
	expect(getMessageText(notices[0])).toContain("before:preserved");
	expect(getMessageText(notices[0])).toContain("after");
	expect(launches()).toBe(1);
	expect(readFileSync(join(h.tempDir, "launches"), "utf8")).toBe("one\n");
	expect(readFileSync(join(h.tempDir, "pid"), "utf8")).toBe(pid);
});

test.each([false, true])("releasing a wait informs the model and preserves the job (muted=%s)", async (muted) => {
	const { h, owner, command, launches } = await setup();
	h.setResponses([call({ command, background: true }), answer("Started.")]);
	await h.session.prompt("Start work in the background.");
	await vi.waitFor(() => expect(existsSync(join(h.tempDir, "pid"))).toBe(true));
	const pid = Number(readFileSync(join(h.tempDir, "pid"), "utf8"));
	if (muted) await h.session.extensionRunner.emit({ type: "agent_settled", aborted: true });
	h.setResponses([
		fauxAssistantMessage(fauxToolCall("background_wait", { id: "1" }), { stopReason: "toolUse" }),
		answer("Wait released."),
	]);
	const run = h.session.prompt("Wait for the job.");
	await vi.waitFor(() => expect(h.eventsOfType("tool_execution_start").some((e) => e.toolName === "background_wait")).toBe(true));
	const job = owner.promote()!;
	expect(job).toBeDefined();
	await run;
	const result = getToolResult(h, "background_wait");
	expect(result.isError).toBeFalsy();
	expect(getMessageText(result)).toContain("The user chose to continue without waiting for job 1.");
	expect(getMessageText(result)).toContain(muted ? "Automatic completion notification is off" : "Completion will be reported automatically");
	if (muted) expect(getMessageText(result)).not.toContain("will be reported automatically");
	expect(() => process.kill(pid, 0)).not.toThrow();
	expect(job.wake).toBe(!muted);
	expect(job.announced).toBe(false);
	expect(owner.promote()).toBeUndefined();
	expect(launches()).toBe(1);
	if (!muted) h.setResponses([answer("Received completion.")]);
	writeFileSync(join(h.tempDir, "release"), "go");
	await job.done;
	if (!muted) await vi.waitFor(() => expect(h.getPendingResponseCount()).toBe(0));
	expect(h.session.messages.filter((m) => m.role === "custom")).toHaveLength(muted ? 0 : 1);
});

test("an interrupted promoted job stays muted across an unrelated user turn", async () => {
	const { h, owner, command } = await setup();
	let abort!: Promise<void>;
	h.setResponses([
		call({ command }),
		() => {
			abort = h.session.abort();
			return answer("Interrupted.");
		},
	]);
	const run = h.session.prompt("Run work.");
	await vi.waitFor(() => expect(existsSync(join(h.tempDir, "pid"))).toBe(true));
	const pid = Number(readFileSync(join(h.tempDir, "pid"), "utf8"));
	const job = owner.promote()!;
	await run;
	await abort;
	expect(() => process.kill(pid, 0)).not.toThrow();
	h.setResponses([answer("Four.")]);
	await h.session.prompt("Different topic: what is two plus two?");
	const runs = h.eventsOfType("agent_start").length;
	writeFileSync(join(h.tempDir, "release"), "go");
	await job.done;
	await new Promise((resolve) => setTimeout(resolve, 30));
	expect(h.eventsOfType("agent_start")).toHaveLength(runs);
	expect(h.session.messages.filter((m) => m.role === "custom")).toHaveLength(0);
	h.setResponses([
		(context) => {
			expect(
				context.messages.some(
					(m) => m.role === "custom" && m.customType === "background-result",
				),
			).toBe(false);
			return answer("Addressing this new request.");
		},
	]);
	await h.session.prompt("Another request.");
	expect(h.getPendingResponseCount()).toBe(0);
	expect(h.eventsOfType("agent_start")).toHaveLength(runs + 1);
});

test.each([undefined, "Interrupted by the user."])("interrupting before promotion preserves the cancellation cause (%s)", async (reason) => {
	const { h, owner, command } = await setup();
	h.setResponses([call({ command }), answer("Should not continue.")]);
	const run = h.session.prompt("Run foreground work.");
	await vi.waitFor(() => expect(existsSync(join(h.tempDir, "pid"))).toBe(true));
	const pid = Number(readFileSync(join(h.tempDir, "pid"), "utf8"));
	await h.session.abort(reason);
	await run;
	expect(() => process.kill(pid, 0)).toThrow();
	expect(owner.promote()).toBeUndefined();
	expect(h.session.messages.filter((m) => m.role === "custom")).toHaveLength(0);
	const diagnostic = reason ?? "Command aborted";
	expect(getMessageText(getToolResult(h, "bash"))).toContain(diagnostic);
	h.setResponses([(context) => {
		expect(context.messages.some((m) => m.role === "toolResult" && getMessageText(m).includes(diagnostic))).toBe(true);
		return answer("Addressing the new request.");
	}]);
	await h.session.prompt("Do something else.");
});

test("promotion preserves the original command timeout", async () => {
	const { h, owner, command } = await setup();
	h.setResponses([
		call({ command, timeout: 0.3 }),
		answer("Promoted."),
		answer("Received timeout."),
	]);
	const run = h.session.prompt("Run bounded work.");
	await vi.waitFor(() => expect(existsSync(join(h.tempDir, "pid"))).toBe(true));
	const job = owner.promote()!;
	expect(job).toBeDefined();
	await run;
	await job.done;
	await vi.waitFor(() =>
		expect(
			h.session.messages.some((m) => getMessageText(m) === "Received timeout."),
		).toBe(true),
	);
	expect(job.state).toBe("failed");
	expect(job.diagnostic).toContain("timed out");
	expect(job.preview).toBe("before:preserved\n");
});

test("promoted receipt settles the native renderer and remains compact when expanded", async () => {
	const { h } = await setup();
	const { ToolExecutionComponent } = await import(pathToFileURL(join(
		process.env.PI_BACKGROUND_CHECKOUT!, "packages/coding-agent/src/modes/interactive/components/tool-execution.ts",
	)).href);
	vi.useFakeTimers();
	try {
		const row = new ToolExecutionComponent("bash", "render", { command: "fixture" }, { argsComplete: true },
			h.session.getToolDefinition("bash"), { requestRender() {} }, h.tempDir);
		row.markExecutionStarted();
		row.updateResult({ content: [], isError: false }, true);
		expect(vi.getTimerCount()).toBe(1);
		row.updateResult({
			content: [{type: "text", text: "Model instructions: you can end this turn."}], isError: false,
			details: {backgroundWork: {receipt: "started", jobs: [{id: "7", label: "fixture", state: "running", preview: "", wake: true}]}},
		}, false);
		expect(vi.getTimerCount()).toBe(0);
		row.setExpanded(true);
		const text = row.render(80).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
		expect(text).toMatch(/\$ fixture[^\n]*\n\s+↳ running in background · #7/);
		expect(text).not.toContain("✓");
		expect(text).not.toContain("Model instructions");
		expect(vi.getTimerCount()).toBe(0);
	} finally {
		vi.useRealTimers();
	}
});
