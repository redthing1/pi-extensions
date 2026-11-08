import { estimateMessageTokens, isContextOverflow, type TranscriptContext, type Message } from "@earendil-works/pi-ai";
import type { ExtensionContext, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import {
	checkpointOutputAllowance,
	dropOldestSourceGroup,
	fitCheckpointSource,
	MAX_CHECKPOINT_TOKENS,
	MIN_CHECKPOINT_TOKENS,
	selectRetainedAnchor,
} from "./policy.ts";
import { CHECKPOINT_PROMPT, CHECKPOINT_STRATEGY, encodeCheckpoint } from "./prompts.ts";

type CheckpointContext = Pick<ExtensionContext, "model" | "modelRegistry" | "privacy" | "thinkingLevel">;

function checkpointRequest(sourceContext: Readonly<TranscriptContext>, timestamp = Date.now()): TranscriptContext {
	const prompt: Message = {
		role: "user",
		content: [{ type: "text", text: CHECKPOINT_PROMPT }],
		timestamp,
	};
	return {
		...sourceContext,
		messages: [...sourceContext.messages, prompt],
	};
}

export function buildCheckpointContext(
	sourceContext: Readonly<TranscriptContext>,
	contextWindow: number,
	modelMaxTokens: number,
	timestamp = Date.now(),
): { context: TranscriptContext; maxTokens: number } {
	const minimumOutput = Math.min(MIN_CHECKPOINT_TOKENS, modelMaxTokens);
	const fittedSource = fitCheckpointSource(sourceContext, contextWindow, minimumOutput);
	const context = checkpointRequest(fittedSource.context, timestamp);
	const promptTokens = estimateMessageTokens(context.messages.at(-1)!);
	return {
		context,
		maxTokens: checkpointOutputAllowance(
			fittedSource.estimatedTokens,
			promptTokens,
			contextWindow,
			modelMaxTokens,
		),
	};
}

export async function createCheckpoint(event: SessionBeforeCompactEvent, ctx: CheckpointContext) {
	const model = ctx.model;
	if (!model) return undefined;
	const reasoning = ctx.thinkingLevel === "off" ? undefined : ctx.thinkingLevel;
	const completeCheckpoint = (checkpoint: { context: TranscriptContext; maxTokens: number }) =>
		ctx.modelRegistry.completeSimple(model, checkpoint.context, {
			maxTokens: checkpoint.maxTokens,
			sessionId: event.providerSessionId,
			signal: event.signal,
			reasoning,
			allowModelFallbacks: !ctx.privacy.remoteZdr,
		});

	let request = buildCheckpointContext(event.sourceContext, model.contextWindow, model.maxTokens);
	let response = await completeCheckpoint(request);

	if (response.stopReason === "error" && isContextOverflow(response, model.contextWindow)) {
		const sourceWithoutOldestGroup = dropOldestSourceGroup({
			...request.context,
			messages: request.context.messages.slice(0, -1),
		});
		if (sourceWithoutOldestGroup) {
			request = buildCheckpointContext(sourceWithoutOldestGroup, model.contextWindow, model.maxTokens);
			response = await completeCheckpoint(request);
		}
	}

	if (response.stopReason === "aborted") throw new DOMException("Checkpoint cancelled", "AbortError");
	if (response.stopReason === "error") {
		throw new Error(response.errorMessage || "Checkpoint request failed");
	}
	if (response.stopReason === "length") {
		throw new Error("Checkpoint response reached its output limit");
	}
	if (response.content.some((block) => block.type === "toolCall")) {
		throw new Error("Checkpoint response attempted to call a tool");
	}

	const checkpoint = response.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n")
		.trim();
	if (!checkpoint) return undefined;

	const retention =
		event.reason === "overflow"
			? { firstKeptEntryId: null }
			: selectRetainedAnchor({
					branchEntries: event.branchEntries,
					sourceContext: event.sourceContext,
					checkpoint,
					contextWindow: model.contextWindow,
					desiredOutputCap: model.maxTokens,
					keepRecentTokens: event.preparation.settings.keepRecentTokens,
				});

	return {
		compaction: {
			summary: encodeCheckpoint(checkpoint),
			label: "horizon",
			firstKeptEntryId: retention.firstKeptEntryId,
			placement: "after-retained" as const,
			tokensBefore: event.preparation.tokensBefore,
			usage: response.usage,
			details: {
				strategy: CHECKPOINT_STRATEGY,
				model: { provider: model.provider, id: model.id },
			},
		},
	};
}
