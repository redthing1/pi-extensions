import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
	ExtensionAPI,
	ExtensionContext,
	SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { createCheckpoint } from "./checkpoint.ts";
import { editCheckpoint } from "./edit.ts";
import { shouldCheckpoint } from "./policy.ts";
import { decodeCheckpoint, formatContinuation } from "./prompts.ts";

export async function createCheckpointWithFallback(
	event: SessionBeforeCompactEvent,
	ctx: ExtensionContext,
) {
	try {
		return await createCheckpoint(event, ctx);
	} catch (error) {
		if (!event.signal.aborted && !(error instanceof Error && error.name === "AbortError")) {
			ctx.ui.notify(
				`compact-horizon checkpoint failed; using Pi fallback: ${error instanceof Error ? error.message : String(error)}`,
				"warning",
			);
		}
		return undefined;
	}
}

export function formatCheckpointMessages(messages: readonly AgentMessage[]): AgentMessage[] | undefined {
	let changed = false;
	const projected = messages.map((message): AgentMessage => {
		if (message.role !== "compactionSummary") return message;
		const checkpoint = decodeCheckpoint(message.summary);
		if (!checkpoint) return message;
		changed = true;
		return {
			role: "user",
			content: [{ type: "text", text: formatContinuation(checkpoint) }],
			timestamp: message.timestamp,
		};
	});
	return changed ? projected : undefined;
}

export default function compactHorizon(pi: ExtensionAPI): void {
	pi.registerCommand("horizon", {
		description: "Edit the active Horizon summary: /horizon edit",
		handler: async (args, ctx) => {
			if (args.trim() !== "edit") {
				ctx.ui.notify("Usage: /horizon edit", "info");
				return;
			}
			await editCheckpoint(ctx);
		},
	});

	pi.on("session_compaction_check", (event) => ({
		action: shouldCheckpoint(event.context, event.model.contextWindow, event.desiredOutputCap) ? "compact" : "send",
	}));

	pi.on("session_before_compact", createCheckpointWithFallback);

	pi.on("context", (event) => {
		const messages = formatCheckpointMessages(event.messages);
		return messages ? { messages } : undefined;
	});
}
