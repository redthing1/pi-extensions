import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { initTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import background from "../../../extensions/background-work/index.ts";
import { MonitorEvents } from "../../../extensions/background-work/monitor.ts";

const { createHarness, createTestUiContext, getMessageText, getToolResult } = await import(
	pathToFileURL(join(process.env.PI_BACKGROUND_CHECKOUT!, "packages/coding-agent/test/suite/harness.ts")).href
);
const harnesses: Awaited<ReturnType<typeof createHarness>>[] = [];
const answer = (text: string) => fauxAssistantMessage(text);
const call = (name: string, args: Record<string, unknown>) =>
	fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
afterEach(async () => {
	for (const h of harnesses.splice(0)) {
		await h.session.extensionRunner.emit({
			type: "session_shutdown",
			reason: "exit",
		});
		h.cleanup();
	}
	vi.restoreAllMocks();
});

test("events preserve fragments, CRLF, Unicode and a final unterminated line", () => {
	const events = new MonitorEvents();
	events.append("\n \nfirst\r");
	events.append("\n€ second\nlast");
	expect(events.pending).toEqual(["first", "€ second"]);
	events.collect();
	events.finish();
	expect(events.pending).toEqual(["last"]);
	expect(events.dueAt).toBeGreaterThan(Date.now());
	events.discard();
	expect(events.pending).toEqual([]);
});

test.each([
	["x".repeat(2049), "exceeded"],
	["€".repeat(683), "exceeded"],
	["event\n".repeat(9), "too many"],
	[("x".repeat(2000) + "\n").repeat(5), "too many"],
])("noisy output stops with a bounded explicit error", (text, reason) => {
	const events = new MonitorEvents();
	events.append(text);
	expect(events.failure).toContain(reason);
	expect(events.pending.length).toBeLessThanOrEqual(8);
	expect(Buffer.byteLength(events.pending.join(""))).toBeLessThanOrEqual(8192);
	const before = [...events.pending];
	events.append("ignored after failure\n");
	expect(events.pending).toEqual(before);
});

async function setup(extra?: (pi: ExtensionAPI) => void, initialOutput?: string, outcome: number | string = 0) {
	initTheme("dark", false);
	let emit!: (text: string) => void;
	let finish!: () => void;
	let aborted = false;
	let timeout: number | undefined;
	const completion = new Promise<void>((resolve) => {
		finish = resolve;
	});
	const h = await createHarness({
		extensionFactories: [
			background,
			(pi) => {
				extra?.(pi);
				pi.on("bash_launch", () => ({
					operations: {
						async exec(_command, _cwd, options) {
							timeout = options.timeout;
							emit = (text) => options.onData(Buffer.from(text));
							const stop = () => {
								aborted = true;
								finish();
							};
							options.signal?.addEventListener("abort", stop, { once: true });
							if (initialOutput) emit(initialOutput);
							try {
								await completion;
								if (aborted) return { exitCode: null };
								if (typeof outcome === "string") throw new Error(outcome);
								return { exitCode: outcome };
							} finally {
								options.signal?.removeEventListener("abort", stop);
							}
						},
					},
				}));
			},
		],
		settings: { compaction: { enabled: false }, retry: { enabled: false } },
	});
	harnesses.push(h);
	const ui = createTestUiContext();
	const status = vi.spyOn(ui, "setStatus");
	const notify = vi.spyOn(ui, "notify");
	await h.session.bindExtensions({
		mode: "tui",
		uiContext: ui,
	});
	return {
		h,
		status,
		notify,
		emit: (text: string) => emit(text),
		finish: async () => {
			finish();
			await tick();
		},
		get aborted() {
			return aborted;
		},
		get timeout() {
			return timeout;
		},
	};
}
const notices = (h: Awaited<ReturnType<typeof createHarness>>) =>
	h.session.messages.filter((m) => m.role === "custom" && m.customType === "background-result");

test("a live event wakes an idle agent; completion does not replay the event", async () => {
	const fixture = await setup();
	const { h } = fixture;
	h.setResponses([call("monitor", { command: "synthetic watcher" }), answer("Watching."), answer("Received event.")]);
	await h.session.prompt("Watch the synthetic source.");
	expect(getMessageText(getToolResult(h, "monitor"))).toContain("Output events");
	expect(fixture.timeout).toBe(300);
	const nested = h.eventsOfType("tool_execution_start").find((e) => e.toolName === "bash");
	expect(nested?.parentToolCallId).toBeTruthy();
	fixture.emit("ready: €\n");
	await vi.waitFor(() => expect(h.getPendingResponseCount()).toBe(0));
	expect(getMessageText(notices(h)[0])).toContain("ready: €");
	expect(fixture.aborted).toBe(false);
	h.setResponses([answer("Watcher ended.")]);
	await fixture.finish();
	await vi.waitFor(() => expect(notices(h)).toHaveLength(2));
	expect(getMessageText(notices(h)[1])).toContain("finished");
	expect(getMessageText(notices(h)[1])).not.toContain("ready: €");
});

test.each([7, "timeout:5"])("failed monitor %s delivers only pending events and retains output for inspection", async (outcome) => {
	const fixture = await setup(undefined, undefined, outcome);
	const { h } = fixture;
	h.setResponses([call("monitor", { command: "synthetic failure" }), answer("Watching."), answer("Received first.")]);
	await h.session.prompt("Watch.");
	fixture.emit("delivered\n");
	await vi.waitFor(() => expect(h.getPendingResponseCount()).toBe(0));
	expect(notices(h)).toHaveLength(1);
	await h.session.extensionRunner.emit({ type: "ui_prompt_start" });
	fixture.emit("remaining\n");
	await fixture.finish();
	h.setResponses([answer("Failure received.")]);
	await h.session.extensionRunner.emit({ type: "ui_prompt_end" });
	await vi.waitFor(() => expect(h.getPendingResponseCount()).toBe(0));
	expect(notices(h)).toHaveLength(2);
	const final = getMessageText(notices(h)[1]);
	expect(final).not.toContain("delivered");
	expect(final.match(/remaining/g)).toHaveLength(1);
	expect(final).toContain(outcome === 7 ? "exit 7" : "Command timed out after 5 seconds");
	const view = notices(h)[1].details.backgroundWork.jobs[0];
	expect(view.preview).toBe("remaining");
	if (outcome !== 7) expect(view.diagnostic).toBe("Command timed out after 5 seconds");
	h.setResponses([call("background_status", { id: "1" }), answer("Inspected.")]);
	await h.session.prompt("Inspect the retained output.");
	const inspected = getMessageText(getToolResult(h, "background_status"));
	expect(inspected.match(/delivered/g)).toHaveLength(1);
	expect(inspected.match(/remaining/g)).toHaveLength(1);
});

test("an open form holds events, then delivers one batch at the safe boundary", async () => {
	const fixture = await setup();
	const { h } = fixture;
	const status = fixture.status;
	h.setResponses([call("monitor", { command: "synthetic watcher" }), answer("Watching.")]);
	await h.session.prompt("Watch.");
	await h.session.extensionRunner.emit({ type: "ui_prompt_start" });
	fixture.emit("first\nsecond\n");
	await new Promise((resolve) => setTimeout(resolve, 120));
	expect(notices(h)).toHaveLength(0);
	expect(status).toHaveBeenLastCalledWith("background", "1 background job · 2 updates pending");
	h.setResponses([answer("Received both.")]);
	await h.session.extensionRunner.emit({ type: "ui_prompt_end" });
	await vi.waitFor(() => expect(notices(h)).toHaveLength(1));
	expect(getMessageText(notices(h)[0])).toContain("first\nsecond");
	expect(status).toHaveBeenLastCalledWith("background", "1 background job");
});

test("busy events reach the next model request once without restarting the run", async () => {
	const fixture = await setup();
	const { h } = fixture;
	h.setResponses([
		call("monitor", { command: "synthetic watcher" }),
		async () => {
			fixture.emit("changed\n");
			await new Promise((resolve) => setTimeout(resolve, 120));
			return answer("Other work.");
		},
		(context) => {
			expect(getMessageText(context.messages.at(-1))).toContain("changed");
			return answer("Handled.");
		},
	]);
	await h.session.prompt("Watch while working.");
	expect(h.getPendingResponseCount()).toBe(0);
	expect(h.eventsOfType("agent_start")).toHaveLength(1);
	expect(notices(h)).toHaveLength(1);
});

test("explicit interruption discards pending events and stays quiet on a new topic", async () => {
	const fixture = await setup();
	const { h } = fixture;
	h.setResponses([call("monitor", { command: "synthetic watcher" }), call("background_wait", { id: "1" })]);
	const run = h.session.prompt("Watch and wait.");
	await vi.waitFor(() =>
		expect(h.eventsOfType("tool_execution_start").some((e) => e.toolName === "background_wait")).toBe(true),
	);
	fixture.emit("pending\n");
	await h.session.abort();
	await run;
	h.setResponses([answer("New topic.")]);
	await h.session.prompt("Discuss something else.");
	fixture.emit("later\n");
	await fixture.finish();
	expect(notices(h)).toHaveLength(0);
	h.setResponses([call("background_status", { id: "1" }), answer("Inspected.")]);
	await h.session.prompt("Inspect the old watcher.");
	expect(getMessageText(getToolResult(h, "background_status"))).toContain("later");
	expect(notices(h)).toHaveLength(0);
});

test.each(["interrupt", "command"])("idle %s silences existing work without stopping it or future work", async (action) => {
	const fixture = await setup();
	const { h } = fixture;
	h.setResponses([call("monitor", { command: "synthetic watcher" }), answer("Watching.")]);
	await h.session.prompt("Watch.");
	if (action === "interrupt") await h.session.extensionRunner.emit({ type: "ui_interrupt" });
	else await h.session.prompt("/background mute");
	await tick();
	expect(fixture.aborted).toBe(false);
	expect(fixture.notify).toHaveBeenCalledWith("Automatic updates off · background work continues", "info");
	expect(fixture.status.mock.calls.at(-1)?.[1]).toContain("automatic updates off");
	fixture.emit("retained while quiet\n");
	await tick();
	expect(notices(h)).toHaveLength(0);
	h.setResponses([call("background_status", { id: "1" }), answer("Inspected.")]);
	await h.session.prompt("Inspect the watcher.");
	expect(getMessageText(getToolResult(h, "background_status"))).toContain("retained while quiet");
	expect(notices(h)).toHaveLength(0);
	h.setResponses([call("monitor", { command: "new watcher" }), answer("Watching the new source.")]);
	await h.session.prompt("Watch another source.");
	expect(fixture.status.mock.calls.at(-1)?.[1]).toContain("1 with updates off");
	h.setResponses([answer("New event received."), answer("New watcher completed.")]);
	fixture.emit("new source event\n");
	await vi.waitFor(() => expect(notices(h)).toHaveLength(1));
	await fixture.finish();
	await vi.waitFor(() => expect(notices(h)).toHaveLength(2));
	expect(notices(h).every((message) => !getMessageText(message).includes("retained while quiet"))).toBe(true);
	expect(fixture.aborted).toBe(false);
});

test("noisy producer is aborted and delivers one explicit failure", async () => {
	const fixture = await setup();
	const { h } = fixture;
	h.setResponses([call("monitor", { command: "synthetic watcher" }), answer("Watching."), answer("Too noisy.")]);
	await h.session.prompt("Watch.");
	fixture.emit("noisy\n".repeat(9));
	await vi.waitFor(() => expect(notices(h)).toHaveLength(1));
	expect(fixture.aborted).toBe(true);
	expect(getMessageText(notices(h)[0])).toContain("Monitor stopped: too many events");
});

test("an immediate noisy producer returns its specific error even before launch acknowledgement", async () => {
	const fixture = await setup(undefined, "x".repeat(2049));
	const { h } = fixture;
	h.setResponses([call("monitor", { command: "synthetic watcher" }), answer("Rejected noisy source.")]);
	await h.session.prompt("Test a noisy watcher.");
	expect(fixture.aborted).toBe(true);
	expect(getToolResult(h, "monitor").isError).toBe(true);
	expect(getMessageText(getToolResult(h, "monitor"))).toContain("an event exceeded");
	expect(notices(h)).toHaveLength(0);
});

test("successive events are batched after the delivery interval, without polling", async () => {
	const fixture = await setup();
	const { h } = fixture;
	h.setResponses([call("monitor", { command: "synthetic watcher" }), answer("Watching."), answer("First.")]);
	await h.session.prompt("Watch.");
	fixture.emit("first\n");
	await vi.waitFor(() => expect(h.getPendingResponseCount()).toBe(0));
	h.setResponses([answer("Second batch.")]);
	fixture.emit("second\nthird\n");
	await new Promise((resolve) => setTimeout(resolve, 150));
	expect(notices(h)).toHaveLength(1);
	await vi.waitFor(() => expect(notices(h)).toHaveLength(2), { timeout: 5500 });
	expect(getMessageText(notices(h)[1])).toContain("second\nthird");
}, 8000);

test("waiting collects final events without an extra automatic continuation", async () => {
	const fixture = await setup();
	const { h } = fixture;
	h.setResponses([call("monitor", { command: "synthetic watcher" }), call("background_wait", { id: "1" }), answer("Done.")]);
	const run = h.session.prompt("Wait for the synthetic watcher to finish.");
	await vi.waitFor(() => expect(h.eventsOfType("tool_execution_start").some((e) => e.toolName === "background_wait")).toBe(true));
	fixture.emit("final fragment");
	await fixture.finish();
	await run;
	expect(getMessageText(getToolResult(h, "background_wait"))).toContain("final fragment");
	expect(notices(h)).toHaveLength(0);
});

test.each([0, -1, 1801])("invalid lifetime %s is rejected before launch", async (timeout) => {
	const { h } = await setup();
	h.setResponses([call("monitor", { command: "synthetic watcher", timeout }), answer("Rejected.")]);
	await h.session.prompt("Test lifetime validation.");
	expect(getToolResult(h, "monitor").isError).toBe(true);
	expect(h.eventsOfType("tool_execution_start").some((e) => e.toolName === "bash")).toBe(false);
});
