import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	estimateContextTokens as estimatePreparedContextTokens,
	estimateMessageTokens,
	getCurrentSystemMessage,
	normalizeContext,
	type TranscriptContext,
	type Message,
} from "@earendil-works/pi-ai";
import {
	buildSessionProjection,
	convertToLlm,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { CHECKPOINT_PROMPT, formatContinuation } from "./prompts.ts";

const STRUCTURAL_TOKEN_FACTOR = 1.35;
export const PROVIDER_SAFETY_TOKENS = 4_096;
export const MIN_CHECKPOINT_TOKENS = 1_024;
export const MAX_CHECKPOINT_TOKENS = 16_384;
export const MAX_RESPONSE_HEADROOM = 32_768;

interface RetentionSelection {
	firstKeptEntryId: string | null;
}

interface FittedCheckpointSource {
	context: TranscriptContext;
	estimatedTokens: number;
}

interface TurnGroup {
	firstEntryId: string;
	messages: Message[];
	tokens: number;
	protocolClosed: boolean;
}

export function checkpointHeadroom(contextWindow: number, desiredOutputCap: number): number {
	const checkpointAllowance = Math.min(MAX_CHECKPOINT_TOKENS, Math.floor(contextWindow * 0.1));
	const responseAllowance = Math.min(Math.max(0, desiredOutputCap), MAX_RESPONSE_HEADROOM);
	const requested = PROVIDER_SAFETY_TOKENS + Math.max(checkpointAllowance, responseAllowance);
	return Math.min(requested, Math.max(0, Math.floor(contextWindow / 2)));
}

export function estimatePendingTokens(context: Readonly<TranscriptContext>): number {
	const estimate = estimatePreparedContextTokens(context);
	return estimate.usageTokens + Math.ceil(estimate.trailingTokens * STRUCTURAL_TOKEN_FACTOR);
}

export function shouldCheckpointTokens(
	estimatedTokens: number,
	contextWindow: number,
	desiredOutputCap: number,
): boolean {
	if (contextWindow <= 0) return false;
	return estimatedTokens + checkpointHeadroom(contextWindow, desiredOutputCap) >= contextWindow;
}

export function shouldCheckpoint(
	context: Readonly<TranscriptContext>,
	contextWindow: number,
	desiredOutputCap: number,
): boolean {
	return shouldCheckpointTokens(estimatePendingTokens(context), contextWindow, desiredOutputCap);
}

function hasCompleteToolFlow(messages: readonly Message[]): boolean {
	const pending = new Set<string>();
	for (const message of messages) {
		if (message.role === "assistant") {
			if (pending.size > 0) return false;
			for (const block of message.content) {
				if (block.type !== "toolCall") continue;
				if (pending.has(block.id)) return false;
				pending.add(block.id);
			}
		} else if (message.role === "toolResult") {
			if (!pending.delete(message.toolCallId)) return false;
		} else if (pending.size > 0) {
			return false;
		}
	}
	return pending.size === 0;
}

function groupRetainableTurns(branchEntries: readonly SessionEntry[]): TurnGroup[] {
	const leafId = branchEntries.at(-1)?.id;
	const effectiveEntries = buildSessionProjection([...branchEntries], leafId).entries;
	const groups: Array<{ firstEntryId: string; messages: AgentMessage[] }> = [];
	let current: { firstEntryId: string; messages: AgentMessage[] } | undefined;

	for (const { sourceEntry: entry, messages } of effectiveEntries) {
		const role = messages[0]?.role;
		if (entry.type === "compaction" || !role || role === "system") continue;
		if (role === "user" || role === "custom" || role === "bashExecution" || role === "branchSummary") {
			current = { firstEntryId: entry.id, messages: [] };
			groups.push(current);
		}
		if (current) current.messages.push(...messages);
	}

	return groups.map((group) => {
		const messages = convertToLlm(group.messages);
		return {
			firstEntryId: group.firstEntryId,
			messages,
			tokens: messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0),
			protocolClosed: hasCompleteToolFlow(messages),
		};
	});
}

function checkpointMessage(checkpoint: string): Message {
	return {
		role: "user",
		content: [{ type: "text", text: formatContinuation(checkpoint) }],
		timestamp: Date.now(),
	};
}

export function selectRetainedAnchor(options: {
	branchEntries: readonly SessionEntry[];
	sourceContext: Readonly<TranscriptContext>;
	checkpoint: string;
	contextWindow: number;
	desiredOutputCap: number;
	keepRecentTokens: number;
}): RetentionSelection {
	const groups = groupRetainableTurns(options.branchEntries);
	const retainedMessages: Message[] = [];
	let retainedTokens = 0;
	let firstKeptEntryId: string | null = null;
	const headroom = checkpointHeadroom(options.contextWindow, options.desiredOutputCap);
	const summaryMessage = checkpointMessage(options.checkpoint);
	const system = getCurrentSystemMessage(options.sourceContext.messages);

	for (let index = groups.length - 1; index >= 0; index--) {
		const group = groups[index];
		if (!group.protocolClosed || retainedTokens + group.tokens > options.keepRecentTokens) break;
		const candidateMessages = [...group.messages, ...retainedMessages, summaryMessage];
		const candidateTokens = estimatePendingTokens(normalizeContext({
			messages: system ? [system, ...candidateMessages] : candidateMessages,
		}));
		if (candidateTokens + headroom >= options.contextWindow) break;

		retainedMessages.unshift(...group.messages);
		retainedTokens += group.tokens;
		firstKeptEntryId = group.firstEntryId;
	}

	return { firstKeptEntryId };
}

export function dropOldestSourceGroup(context: Readonly<TranscriptContext>): TranscriptContext | undefined {
	const starts: number[] = [];
	for (let index = 0; index < context.messages.length; index++) {
		if (context.messages[index].role === "user") starts.push(index);
	}
	if (starts.length < 2) return undefined;
	const system = getCurrentSystemMessage(context.messages);
	const retained = context.messages.slice(starts[1]).filter((message) => message.role !== "system");
	return {
		...context,
		messages: system ? [system, ...retained] : retained,
	};
}

export function fitCheckpointSource(
	sourceContext: Readonly<TranscriptContext>,
	contextWindow: number,
	minimumOutputTokens: number,
): FittedCheckpointSource {
	let context: TranscriptContext = {
		...sourceContext,
		messages: sourceContext.messages.slice(),
	};
	let estimatedTokens = estimatePreparedContextTokens(context).tokens;
	const promptTokens = estimateMessageTokens({
		role: "user",
		content: [{ type: "text", text: CHECKPOINT_PROMPT }],
		timestamp: Date.now(),
	});

	while (estimatedTokens + promptTokens + PROVIDER_SAFETY_TOKENS + minimumOutputTokens >= contextWindow) {
		const reduced = dropOldestSourceGroup(context);
		if (!reduced) break;
		context = reduced;
		estimatedTokens = context.messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
	}
	return { context, estimatedTokens };
}

export function checkpointOutputAllowance(
	estimatedSourceTokens: number,
	promptTokens: number,
	contextWindow: number,
	modelMaxTokens: number,
): number {
	const available = contextWindow - estimatedSourceTokens - promptTokens - PROVIDER_SAFETY_TOKENS;
	return Math.max(1, Math.min(MAX_CHECKPOINT_TOKENS, modelMaxTokens, available));
}
