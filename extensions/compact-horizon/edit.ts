import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { decodeCheckpoint, encodeCheckpoint } from "./prompts.ts";

export async function editCheckpoint(
	ctx: Pick<
		ExtensionCommandContext,
		"hasUI" | "isIdle" | "hasPendingMessages" | "sessionManager" | "editCompactionSummary"
	> & { ui: Pick<ExtensionCommandContext["ui"], "editor" | "notify"> },
): Promise<void> {
	if (!ctx.hasUI) throw new Error("Editing a Horizon summary requires an interactive editor.");
	if (!ctx.isIdle() || ctx.hasPendingMessages()) {
		throw new Error("Wait for the session to become idle before editing its summary.");
	}
	const manager = ctx.sessionManager;
	const checkpoint = manager.buildSessionProjection().entries.find((entry) => entry.sourceEntry.type === "compaction");
	const message = checkpoint?.messages.find((message) => message.role === "compactionSummary");
	const body = message && decodeCheckpoint(message.summary);
	if (!checkpoint || !body) throw new Error("There is no active Horizon summary to edit.");
	const sessionId = manager.getSessionId();
	const leafId = manager.getLeafId();
	const edited = await ctx.ui.editor("Edit Horizon summary (save keeps subsequent messages)", body);
	if (edited === undefined || edited.trim() === body) return;
	if (!edited.trim()) throw new Error("Horizon summary must not be empty.");
	if (ctx.sessionManager.getSessionId() !== sessionId || ctx.sessionManager.getLeafId() !== leafId) {
		throw new Error("The conversation changed while editing. Reopen the summary editor.");
	}
	ctx.editCompactionSummary(checkpoint.sourceEntry.id, encodeCheckpoint(edited));
	ctx.ui.notify("Horizon summary updated", "info");
}
