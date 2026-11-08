import { expect, test, vi } from "vitest";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderJobs, type BackgroundDetails } from "../../../extensions/background-work/render.ts";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import extension from "../../../extensions/background-work/index.ts";
const checkout = process.env.PI_BACKGROUND_CHECKOUT!;
const { createHarness, createTestUiContext } = await import(
	pathToFileURL(join(checkout, "packages/coding-agent/test/suite/harness.ts")).href
);
const { ToolExecutionComponent } = await import(
	pathToFileURL(join(checkout, "packages/coding-agent/src/modes/interactive/components/tool-execution.ts")).href
);
const themes = await import(
	pathToFileURL(
		join(process.env.PI_BACKGROUND_CHECKOUT!, "packages/coding-agent/src/modes/interactive/theme/theme.ts"),
	).href
);

const clean = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
const view = {
	id: "7",
	label: "run checks",
	state: "finished" as const,
	exitCode: 0,
	preview: Array.from({ length: 12 }, (_, i) => `output line ${i}`).join("\n"),
	wake: true,
	fullOutputPath: "output:synthetic-7",
};
function render(details: BackgroundDetails, expanded = false, width = 60) {
	initTheme("dark", false);
	const lines = renderJobs(details, expanded, themes.theme).render(width);
	expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
	return clean(lines.join("\n"));
}

test("receipt is a compact launch event, without a completed-command claim or model instructions", async () => {
	const text = await render({ backgroundWork: { jobs: [{ ...view, state: "running" }], receipt: "started" } });
	expect(text).toContain("running in background · #7");
	expect(text).not.toContain("completed");
	expect(text).not.toContain("output line");
	expect(text).not.toContain("end this turn");
});

test.each([24, 60, 100])("monitor distinguishes launch, active event and current status at width %s", (width) => {
	const monitor = { ...view, monitor: true, state: "running" as const, preview: "Build ready" };
	expect(render({ backgroundWork: { jobs: [monitor], receipt: "started" } }, false, width)).toContain("watching");
	expect(render({ backgroundWork: { jobs: [monitor] } }, false, width)).toContain("monitoring");
	const event = render({ backgroundWork: { jobs: [{ ...monitor, event: true }] } }, false, width);
	expect(event).toContain("Monitor #7");
	expect(event).toContain("update");
	expect(event).toContain("Build ready");
	expect(event).not.toContain("completed");
});

test.each([24, 60, 100])("completion keeps a bounded tail and expands retained details at width %s", async (width) => {
	const details = { backgroundWork: { jobs: [view] } };
	const compact = await render(details, false, width);
	expect(compact).toContain("completed");
	expect(compact).toContain("output line 11");
	expect(compact).not.toContain("output line 0\n");
	const expanded = await render(details, true, width);
	expect(expanded).toContain("output line 0");
	expect(expanded).toContain("output:synthetic-7");
});

test.each(["released", "timeout"] as const)("%s receipt is distinct from launch and completion", (receipt) => {
	const text = render({ backgroundWork: { jobs: [{ ...view, state: "running", wake: false }], receipt } });
	expect(text).toContain(receipt === "released" ? "wait released" : "wait limit reached");
	expect(text).toContain("automatic continuation off");
	expect(text).not.toContain("Started");
	expect(text).not.toContain("completed");
});

test("failures and muted jobs retain their distinct state", async () => {
	const text = await render({ backgroundWork: { jobs: [{ ...view, state: "failed", exitCode: 7, wake: false }] } });
	expect(text).toContain("Background #7 · failed · exit 7");
	expect(text).toContain("automatic continuation off");
});

test("failed jobs keep output neutral and emphasize only the outcome and diagnostic", () => {
	initTheme("dark", false);
	const details = { backgroundWork: { jobs: [{ ...view, state: "failed" as const, exitCode: 7,
		preview: "ordinary output", diagnostic: "Command timed out after 5 seconds", fullOutputPath: undefined }] } };
	const lines = renderJobs(details, false, themes.theme).render(100);
	const output = lines.find((line) => clean(line).includes("ordinary output"))!;
	const diagnostic = lines.find((line) => clean(line).includes("Command timed out"))!;
	expect(output).toContain(themes.theme.fg("text", "ordinary output"));
	expect(diagnostic).toContain(themes.theme.fg("error", "Command timed out after 5 seconds"));
	expect(clean(lines.join("\n"))).toContain("failed · exit 7");
});

test("overview bounds rows without hiding the number of additional jobs", async () => {
	const jobs = Array.from({ length: 9 }, (_, index) => ({ ...view, id: String(index) }));
	const compact = await render({ backgroundWork: { jobs, overview: true } });
	expect(compact).toContain("3 more jobs");
	expect(compact).not.toContain("output line");
	expect(compact).not.toContain("✓");
	expect(compact).toContain("run checks");
	expect(await render({ backgroundWork: { jobs, overview: true } }, true)).toContain("#8");
});

test("notifications emphasize output and leave the repeated command to expansion", () => {
	const details = { backgroundWork: { jobs: [{ ...view, preview: "84 tests passed" }] } };
	const compact = render(details);
	expect(compact).toContain("84 tests passed");
	expect(compact).not.toContain("run checks");
	expect(render(details, true)).toContain("$ run checks");
});

test("labels and output cannot inject terminal control sequences", async () => {
	const controls = "\x07\x1b]52;c;synthetic\x07\x85";
	const text = await render({ backgroundWork: { jobs: [{ ...view, label: controls, preview: controls }] } });
	expect(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/u.test(text)).toBe(false);
});

test.each([
	["wait", "completed"],
	["wait", "released"],
	["wait", "timeout"],
	["wait", "error"],
	["stop", "completed"],
] as const)("%s clock advances without output and settles on %s", async (action, outcome) => {
	initTheme("dark", false);
	const h = await createHarness({ extensionFactories: [extension] });
	try {
		await h.session.bindExtensions({ mode: "tui", uiContext: createTestUiContext() });
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const name = `background_${action}`;
		const definition = h.session.getToolDefinition(name);
		const row = new ToolExecutionComponent(name, "clock", { id: "7" }, { argsComplete: true },
			definition, { requestRender }, h.tempDir);
		const text = () => {
			const lines = row.render(24);
			expect(lines.every((line: string) => visibleWidth(line) <= 24)).toBe(true);
			return clean(lines.join("\n"));
		};
		expect(text()).not.toContain("elapsed");
		expect(vi.getTimerCount()).toBe(0);
		row.markExecutionStarted();
		expect(text()).toContain("elapsed 0.0s");
		expect(vi.getTimerCount()).toBe(1);
		requestRender.mockClear();
		vi.advanceTimersByTime(3000);
		expect(requestRender).toHaveBeenCalledTimes(3);
		expect(text()).toContain("elapsed 3.0s");
		row.setExpanded(true);
		expect(vi.getTimerCount()).toBe(1);
		const result = {
			content: [{ type: "text", text: outcome === "error" ? "Wait cancelled" : "Job result" }],
			isError: outcome === "error",
			durationMs: 2500,
			details: outcome === "error" ? undefined : {
				backgroundWork: {
					jobs: [view],
					receipt: outcome === "released" || outcome === "timeout" ? outcome : undefined,
				},
			},
		};
		row.updateResult(result);
		const duration = action === "wait" ? "waited 2.5s" : "took 2.5s";
		expect(text()).toContain(duration);
		expect(text().match(/#7/g)).toHaveLength(1);
		expect(text().indexOf(duration)).toBeGreaterThan(text().indexOf(outcome === "error" ? "Wait cancelled" : "output line"));
		const settledLines = row.render(100).map((line: string) => clean(line).trimEnd());
		const durationLine = settledLines.findIndex((line: string) => line.includes(duration));
		expect(settledLines[durationLine - 1].trim()).not.toBe("");
		expect(settledLines.slice(durationLine + 1)).toEqual([""]);
		expect(text()).not.toContain("elapsed");
		expect(vi.getTimerCount()).toBe(0);
		vi.advanceTimersByTime(10000);
		expect(text()).toContain(duration);
		const restored = new ToolExecutionComponent(name, "restored", { id: "7" }, { argsComplete: true },
			definition, { requestRender }, h.tempDir);
		restored.updateResult(result);
		expect(clean(restored.render(60).join("\n"))).toContain(duration);
		expect(vi.getTimerCount()).toBe(0);
	} finally {
		vi.useRealTimers();
		await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "exit" });
		h.cleanup();
	}
});
