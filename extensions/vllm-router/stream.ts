import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	type Context,
	clampThinkingLevel,
	createAssistantMessageEventStream,
	normalizeContext,
	type Model,
	type OpenAICompletionsOptions,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { streamOpenAICompletions } from "@earendil-works/pi-ai/compat";
import type {
	ServingTelemetryController,
	ServingTelemetryPhase,
} from "../shared/serving-telemetry.js";
import type { VllmRuntime } from "./types.js";

export function createVllmStream(
	runtime: VllmRuntime,
	telemetry: ServingTelemetryController,
): (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream {
	return (model, context, options) => {
		if (model.api !== "openai-completions") {
			throw new Error(`vLLM router expected openai-completions, received ${model.api}`);
		}
		if (!runtime.stats.enabled || options?.metadata?.servingTelemetry === false) {
			return streamVllm(model as Model<"openai-completions">, context, options);
		}
		const outer = createAssistantMessageEventStream();
		const telemetryId = telemetry.begin({
			enabled: runtime.stats.enabled,
			label: "vllm",
			minIntervalMs: runtime.stats.minIntervalMs,
		});
		let lastMessage: AssistantMessage | undefined;
		let inner: AssistantMessageEventStream;
		let phase: ServingTelemetryPhase = "prefill";

		try {
			const upstreamOnPayload = options?.onPayload;
			const upstreamOnStreamMetadata = options?.onStreamMetadata;
			inner = streamVllm(model as Model<"openai-completions">, context, {
				...options,
				onPayload: async (payload, requestModel) => {
					const replacement = await upstreamOnPayload?.(payload, requestModel);
					return withVllmTelemetry(replacement ?? payload);
				},
				onStreamMetadata: async (metadata, requestModel) => {
					const progress = parsePrefillProgress(metadata);
					if (progress) {
						telemetry.update(telemetryId, {
							phase: "prefill",
							promptProcessed: progress.processed,
							promptTotal: progress.total,
							promptCached: progress.cached,
						});
					}
					await upstreamOnStreamMetadata?.(metadata, requestModel);
				},
			});
		} catch (error) {
			telemetry.end(telemetryId);
			throw error;
		}

		void (async () => {
			try {
				for await (const event of inner) {
					lastMessage = messageFromEvent(event);
					if (isOutputEvent(event, lastMessage.usage.output)) phase = "decode";
					const promptTotal = lastMessage.usage.input
						+ lastMessage.usage.cacheRead
						+ lastMessage.usage.cacheWrite;
					telemetry.update(telemetryId, {
						phase,
						promptTotal: promptTotal > 0 ? promptTotal : undefined,
						promptProcessed: promptTotal > 0
							? lastMessage.usage.input + lastMessage.usage.cacheWrite
							: undefined,
						promptCached: promptTotal > 0 ? lastMessage.usage.cacheRead : undefined,
						outputTokens: lastMessage.usage.output,
					});
					outer.push(event);
				}
				outer.end(lastMessage);
			} catch (error) {
				const message = createRelayErrorMessage(model, error, lastMessage);
				outer.push({ type: "error", reason: "error", error: message });
				outer.end(message);
			} finally {
				telemetry.end(telemetryId);
			}
		})();

		return outer;
	};
}

/** Add only the model-neutral request fields required by live serving telemetry. */
function withVllmTelemetry(payload: unknown): unknown {
	if (!isRecord(payload)) return payload;
	const streamOptions = isRecord(payload.stream_options) ? payload.stream_options : {};
	const vllmXargs = isRecord(payload.vllm_xargs) ? payload.vllm_xargs : {};
	return {
		...payload,
		vllm_xargs: {
			...vllmXargs,
			prefill_progress: true,
		},
		stream_options: {
			...streamOptions,
			include_usage: true,
			continuous_usage_stats: true,
		},
	};
}

function streamVllm(
	model: Model<"openai-completions">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const { reasoning, thinkingBudgets, ...requestOptions } = options ?? {};
	const clampedReasoning = reasoning ? clampThinkingLevel(model, reasoning) : undefined;
	const reasoningEffort = clampedReasoning === "off" ? undefined : clampedReasoning;
	return streamOpenAICompletions(model, normalizeContext(context), {
		...requestOptions,
		reasoningEffort,
		thinkingBudgets,
	} satisfies OpenAICompletionsOptions);
}

function isOutputEvent(event: AssistantMessageEvent, outputTokens: number): boolean {
	if (outputTokens > 0) return true;
	return event.type === "text_delta" || event.type === "thinking_delta" || event.type === "toolcall_delta";
}

function messageFromEvent(event: AssistantMessageEvent): AssistantMessage {
	if (event.type === "done") return event.message;
	if (event.type === "error") return event.error;
	return event.partial;
}

function createRelayErrorMessage(
	model: Model<Api>,
	error: unknown,
	partial: AssistantMessage | undefined,
): AssistantMessage {
	const errorMessage = error instanceof Error ? error.message : String(error);
	if (partial) return { ...partial, stopReason: "error", errorMessage };
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage,
		timestamp: Date.now(),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface PrefillProgress {
	processed: number;
	total: number;
	cached: number;
}

function parsePrefillProgress(metadata: unknown): PrefillProgress | undefined {
	if (!isRecord(metadata) || metadata.object !== "chat.completion.prefill_progress") return undefined;
	const progress = metadata.prompt_progress;
	if (!isRecord(progress)) return undefined;
	const { processed, total, cached } = progress;
	if (!isNonNegativeInteger(processed) || !isNonNegativeInteger(total) || !isNonNegativeInteger(cached)) {
		return undefined;
	}
	if (processed > total || cached > processed) return undefined;
	return { processed, total, cached };
}

function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
