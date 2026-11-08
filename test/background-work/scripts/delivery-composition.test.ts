import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { initTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import background from "../../../extensions/background-work/index.ts";
import goal from "../../../extensions/goal/index.ts";
import { registerBackgroundRuns } from "../../../extensions/subagents/src/background.ts";
import { SubagentScheduler } from "../../../extensions/subagents/src/scheduler.ts";
import type { ChildView } from "../../../extensions/subagents/src/types.ts";

const { createHarness, createTestUiContext } = await import(
	pathToFileURL(
		join(process.env.PI_BACKGROUND_CHECKOUT!, "packages/coding-agent/test/suite/harness.ts"),
	).href
);
const harnesses: Awaited<ReturnType<typeof createHarness>>[] = [];
afterEach(async () => {
	for (const h of harnesses.splice(0)) {
		await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "exit" });
		h.cleanup();
	}
	vi.restoreAllMocks();
});
const answer = (text: string) => fauxAssistantMessage(text);
const call = (name: string, args: Record<string, unknown>) =>
	fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });

async function setup(other: (pi: ExtensionAPI) => void, reversed: boolean) {
	initTheme("dark", false);
	let release!: () => void;
	const pending = new Promise<void>((resolve) => {
		release = resolve;
	});
	const h = await createHarness({
		extensionFactories: [
			...(reversed ? [background, other] : [other, background]),
			(pi) =>
				pi.on("bash_launch", () => ({
					operations: {
						async exec(_command, _cwd, { onData }) {
							await pending;
							onData(Buffer.from("synthetic shell completion"));
							return { exitCode: 0 };
						},
					},
				})),
		],
		settings: { compaction: { enabled: false }, retry: { enabled: false } },
	});
	harnesses.push(h);
	await h.session.bindExtensions({ mode: "tui", uiContext: createTestUiContext() });
	return {
		h,
		finish: async () => {
			release();
			await new Promise<void>((resolve) => setImmediate(resolve));
		},
	};
}

test.each([false, true])(
	"Goal continuation and job completion settle without duplicate turns (reversed=%s)",
	async (reversed) => {
		const { h, finish } = await setup(goal, reversed);
		h.setResponses([
			call("create_goal", { objective: "Complete the synthetic shell task" }),
			call("bash", { command: "synthetic", background: true }),
			answer("Waiting for the synthetic result."),
			async () => {
				await finish();
				return answer("Continuing the goal.");
			},
			call("update_goal", { status: "complete" }),
			answer("Synthetic task complete."),
		]);
		await h.session.prompt("Create a goal to complete the synthetic task.");
		await vi.waitFor(() => {
			expect(h.getPendingResponseCount()).toBe(0);
			expect(h.session.isIdle).toBe(true);
		});
		const custom = h.session.messages.filter((m) => m.role === "custom");
		expect(custom.filter((m) => m.customType === "background-result")).toHaveLength(1);
		expect(custom.filter((m) => m.customType === "goal.continuation")).toHaveLength(1);
		expect(h.eventsOfType("agent_start")).toHaveLength(2);
	},
);

test.each([false, true])(
	"Subagent notices and shell completion each arrive once (reversed=%s)",
	async (reversed) => {
		// Exercise the real delivery module; no child process or provider is launched.
		const scheduler = new SubagentScheduler(1);
		let ready = false;
		const child: ChildView = {
			kind: "child",
			id: "synthetic-child",
			batchId: "synthetic-batch",
			index: 0,
			label: "Synthetic child",
			task: "Synthetic work",
			state: "completed",
			cwd: "/synthetic",
			provider: "faux",
			model: "faux",
			modelSource: "inherited",
			tools: [],
			capabilities: [],
			createdAt: 1,
			finishedAt: 2,
		};
		vi.spyOn(scheduler, "runs").mockImplementation(() => (ready ? [child] : []));
		vi.spyOn(scheduler, "notices").mockImplementation(() =>
			ready ? [{ child, completion: true, messages: [] }] : [],
		);
		const notified = vi.spyOn(scheduler, "markNotified").mockImplementation(() => {
			ready = false;
		});
		const { h, finish } = await setup((pi) => registerBackgroundRuns(pi, scheduler), reversed);
		h.setResponses([
			call("bash", { command: "synthetic", background: true }),
			async () => {
				ready = true;
				await finish();
				return answer("Other work finished.");
			},
			answer("Used the shell result."),
			answer("Received the child notice."),
		]);
		await h.session.prompt("Run the synthetic shell task.");
		await vi.waitFor(() => {
			expect(h.getPendingResponseCount()).toBe(0);
			expect(h.session.isIdle).toBe(true);
		});
		const custom = h.session.messages.filter((m) => m.role === "custom");
		expect(custom.filter((m) => m.customType === "background-result")).toHaveLength(1);
		expect(custom.filter((m) => m.customType === "subagent-update")).toHaveLength(1);
		expect(notified).toHaveBeenCalledTimes(1);
		expect(h.eventsOfType("agent_start")).toHaveLength(2);
	},
);
