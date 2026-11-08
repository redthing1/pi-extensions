import {
	estimateContextTokens,
	normalizeContext,
	type Api,
	type AssistantMessage,
	type Message,
	type Model,
	type ModelThinkingLevel,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const BTW_PROMPT =
	"This is a side question about the conversation. Answer it directly without continuing the main task or using tools.";
export const OBSERVER_PROMPT =
	"Take a fresh look at this conversation. Is there something consequential the user has likely missed that would change a decision or prevent a mistake in their current work? Use only the conversation and your judgment. Most checks should return `none`: skip general advice, speculative concerns, and anything the user already understands or the main conversation is addressing. If something clearly warrants their attention, briefly explain what it is and why it matters; otherwise reply `none`.";

export class SideRequestError extends Error {}

export interface Snapshot {
	context: TranscriptContext;
	model: Model<Api>;
	reasoning?: ModelThinkingLevel;
	at: number;
	/** Last main request payload, retained only in memory for a pre-dispatch prefix check. */
	payload?: unknown;
}

export interface Topic extends Snapshot {
	title: string;
	kind: "btw" | "observer";
	exchanges: { question: string; answer: string }[];
	partial: string;
	pendingQuestion?: string;
	status: "working" | "ready" | "cancelled" | "error";
	error?: string;
	usage?: AssistantMessage["usage"];
	draft?: string;
	unread?: boolean;
}

export function appendQuestion(context: TranscriptContext, text: string): TranscriptContext {
	const question: Message = { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
	return normalizeContext({ messages: [...context.messages, question] });
}

export function outputBudget(context: TranscriptContext, model: Model<Api>): number {
	const estimate = estimateContextTokens(context);
	const input = estimate.usageTokens + Math.ceil(estimate.trailingTokens * 1.35);
	const budget = Math.min(model.maxTokens, 8192);
	if (model.contextWindow <= 0 || budget <= 0 || input + budget + 1024 >= model.contextWindow) {
		throw new SideRequestError(
			"Not enough context room for a side answer. Continue after the main conversation compacts.",
		);
	}
	return budget;
}

/** Compare prompt-bearing payload fields, leaving output budgets and transport fields alone. */
export function preservesPrefix(main: unknown, side: unknown): boolean {
	if (!main || !side || typeof main !== "object" || typeof side !== "object") return false;
	const original = main as Record<string, unknown>;
	const next = side as Record<string, unknown>;
	const history = ["messages", "input", "contents"].find((key) => Array.isArray(original[key]));
	if (!history || !Array.isArray(next[history])) return false;
	const prefix = original[history] as unknown[];
	const candidate = next[history] as unknown[];
	if (
		candidate.length < prefix.length ||
		prefix.some((item, index) => JSON.stringify(item) !== JSON.stringify(candidate[index]))
	)
		return false;
	return [
		"system",
		"instructions",
		"systemInstruction",
		"tools",
		"tool_choice",
		"thinking",
		"reasoning",
		"chat_template_kwargs",
	].every((key) => JSON.stringify(original[key]) === JSON.stringify(next[key]));
}

export async function answer(
	ctx: ExtensionContext,
	snapshot: Snapshot,
	context: TranscriptContext,
	signal: AbortSignal,
	onText: (text: string) => void,
): Promise<AssistantMessage> {
	const maxTokens = outputBudget(context, snapshot.model);
	let incompatiblePrefix = false;
	// SSE retains the runtime's cache affinity without sharing a stateful WebSocket continuation.
	const stream = ctx.modelRegistry.streamSimple(snapshot.model, context, {
		reasoning: snapshot.reasoning === "off" ? undefined : snapshot.reasoning,
		maxTokens,
		transport: "sse",
		allowModelFallbacks: false,
		maxRetries: 0,
		metadata: { servingTelemetry: false },
		signal,
		onPayload: (payload) => {
			if (snapshot.payload !== undefined && !preservesPrefix(snapshot.payload, payload)) {
				incompatiblePrefix = true;
				throw new SideRequestError("Side request would change the cached prefix.");
			}
		},
	});
	let lastUpdate = 0;
	for await (const event of stream) {
		signal.throwIfAborted();
		if (event.type === "text_delta" && Date.now() - lastUpdate >= 60) {
			lastUpdate = Date.now();
			onText(responseText(event.partial));
		}
	}
	const response = await stream.result();
	signal.throwIfAborted();
	if (incompatiblePrefix)
		throw new SideRequestError("The side request could not preserve the cached prefix; no request was sent.");
	if (response.content.some((part) => part.type === "toolCall")) {
		throw new SideRequestError("The side response attempted a tool call; no tool was executed.");
	}
	if (response.stopReason === "error" || response.stopReason === "aborted") {
		throw new SideRequestError("Side request failed. The main task is unchanged.");
	}
	if (response.stopReason === "length")
		throw new SideRequestError("Side answer reached its output limit. Try a narrower question.");
	if (!responseText(response)) throw new SideRequestError("The side request returned no answer.");
	return response;
}

export function responseText(response: AssistantMessage): string {
	return response.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n")
		.trim();
}
