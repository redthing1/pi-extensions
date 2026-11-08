import { normalizeContext, type Context, type Model } from "@earendil-works/pi-ai";
import { describe, expect, test, vi } from "vitest";
import { ServingTelemetryController } from "../../shared/serving-telemetry.ts";
import { createVllmStream } from "../stream.ts";
import type { VllmRuntime } from "../types.ts";

const runtime: VllmRuntime = {
	router: { name: "local", url: "https://vllm.example.com" },
	provider: "vllm-local",
	serverUrl: "https://vllm.example.com",
	apiBaseUrl: "https://vllm.example.com/v1",
	stats: { enabled: false, minIntervalMs: 100 },
	discoveryTimeoutMs: 5_000,
};

const telemetryRuntime: VllmRuntime = {
	...runtime,
	stats: { enabled: true, minIntervalMs: 100 },
};

const model: Model<"openai-completions"> = {
	id: "model",
	name: "Model",
	api: "openai-completions",
	provider: runtime.provider,
	baseUrl: runtime.apiBaseUrl,
	reasoning: true,
	thinkingLevelMap: { off: "none", high: "high", max: "max" },
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_000_000,
	maxTokens: 1_000_000,
	compat: { maxTokensField: "max_tokens", thinkingFormat: "openai", supportsReasoningEffort: true },
};

const context: Context = {
	messages: [{ role: "user", content: "hello", timestamp: 1 }],
};

function capturePayload(): { fetch: typeof globalThis.fetch; payload(): Record<string, unknown> } {
	let payload: Record<string, unknown> | undefined;
	return {
		fetch: async (_input, init) => {
			payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
			const chunk = {
				id: "response",
				object: "chat.completion.chunk",
				created: 1,
				model: model.id,
				choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
				usage: { prompt_tokens: 1, completion_tokens: 1 },
			};
			return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
				headers: { "content-type": "text/event-stream" },
			});
		},
		payload: () => {
			if (!payload) throw new Error("request was not captured");
			return payload;
		},
	};
}

describe("vLLM request policy", () => {
	test.each([false, true])("preserves system instructions and tools (normalized: %s)", async (normalized) => {
		const input: Context = {
			...context,
			systemPrompt: "Synthetic instructions",
			tools: [{ name: "read", description: "Read", parameters: { type: "object", properties: {} } }],
		};
		const prepared = normalized ? normalizeContext(input) : input;
		const stream = createVllmStream(runtime, new ServingTelemetryController());
		const main = capturePayload();
		await stream(model, prepared, { apiKey: "test", fetch: main.fetch }).result();
		const side = capturePayload();
		await stream(
			model,
			{ ...prepared, messages: [...prepared.messages, { role: "user", content: "side question", timestamp: 2 }] },
			{
				apiKey: "test",
				fetch: side.fetch,
			},
		).result();

		expect(main.payload().messages).toEqual([
			{ role: "developer", content: "Synthetic instructions" },
			{ role: "user", content: "hello" },
		]);
		expect(main.payload().tools).toMatchObject([{ type: "function", function: { name: "read" } }]);
		expect(side.payload().messages).toEqual([
			...(main.payload().messages as unknown[]),
			{ role: "user", content: "side question" },
		]);
		expect(side.payload().tools).toEqual(main.payload().tools);
	});

	test.each([false, true])("quiet requests preserve foreground progress (failure: %s)", async (failure) => {
		const telemetry = new ServingTelemetryController();
		const working = vi.fn();
		telemetry.attach({ ui: { setWorkingMessage: working } } as never);
		const id = telemetry.begin({ enabled: true, label: "foreground", minIntervalMs: 100_000 });
		working.mockClear();
		const capture = capturePayload();
		try {
			const result = await createVllmStream(telemetryRuntime, telemetry)(model, context, {
				apiKey: "test",
				fetch: failure
					? async () => {
							throw new Error("Synthetic failure");
						}
					: capture.fetch,
				maxRetries: 0,
				metadata: { servingTelemetry: false },
			}).result();
			expect(result.stopReason).toBe(failure ? "error" : "stop");
			expect(working).not.toHaveBeenCalled();
			telemetry.update(id, { phase: "decode", outputTokens: 5 });
			expect(working.mock.calls.at(-1)?.[0]).toContain("foreground");
			if (!failure) {
				expect(result.usage.output).toBe(1);
				expect(capture.payload()).not.toHaveProperty("metadata");
				expect(capture.payload()).not.toHaveProperty("vllm_xargs");
				expect(capture.payload().stream_options).not.toHaveProperty("continuous_usage_stats");
			}
		} finally {
			telemetry.end();
		}
	});

	test("adds canonical serving telemetry while preserving caller fields", async () => {
		const capture = capturePayload();
		await createVllmStream(telemetryRuntime, new ServingTelemetryController())(model, context, {
			apiKey: "test",
			fetch: capture.fetch,
			onPayload: (payload) => ({
				...payload,
				vllm_xargs: { caller_option: 7 },
				stream_options: { caller_option: true },
			}),
		}).result();

		expect(capture.payload()).toMatchObject({
			vllm_xargs: { caller_option: 7, prefill_progress: true },
			stream_options: {
				caller_option: true,
				include_usage: true,
				continuous_usage_stats: true,
			},
		});
	});

	test("omits an output limit while preserving semantic reasoning", async () => {
		const capture = capturePayload();
		await createVllmStream(runtime, new ServingTelemetryController())(model, context, {
			apiKey: "test",
			fetch: capture.fetch,
			reasoning: "max",
		}).result();

		expect(capture.payload()).toMatchObject({ reasoning_effort: "max" });
		expect(capture.payload()).not.toHaveProperty("max_tokens");
		expect(capture.payload()).not.toHaveProperty("max_completion_tokens");

		const off = capturePayload();
		await createVllmStream(runtime, new ServingTelemetryController())(model, context, {
			apiKey: "test",
			fetch: off.fetch,
		}).result();
		expect(off.payload()).toMatchObject({ reasoning_effort: "none" });
	});

	test("honors an explicit per-request output limit", async () => {
		const capture = capturePayload();
		await createVllmStream(runtime, new ServingTelemetryController())(model, context, {
			apiKey: "test",
			fetch: capture.fetch,
			maxTokens: 4_096,
		}).result();

		expect(capture.payload()).toMatchObject({ max_tokens: 4_096 });
	});
});
