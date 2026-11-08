import {
	clampThinkingLevel,
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ServingTelemetryController } from "../shared/serving-telemetry.js";
import { isRecord } from "./guards.js";
import { postJsonWithIdleTimeout, responseErrorMessage, withAbortTimeout } from "./http.js";
import { readLlamaChunkStats } from "./llama-stats.js";
import { buildChatRequest, resolveCompat } from "./openai-format.js";
import { parseSseData } from "./sse.js";
import { firstChoice, mapStopReason, StreamingOutputWriter } from "./streaming-output.js";
import { isZeroUsage, parseUsage, usageFromLlamaTimings, zeroUsage } from "./usage.js";
import type { LlamaPromptProgress, LlamaTimings, RouterRuntime } from "./types.js";

export function createLlamaCppStream(
	runtime: RouterRuntime,
	telemetry: ServingTelemetryController,
): (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream {
	return (model, context, options) => {
		const stream = createAssistantMessageEventStream();

		void (async () => {
			const output = createOutput(model);
			const outputWriter = new StreamingOutputWriter(stream, output);
			const telemetryId =
				options?.metadata?.servingTelemetry === false
					? undefined
					: telemetry.begin({
							enabled: runtime.stats.enabled,
							label: "lcpp",
							minIntervalMs: runtime.stats.minIntervalMs,
						});
			let lastPromptProgress: LlamaPromptProgress | undefined;
			let lastTimings: LlamaTimings | undefined;
			let abortCleanup: (() => void) | undefined;

			try {
				const compat = resolveCompat(model);
				const reasoning = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
				let payload = buildChatRequest(
					model,
					context,
					reasoning === undefined
						? options
						: { ...options, reasoning: reasoning === "off" ? undefined : reasoning },
					runtime.request,
					compat,
				);
				const nextPayload = await options?.onPayload?.(payload, model);
				if (nextPayload !== undefined) {
					payload = nextPayload as typeof payload;
				}

				const timeout = withAbortTimeout(options?.signal, runtime.requestTimeoutMs ?? options?.timeoutMs);
				abortCleanup = timeout.cleanup;
				const response = await postJsonWithIdleTimeout(
					`${model.baseUrl.replace(/\/+$/, "")}/chat/completions`,
					requestHeaders(model, options),
					JSON.stringify(payload),
					timeout.signal,
					runtime.httpIdleTimeoutMs,
				);

				await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
				if (!response.ok) {
					throw new Error(await responseErrorMessage(response));
				}
				if (!response.body) {
					throw new Error("llama.cpp response did not include a stream body");
				}

				stream.push({ type: "start", partial: output });

				for await (const data of parseSseData(response.body)) {
					if (data === "[DONE]") break;
					const chunk = JSON.parse(data) as unknown;
					if (!isRecord(chunk)) continue;

					if (typeof chunk.id === "string" && output.responseId === undefined) {
						output.responseId = chunk.id;
					}
					if (typeof chunk.model === "string" && chunk.model.length > 0 && chunk.model !== model.id) {
						output.responseModel ??= chunk.model;
					}

					const stats = readLlamaChunkStats(chunk, lastPromptProgress);
					lastPromptProgress = stats.progress ?? lastPromptProgress;
					lastTimings = stats.timings ?? lastTimings;
					if (stats.telemetry) {
						telemetry.update(telemetryId, stats.telemetry);
					}

					if (chunk.usage) {
						output.usage = parseUsage(chunk.usage, model);
					}

					const choice = firstChoice(chunk.choices);
					if (!choice) continue;
					if (!chunk.usage && choice.usage) {
						output.usage = parseUsage(choice.usage, model);
					}

					const finish = mapStopReason(choice.finish_reason);
					if (finish) {
						output.stopReason = finish.stopReason;
						if (finish.errorMessage) output.errorMessage = finish.errorMessage;
					}

					const delta = choice.delta;
					if (!delta) continue;
					outputWriter.acceptDelta(delta);
				}

				outputWriter.finish();
				if (isZeroUsage(output.usage)) {
					output.usage = usageFromLlamaTimings(model, lastPromptProgress, lastTimings);
				}
				if (options?.signal?.aborted) {
					throw new Error("Request was aborted");
				}
				if (output.stopReason === "aborted") {
					throw new Error("Request was aborted");
				}
				if (output.stopReason === "error") {
					throw new Error(output.errorMessage || "Provider returned an error stop reason");
				}
				if (output.stopReason === "pending") {
					throw new Error("Provider stream ended without a finish reason");
				}

				stream.push({ type: "done", reason: output.stopReason, message: output });
				stream.end();
			} catch (error) {
				outputWriter.finish();
				output.stopReason = options?.signal?.aborted ? "aborted" : "error";
				output.errorMessage = error instanceof Error ? error.message : String(error);
				stream.push({ type: "error", reason: output.stopReason, error: output });
				stream.end();
			} finally {
				abortCleanup?.();
				if (telemetryId !== undefined) telemetry.end(telemetryId);
			}
		})();

		return stream;
	};
}

function createOutput(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: zeroUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function requestHeaders(model: Model<Api>, options: SimpleStreamOptions | undefined): Record<string, string> {
	const headers: Record<string, string> = {
		Accept: "text/event-stream",
		"Content-Type": "application/json",
		...model.headers,
		...options?.headers,
	};
	if (options?.apiKey && !hasHeader(headers, "authorization")) {
		headers.Authorization = `Bearer ${options.apiKey}`;
	}
	return headers;
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
	const lower = name.toLowerCase();
	return Object.keys(headers).some((key) => key.toLowerCase() === lower);
}

function headersToRecord(headers: Headers): Record<string, string> {
	const record: Record<string, string> = {};
	headers.forEach((value, key) => {
		record[key] = value;
	});
	return record;
}
