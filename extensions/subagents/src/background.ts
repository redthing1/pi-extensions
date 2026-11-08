import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SubagentScheduler } from "./scheduler.ts";
import { renderSubagentUpdates } from "./render.ts";
import type { SubagentUpdate } from "./types.ts";

/** Completion is an invitation to collect, never an unsolicited result dump. */
export function registerBackgroundRuns(pi: ExtensionAPI, scheduler: SubagentScheduler) {
	pi.registerMessageRenderer<readonly SubagentUpdate[]>("subagent-update", renderSubagentUpdates);
	let context: ExtensionContext | undefined;
	let busy = false;
	let prompting = false;
	let stopped = false;
	let closed = false;
	let scheduled = false;
	let status: string | undefined;
	let turnSignal: AbortSignal | undefined;

	function refresh() {
		if (closed || !context) return;
		const children = scheduler.runs({ includeCollected: true });
		const running = children.filter((child) => child.state === "running").length;
		const queued = children.filter((child) => child.state === "queued").length;
		const ready = children.filter((child) => child.finishedAt !== undefined && !child.collected).length;
		const nextStatus = [running && `${running} running`, queued && `${queued} queued`, ready && `${ready} ready`]
			.filter(Boolean)
			.join(" · ");
		if (nextStatus !== status) {
			status = nextStatus;
			context.ui.setStatus("subagents", nextStatus ? `Subagents: ${nextStatus}` : undefined);
		}
		if (busy || prompting || stopped || turnSignal?.aborted || !context.isIdle() || context.hasPendingMessages())
			return;
		const notices = scheduler.notices();
		if (!notices.length) return;
		const delivered: Array<{ id: string; completion: boolean; messages: (typeof notices)[number]["messages"] }> = [];
		const lines: string[] = [];
		const updates: SubagentUpdate[] = [];
		let bytes = 0;
		for (const notice of notices) {
			const messages: typeof notice.messages = [];
			for (const message of notice.messages) {
				const line = `${notice.child.id} (${notice.child.label}): ${message.text}`;
				if (bytes + Buffer.byteLength(line) > 40_000) break;
				lines.push(line);
				bytes += Buffer.byteLength(line);
				messages.push(message);
			}
			const completion = notice.completion && bytes < 38_000;
			if (completion) {
				const line = `${notice.child.id} (${notice.child.label}): ${notice.child.state}. Collect with subagent_wait.`;
				lines.push(line);
				bytes += Buffer.byteLength(line);
			}
			if (completion || messages.length) {
				delivered.push({ id: notice.child.id, completion, messages });
				updates.push({
					id: notice.child.id,
					label: notice.child.label,
					messages: messages.map((message) => message.text),
					state: completion ? notice.child.state : undefined,
					error: completion ? notice.error : undefined,
				});
			}
		}
		if (!lines.length) return;
		try {
			pi.sendMessage(
				{
					customType: "subagent-update",
					content: `Subagent updates:\n${lines.join("\n\n")}`,
					display: true,
					details: updates,
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		} catch (error) {
			context.ui.notify(
				`Subagent updates could not be delivered: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
			return;
		}
		for (const notice of delivered) scheduler.markNotified(notice.id, notice.completion, notice.messages);
	}

	function schedule() {
		if (scheduled || closed) return;
		scheduled = true;
		queueMicrotask(() => {
			scheduled = false;
			refresh();
		});
	}

	const unsubscribe = scheduler.subscribe(schedule);
	pi.on("session_start", async (event, ctx) => {
		if (event.reason === "new" || event.reason === "resume" || event.reason === "fork") {
			busy = true;
			await scheduler.reset();
			turnSignal = undefined;
			stopped = false;
			busy = false;
		}
		context = ctx;
		schedule();
	});
	pi.on("agent_start", (_event, ctx) => {
		context = ctx;
		turnSignal = ctx.signal;
		busy = true;
		stopped = false;
	});
	pi.on("agent_end", (event) => {
		const last = [...event.messages].reverse().find((message) => message.role === "assistant");
		if (last?.role === "assistant" && (last.stopReason === "aborted" || last.stopReason === "error")) stopped = true;
	});
	pi.on("agent_settled", () => {
		busy = false;
		schedule();
	});
	pi.on("session_compact", schedule);
	pi.on("session_compact_failed", (event) => {
		if (event.aborted) stopped = true;
		schedule();
	});
	pi.on("ui_prompt_start", () => {
		prompting = true;
	});
	pi.on("ui_prompt_end", () => {
		prompting = false;
		schedule();
	});
	pi.on("session_shutdown", () => {
		closed = true;
		unsubscribe();
		context?.ui.setStatus("subagents", undefined);
	});
}
