import { afterEach, expect, test, vi } from "vitest";
import {
	createEventBus,
	type ExtensionAPI,
	type ExtensionToolContext,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { childIntent, resolveCommission } from "../src/commission.ts";
import { SubagentScheduler } from "../src/scheduler.ts";
import { registerSubagentTools } from "../src/tool.ts";
import type { ChildExecutionResult, PreparedCommission } from "../src/types.ts";

afterEach(() => vi.useRealTimers());

function fixture(blockCleanup: boolean) {
	let release!: () => void;
	const cleanup = new Promise<void>((resolve) => {
		release = resolve;
	});
	const tools = new Map<string, ToolDefinition>();
	const api = {
		events: createEventBus(),
		on() {},
		registerCommand() {},
		registerMessageRenderer() {},
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, tool);
		},
	} as unknown as ExtensionAPI;
	const providers = { definition: () => undefined, prepare: async () => [] };
	const scheduler = new SubagentScheduler(1, async (_request, signal): Promise<ChildExecutionResult> => {
		await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
		return {
			outcome: "cancelled",
			output: "",
			stderr: "",
			toolCalls: [],
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
			progress: { startedAt: 0, lastActivityAt: 0, durationMs: 0 },
		};
	});
	registerSubagentTools(api, scheduler, {
		tools: providers,
		policies: { prepare: async () => [] },
		providers: { prepare: async () => [] },
	});
	const prepared = (index: number, blocked = blockCleanup, batchId = `batch-${index}`): PreparedCommission => {
		const spec = resolveCommission({
			commission: { task: "Synthetic cancellation", tools: [] },
			index,
			batchId,
			toolCallId: "start",
			cwd: process.cwd(),
			parentModel: { provider: "fixture", id: "model" },
			privacy: { clientZdr: true, remoteZdr: false },
			toolProviders: providers,
		});
		return {
			spec,
			intent: childIntent(spec),
			contributions: [
				{
					id: "cleanup",
					args: [],
					metadata: {},
					dispose: async () => {
						if (blocked) await cleanup;
					},
				},
			],
		};
	};
	const cancel = (ids: string[], signal?: AbortSignal) =>
		tools.get("subagent_cancel")!.execute("cancel", { ids }, signal, undefined, {} as ExtensionToolContext);
	return { scheduler, prepared, cancel, release };
}

test("completed cancellation returns final results", async () => {
	vi.useFakeTimers();
	const f = fixture(false);
	const child = f.prepared(0);
	try {
		await f.scheduler.admit({ batchId: child.spec.batchId, background: true, prepared: [child] });
		const result = await f.cancel([child.spec.id]);
		expect(result.details).not.toHaveProperty("error");
		expect(result.details).not.toHaveProperty("timedOut");
		expect(f.scheduler.targets([child.spec.id])[0]).toMatchObject({ state: "cancelled", collected: true });
		expect(vi.getTimerCount()).toBe(0);
	} finally {
		await f.scheduler.shutdown();
	}
});

test("pending cancellation retains runs and concurrency until cleanup finishes", async () => {
	vi.useFakeTimers();
	const f = fixture(true);
	const children = [f.prepared(0, true, "batch"), f.prepared(1, true, "batch")];
	const ids = children.map((child) => child.spec.id);
	try {
		await f.scheduler.admit({ batchId: "batch", background: true, prepared: children });
		const resultPromise = f.cancel(ids);
		await vi.advanceTimersByTimeAsync(30_000);
		const result = await resultPromise;
		expect(result.details).toMatchObject({ timedOut: true });
		expect(result.details).not.toHaveProperty("error");
		expect(result.content).toEqual(
			expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining("still in progress") })]),
		);
		expect(f.scheduler.targets(ids).map((child) => child.state)).toEqual(["running", "queued"]);
		expect(f.scheduler.targets(ids).every((child) => !child.collected)).toBe(true);
		const next = f.prepared(2, false);
		await f.scheduler.admit({ batchId: next.spec.batchId, background: true, prepared: [next] });
		expect(f.scheduler.targets([next.spec.id])[0].state).toBe("queued");
		f.release();
		await vi.advanceTimersByTimeAsync(0);
		expect(f.scheduler.targets(ids).every((child) => child.state === "cancelled" && !child.collected)).toBe(true);
		expect(f.scheduler.targets([next.spec.id])[0].state).toBe("running");
		expect(vi.getTimerCount()).toBe(0);
	} finally {
		f.release();
		await f.scheduler.shutdown();
	}
});

test("parent interruption releases the cancel wait without abandoning cleanup", async () => {
	vi.useFakeTimers();
	const f = fixture(true);
	const child = f.prepared(0);
	const parent = new AbortController();
	try {
		await f.scheduler.admit({ batchId: child.spec.batchId, background: true, prepared: [child] });
		const resultPromise = f.cancel([child.spec.id], parent.signal);
		parent.abort();
		expect((await resultPromise).details).toMatchObject({
			error: expect.stringContaining("Stopped waiting for cancellation"),
		});
		expect(f.scheduler.targets([child.spec.id])[0]).toMatchObject({ state: "running", collected: false });
		expect(vi.getTimerCount()).toBe(0);
	} finally {
		f.release();
		await f.scheduler.shutdown();
	}
});
