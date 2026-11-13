import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import {
	createLocalBashOperations,
	initTheme,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import extension from "../../../extensions/background-work/index.ts";
import { createActiveWorkspacePublisher } from "../../../extensions/shared/active-workspace.ts";

const checkout = process.env.PI_BACKGROUND_CHECKOUT!;
const { createHarness, createTestUiContext, getMessageText, getToolResult } = await import(
	pathToFileURL(join(checkout, "packages/coding-agent/test/suite/harness.ts")).href
);
const harnesses: Awaited<ReturnType<typeof createHarness>>[] = [];
const call = (name: string, args: Record<string, unknown>) =>
	fauxAssistantMessage(fauxToolCall(name, name === "bash" ? { ...args, background: true } : args), {
		stopReason: "toolUse",
	});
const answer = (text: string) => fauxAssistantMessage(text);
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

async function controlled(extra?: (pi: ExtensionAPI, finish: () => Promise<void>) => void, exitCode = 0) {
	let finish!: () => void;
	const completion = new Promise<void>((resolve) => {
		finish = resolve;
	});
	const finishJob = async () => {
		finish();
		await new Promise<void>((resolve) => setImmediate(resolve));
	};
	const h = await setup([
		(pi) => {
			extra?.(pi, finishJob);
			pi.on("bash_launch", () => ({
				operations: {
					async exec(_command, _cwd, { onData }) {
						await completion;
						onData(Buffer.from("controlled completion"));
						return { exitCode };
					},
				},
			}));
		},
	]);
	return { h, finish: finishJob };
}

test.each([0, 7])("wait collects exit %i once without an automatic duplicate", async (exitCode) => {
	const { h, finish } = await controlled(undefined, exitCode);
	h.setResponses([
		call("bash", { command: "controlled" }),
		call("background_wait", { id: "1" }),
		answer("Used the prerequisite."),
	]);
	const running = h.session.prompt("Start work, then wait for its result.");
	try {
		await vi.waitFor(() =>
			expect(h.eventsOfType("tool_execution_start").some((e) => e.toolName === "background_wait")).toBe(true),
		);
		expect(h.eventsOfType("tool_execution_end").some((e) => e.toolName === "background_wait")).toBe(false);
	} finally {
		await finish();
	}
	await running;
	const result = getMessageText(getToolResult(h, "background_wait"));
	expect(result).toContain(`exit ${exitCode}`);
	expect(result).toContain("controlled completion");
	expect(h.session.messages.filter((m) => m.role === "custom")).toHaveLength(0);
	h.setResponses([call("background_wait", { id: "1" }), answer("Collected again.")]);
	await h.session.prompt("Inspect the finished prerequisite again.");
	expect(getMessageText(getToolResult(h, "background_wait"))).toBe(result);
	expect(h.getPendingResponseCount()).toBe(0);
});

test("completion at wait dispatch is collected before the delivery boundary", async () => {
	const { h } = await controlled((pi, finish) => {
		pi.on("tool_execution_start", async (event) => {
			if (event.toolName === "background_wait") await finish();
		});
	});
	h.setResponses([call("bash", { command: "controlled" }), call("background_wait", { id: "1" }), answer("Done.")]);
	await h.session.prompt("Wait for the prerequisite.");
	expect(getMessageText(getToolResult(h, "background_wait"))).toContain("controlled completion");
	expect(h.session.messages.filter((m) => m.role === "custom")).toHaveLength(0);
});

test("interrupting a wait leaves work alive and quiet across a new topic", async () => {
	const { h, finish } = await controlled();
	h.setResponses([call("bash", { command: "controlled" }), call("background_wait", { id: "1" })]);
	const running = h.session.prompt("Wait for the prerequisite.");
	await vi.waitFor(() =>
		expect(h.eventsOfType("tool_execution_start").some((e) => e.toolName === "background_wait")).toBe(true),
	);
	await h.session.abort("Interrupted by the user.");
	await running;
	expect(getMessageText(getToolResult(h, "background_wait"))).toBe("Interrupted by the user.");
	h.setResponses([call("background_status", { id: "1" }), answer("New topic.")]);
	await h.session.prompt("Check whether the job is still running.");
	expect(getMessageText(getToolResult(h, "background_status"))).toContain(": running");
	await finish();
	h.setResponses([call("background_wait", { id: "1" }), answer("Inspected explicitly.")]);
	await h.session.prompt("Collect its result now.");
	expect(getMessageText(getToolResult(h, "background_wait"))).toContain("controlled completion");
	expect(h.session.messages.filter((m) => m.role === "custom")).toHaveLength(0);
});

test("wait rejects unknown IDs", async () => {
	const h = await setup();
	h.setResponses([call("background_wait", { id: "missing" }), answer("Unavailable.")]);
	await h.session.prompt("Wait for the missing job.");
	expect(getToolResult(h, "background_wait").isError).toBe(true);
	expect(getMessageText(getToolResult(h, "background_wait"))).toContain("Unknown or expired");
});

test("busy completion follows the entire tool batch and reaches the next request exactly once", async () => {
	let secondRan = false;
	const { h } = await controlled((pi, finish) => {
		pi.on("tool_execution_start", async (event) => {
			if (event.toolName === "write") await finish();
		});
		pi.on("tool_execution_end", (event) => {
			if (event.toolName === "read") secondRan = true;
		});
	});
	h.setResponses([
		call("bash", { command: "controlled" }),
		fauxAssistantMessage(
			[
				fauxToolCall("write", { path: "batch.txt", content: "batch" }),
				fauxToolCall("read", { path: "batch.txt" }),
			],
			{ stopReason: "toolUse" },
		),
		(context) => {
			expect(secondRan).toBe(true);
			const texts = context.messages.map(getMessageText);
			expect(texts.filter((text) => text.includes("controlled completion"))).toHaveLength(1);
			expect(getMessageText(context.messages.at(-1))).toContain("controlled completion");
			return answer("Used the completion in this run.");
		},
	]);
	await h.session.prompt("Run the synthetic work and two file operations.");
	expect(h.eventsOfType("agent_start")).toHaveLength(1);
	expect(h.getPendingResponseCount()).toBe(0);
});

test("completion during a final response ensures another request without an idle restart", async () => {
	const { h, finish } = await controlled();
	h.setResponses([
		call("bash", { command: "controlled" }),
		async () => {
			await finish();
			return answer("Other work is done.");
		},
		(context) => {
			expect(getMessageText(context.messages.at(-1))).toContain("controlled completion");
			return answer("Used the result.");
		},
	]);
	await h.session.prompt("Run work.");
	expect(h.eventsOfType("agent_start")).toHaveLength(1);
	expect(h.getPendingResponseCount()).toBe(0);
	expect(h.session.messages.filter((m) => m.role === "custom")).toHaveLength(1);
});

test("queued user input takes precedence over a ready background result", async () => {
	const { h, finish } = await controlled();
	h.setResponses([
		call("bash", { command: "controlled" }),
		async () => {
			await finish();
			await h.session.sendUserMessage("Priority request", {
				deliverAs: "followUp",
			});
			return answer("Finishing the current response.");
		},
		(context) => {
			expect(getMessageText(context.messages.at(-1))).toBe("Priority request");
			expect(
				context.messages.some((m) => getMessageText(m).includes("controlled completion")),
			).toBe(false);
			return answer("Handled your request.");
		},
		(context) => {
			expect(getMessageText(context.messages.at(-1))).toContain("controlled completion");
			return answer("Handled the result too.");
		},
	]);
	await h.session.prompt("Start work.");
	expect(h.getPendingResponseCount()).toBe(0);
});

test("aborting a busy run with a completed job does not restart it", async () => {
	const { h, finish } = await controlled();
	let abort!: Promise<void>;
	h.setResponses([
		call("bash", { command: "controlled" }),
		async () => {
			await finish();
			abort = h.session.abort();
			return answer("Interrupted response.");
		},
	]);
	await h.session.prompt("Start work.");
	await abort;
	expect(h.session.messages.filter((m) => m.role === "custom")).toHaveLength(0);
	h.setResponses([answer("Another extension ran.")]);
	await h.session.sendCustomMessage(
		{
			customType: "synthetic-other-extension",
			content: "Independent event",
			display: false,
		},
		{ triggerTurn: true },
	);
	expect(
		h.session.messages.filter((m) => m.role === "custom" && m.customType === "background-result"),
	).toHaveLength(0);
	h.setResponses([answer("An extension supplied a prompt.")]);
	await h.session.sendUserMessage("Synthetic extension prompt");
	expect(
		h.session.messages.filter((m) => m.role === "custom" && m.customType === "background-result"),
	).toHaveLength(0);
	h.setResponses([
		(context) => {
			expect(
				context.messages.some((m) => m.role === "custom" && m.customType === "background-result"),
			).toBe(false);
			return answer("Addressed the new request.");
		},
	]);
	await h.session.prompt("A different question.");
	expect(
		h.session.messages.filter((m) => m.role === "custom" && m.customType === "background-result"),
	).toHaveLength(0);
	expect(h.getPendingResponseCount()).toBe(0);
});

async function setup(extra: ((pi: ExtensionAPI) => void)[] = []) {
	initTheme("dark", false);
	const h = await createHarness({
		extensionFactories: [...extra, extension],
		settings: { compaction: { enabled: false }, retry: { enabled: false } },
	});
	harnesses.push(h);
	await h.session.bindExtensions({
		mode: "tui",
		uiContext: createTestUiContext(),
	});
	return h;
}

afterEach(async () => {
	for (const h of harnesses.splice(0)) {
		await h.session.extensionRunner.emit({
			type: "session_shutdown",
			reason: "exit",
		});
		h.cleanup();
	}
});

function worker(h: Awaited<ReturnType<typeof setup>>, body: string) {
	const path = join(h.tempDir, "worker.mjs");
	writeFileSync(
		path,
		`import fs from 'node:fs'; import {setTimeout as delay} from 'node:timers/promises';\n${body}`,
	);
	return `exec ${quote(process.execPath)} ${quote(path)}`;
}

test("returns while running, then wakes an idle parent with the actual failure and output", async () => {
	const h = await setup();
	const command = worker(
		h,
		`while(!fs.existsSync('release')) await delay(10); console.log('synthetic failure detail'); process.exitCode=7;`,
	);
	h.setResponses([
		call("bash", { command }),
		answer("Other work is ready."),
		answer("I received the failure."),
	]);
	await h.session.prompt("Start the synthetic analysis.");
	expect(getMessageText(getToolResult(h, "bash"))).toContain(
		"Completion will be reported automatically",
	);
	expect(h.session.isStreaming).toBe(false);
	writeFileSync(join(h.tempDir, "release"), "go");
	await vi.waitFor(() =>
		expect(
			h.session.messages.some((m: unknown) => getMessageText(m) === "I received the failure."),
		).toBe(true),
	);
	const updates = h.session.messages.filter((m: { role: string }) => m.role === "custom");
	expect(updates).toHaveLength(1);
	expect(getMessageText(updates[0])).toContain("exit 7");
	expect(getMessageText(updates[0])).toContain("synthetic failure detail");
	h.setResponses([call("background_wait", { id: "1" }), answer("Inspected delivered result.")]);
	await h.session.prompt("Collect the already delivered result explicitly.");
	expect(getMessageText(getToolResult(h, "background_wait"))).toContain("exit 7");
	expect(h.session.messages.filter((m) => m.role === "custom")).toHaveLength(1);
});

test("completion waits for a blocking prompt; inspecting the finished job suppresses redundant delivery", async () => {
	let finished = false;
	const ops = createLocalBashOperations();
	const h = await setup([
		(pi) =>
			pi.on("bash_launch", () => ({
				operations: {
					...ops,
					async exec(...args) {
						try {
							return await ops.exec(...args);
						} finally {
							finished = true;
						}
					},
				},
			})),
	]);
	const command = worker(
		h,
		`while(!fs.existsSync('release')) await delay(10); console.log('finished');`,
	);
	h.setResponses([
		call("bash", { command }),
		answer("Started."),
		call("background_status", { id: "1" }),
		answer("Read the result."),
	]);
	await h.session.prompt("Start work.");
	await h.session.extensionRunner.emit({
		type: "ui_prompt_start",
		kind: "custom",
	});
	writeFileSync(join(h.tempDir, "release"), "go");
	await vi.waitFor(() => expect(finished).toBe(true));
	expect(h.session.messages.filter((m: { role: string }) => m.role === "custom")).toHaveLength(0);
	await h.session.prompt("Inspect its result.");
	expect(getMessageText(getToolResult(h, "background_status"))).toContain("finished, exit 0");
	await h.session.extensionRunner.emit({
		type: "ui_prompt_end",
		kind: "custom",
	});
	await new Promise((resolve) => setTimeout(resolve, 20));
	expect(h.session.messages.filter((m: { role: string }) => m.role === "custom")).toHaveLength(0);
});

test("interrupted output stays quiet until explicitly inspected", async () => {
	let finished = false;
	const ops = createLocalBashOperations();
	const h = await setup([
		(pi) =>
			pi.on("bash_launch", () => ({
				operations: {
					...ops,
					async exec(...args) {
						try {
							return await ops.exec(...args);
						} finally {
							finished = true;
						}
					},
				},
			})),
	]);
	const command = worker(
		h,
		`while(!fs.existsSync('release')) await delay(10); console.log('late result');`,
	);
	h.setResponses([
		call("bash", { command }),
		answer("Started."),
		call("background_status", { id: "1" }),
		answer("Handled late result."),
	]);
	await h.session.prompt("Start work.");
	await h.session.extensionRunner.emit({
		type: "agent_settled",
		aborted: true,
	});
	writeFileSync(join(h.tempDir, "release"), "go");
	await vi.waitFor(() => expect(finished).toBe(true));
	expect(h.session.messages.filter((m: { role: string }) => m.role === "custom")).toHaveLength(0);
	await h.session.prompt("Inspect the old job result.");
	expect(getMessageText(getToolResult(h, "background_status"))).toContain("late result");
	expect(h.session.messages.filter((m) => m.role === "custom")).toHaveLength(0);
	await vi.waitFor(() =>
		expect(
			h.session.messages.some((m: unknown) => getMessageText(m) === "Handled late result."),
		).toBe(true),
	);
});

test("launch guards veto before work starts", async () => {
	let launches = 0;
	const h = await setup([
		(pi) =>
			pi.on("bash_launch", () => {
				launches++;
				return { block: true, reason: "synthetic veto" };
			}),
	]);
	h.setResponses([call("bash", { command: "touch forbidden" }), answer("Blocked.")]);
	await h.session.prompt("Try the guarded operation.");
	expect(launches).toBe(1);
	expect(getToolResult(h, "bash").isError).toBe(true);
	expect(existsSync(join(h.tempDir, "forbidden"))).toBe(false);
});

test("unsupported remote work cannot fall back to local execution", async () => {
	const h = await setup([
		(pi) => {
			createActiveWorkspacePublisher(pi, {
				phase: "connecting",
				label: "synthetic remote",
			});
		},
	]);
	h.setResponses([call("bash", { command: "touch forbidden" }), answer("Unsupported.")]);
	await h.session.prompt("Try remote work.");
	expect(getToolResult(h, "bash").isError).toBe(true);
	expect(getMessageText(getToolResult(h, "bash"))).toContain("Active workspace is unavailable");
	expect(existsSync(join(h.tempDir, "forbidden"))).toBe(false);
});

test("stopping a running command settles it and retains useful output without a duplicate notice", async () => {
	const h = await setup();
	const command = worker(
		h,
		`console.log('partial output'); fs.writeFileSync('pid',String(process.pid)); setInterval(()=>{},1000);`,
	);
	h.setResponses([
		call("bash", { command }),
		answer("Started."),
		call("background_stop", { id: "1" }),
		answer("Stopped."),
	]);
	await h.session.prompt("Start work.");
	await vi.waitFor(() => expect(existsSync(join(h.tempDir, "pid"))).toBe(true));
	const pid = Number(readFileSync(join(h.tempDir, "pid"), "utf8"));
	await h.session.prompt("Stop it.");
	expect(getMessageText(getToolResult(h, "background_stop"))).toContain("stopped");
	expect(getMessageText(getToolResult(h, "background_stop"))).toContain("partial output");
	expect(() => process.kill(pid, 0)).toThrow();
	expect(h.session.messages.filter((m: { role: string }) => m.role === "custom")).toHaveLength(0);
});

test("large native output stays retrievable and session shutdown removes owned output", async () => {
	const h = await setup();
	const command = worker(
		h,
		`console.log('start'); console.log('x'.repeat(100000)); console.log('end');`,
	);
	h.setResponses([call("bash", { command }), answer("Started."), answer("Received.")]);
	await h.session.prompt("Run large output.");
	await vi.waitFor(() => expect(h.session.messages.some((m) => m.role === "custom")).toBe(true));
	const notice = getMessageText(h.session.messages.find((m) => m.role === "custom"));
	expect(notice.length).toBeLessThan(4500);
	expect(notice).toContain("end");
	const path = notice.match(/^Full output: (.+)$/m)?.[1];
	expect(path).toBeTruthy();
	expect(readFileSync(path!, "utf8")).toMatch(/^start\n/);
	await h.session.extensionRunner.emit({
		type: "session_shutdown",
		reason: "exit",
	});
	h.session.dispose();
	expect(existsSync(path!)).toBe(false);
});

test.each([
	"first\nsecond\nthird\nfourth\nfifth\nsixth\nseventh\neighth\n",
	"🙂".repeat(700) + "END\n",
])("shortened receipts retain omitted output below the native truncation threshold", async (output) => {
	const h = await setup();
	const command = worker(h, `process.stdout.write(${JSON.stringify(output)});`);
	h.setResponses([call("bash", { command }), call("background_wait", { id: "1" }), answer("Collected.")]);
	await h.session.prompt("Run the output fixture and wait.");
	const receipt = getMessageText(getToolResult(h, "background_wait"));
	expect(receipt).toContain("[Earlier output omitted]");
	expect(receipt).not.toContain("\uFFFD");
	const path = receipt.match(/^Full output: (.+)$/m)?.[1];
	expect(path).toBeTruthy();
	expect(readFileSync(path!, "utf8")).toBe(output);
	const tail = receipt.split("[Earlier output omitted]\n")[1];
	expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(1024);
	expect(tail.split("\n").length).toBeLessThanOrEqual(6);
	expect(receipt.indexOf("Full output:")).toBeLessThan(receipt.indexOf("[Earlier output omitted]"));
	await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "exit" });
	h.session.dispose();
	expect(existsSync(path!)).toBe(false);
});

test("changing conversation branch silences old jobs without losing explicit inspection", async () => {
	const { h, finish } = await controlled();
	h.setResponses([call("bash", { command: "controlled" }), answer("Started.")]);
	await h.session.prompt("Start the synthetic work.");
	await h.session.extensionRunner.emit({
		type: "session_tree",
		oldLeafId: "old",
		newLeafId: "new",
	});
	await finish();
	expect(h.session.messages.filter((m) => m.role === "custom")).toHaveLength(0);
	h.setResponses([call("background_status", { id: "1" }), answer("Inspected.")]);
	await h.session.prompt("Inspect the previous job.");
	expect(getMessageText(getToolResult(h, "background_status"))).toContain("controlled completion");
	expect(getMessageText(getToolResult(h, "background_status"))).toContain(
		"automatic continuation off",
	);
	expect(h.session.messages.filter((m) => m.role === "custom")).toHaveLength(0);
});

test.each([false, true])(
	"timeout diagnostics retain their outcome when output storage fails=%s",
	async (storageFails) => {
		let finish!: () => void;
		const pending = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const h = await setup([
			(pi) => {
				if (storageFails)
					pi.on("output_file", () => {
						throw new Error("Synthetic storage failure");
					});
			},
			(pi) =>
				pi.on("bash_launch", () => ({
					operations: {
						async exec(_command, _cwd, { onData }) {
							onData(Buffer.from("diagnostic-start\n" + "x".repeat(8000)));
							await pending;
							throw new Error("timeout:1");
						},
					},
				})),
		]);
		h.setResponses([
			call("bash", { command: "synthetic timeout" }),
			answer("Started."),
			answer("Received the timeout."),
		]);
		await h.session.prompt("Run the synthetic command.");
		finish();
		await vi.waitFor(() => expect(h.session.messages.some((m) => m.role === "custom")).toBe(true));
		const notice = getMessageText(h.session.messages.find((m) => m.role === "custom"));
		expect(notice).toContain("timed out after 1 second");
		expect(notice).toContain(": failed");
		expect(notice.length).toBeLessThan(4500);
		const path = notice.match(/^Full output: (.+)$/m)?.[1];
		if (storageFails) {
			expect(path).toBeUndefined();
			expect(notice).toContain("Full output could not be retained");
			return;
		}
		expect(path).toBeTruthy();
		expect(readFileSync(path!, "utf8")).toMatch(/^diagnostic-start\n/);
		expect(readFileSync(path!, "utf8")).toContain("timed out after 1 second");
	},
);

test("shutdown terminates owned live commands", async () => {
	const h = await setup();
	const command = worker(
		h,
		`fs.writeFileSync('pid',String(process.pid)); setInterval(()=>{},1000);`,
	);
	h.setResponses([call("bash", { command }), answer("Started.")]);
	await h.session.prompt("Start work.");
	await vi.waitFor(() => expect(existsSync(join(h.tempDir, "pid"))).toBe(true));
	const pid = Number(readFileSync(join(h.tempDir, "pid"), "utf8"));
	await h.session.extensionRunner.emit({
		type: "session_shutdown",
		reason: "exit",
	});
	expect(() => process.kill(pid, 0)).toThrow();
});

test("instant quiet completion is delivered once with a real successful exit", async () => {
	const h = await setup();
	h.setResponses([
		call("bash", { command: "true" }),
		answer("Started."),
		answer("Received quiet success."),
	]);
	await h.session.prompt("Run the quiet check.");
	await vi.waitFor(() =>
		expect(
			h.session.messages.some((m: unknown) => getMessageText(m) === "Received quiet success."),
		).toBe(true),
	);
	const updates = h.session.messages.filter((m: { role: string }) => m.role === "custom");
	expect(updates).toHaveLength(1);
	expect(getMessageText(updates[0])).toContain("finished, exit 0");
	expect(getMessageText(updates[0])).toContain("(no output)");
});

test("out-of-order jobs preserve identity and each wake the idle parent", async () => {
	const h = await setup();
	const script = join(h.tempDir, "ordered.mjs");
	writeFileSync(
		script,
		"import fs from 'node:fs';import {setTimeout as delay} from 'node:timers/promises';while(!fs.existsSync(process.argv[2]))await delay(10);console.log(process.argv[2]);",
	);
	h.setResponses([
		call("bash", {
			command: `${quote(process.execPath)} ${quote(script)} first`,
		}),
		call("bash", {
			command: `${quote(process.execPath)} ${quote(script)} second`,
		}),
		answer("Both started."),
		answer("Second arrived."),
		answer("First arrived."),
	]);
	await h.session.prompt("Start both tasks.");
	writeFileSync(join(h.tempDir, "second"), "go");
	await vi.waitFor(() =>
		expect(h.session.messages.some((m: unknown) => getMessageText(m) === "Second arrived.")).toBe(
			true,
		),
	);
	writeFileSync(join(h.tempDir, "first"), "go");
	await vi.waitFor(() =>
		expect(h.session.messages.some((m: unknown) => getMessageText(m) === "First arrived.")).toBe(
			true,
		),
	);
	const updates = h.session.messages.filter((m: { role: string }) => m.role === "custom");
	expect(updates).toHaveLength(2);
	expect(getMessageText(updates[0])).toMatch(/^Job 2 .*\nsecond$/s);
	expect(getMessageText(updates[1])).toMatch(/^Job 1 .*\nfirst$/s);
});

test("session replacement cleans old work and does not leak its result into the new conversation", async () => {
	const h = await setup();
	const command = worker(
		h,
		`fs.writeFileSync('pid',String(process.pid));setInterval(()=>{},1000);`,
	);
	h.setResponses([call("bash", { command }), answer("Started.")]);
	await h.session.prompt("Start old work.");
	await vi.waitFor(() => expect(existsSync(join(h.tempDir, "pid"))).toBe(true));
	const pid = Number(readFileSync(join(h.tempDir, "pid"), "utf8"));
	await h.session.extensionRunner.emit({
		type: "session_start",
		reason: "new",
	});
	expect(() => process.kill(pid, 0)).toThrow();
	h.setResponses([call("background_status", {}), answer("Empty.")]);
	await h.session.prompt("Inspect current work.");
	expect(getMessageText(getToolResult(h, "background_status"))).toContain(
		"No outstanding background work",
	);
	expect(h.session.messages.filter((m: { role: string }) => m.role === "custom")).toHaveLength(0);
});
