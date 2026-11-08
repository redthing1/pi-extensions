import { expect, test, vi } from "vitest";
import type { Context, Model } from "@earendil-works/pi-ai";
import { ServingTelemetryController } from "../../shared/serving-telemetry.ts";
import { createRuntime } from "../config.ts";
import { createLlamaCppStream } from "../stream.ts";

const runtime = createRuntime({ name: "fixture", url: "http://fixture.invalid" });
const model: Model<"openai-completions"> = {
	id: "fixture",
	name: "Fixture",
	api: "openai-completions",
	provider: runtime.provider,
	baseUrl: runtime.apiBaseUrl,
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 65536,
	maxTokens: 8192,
};
const context: Context = { messages: [{ role: "user", content: "synthetic task", timestamp: 0 }] };

test.each([false, true])("quiet requests preserve foreground progress (failure: %s)", async (failure) => {
	const payloads: Record<string, unknown>[] = [];
	const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
		expect(String(url)).toBe("http://fixture.invalid/v1/chat/completions");
		payloads.push(JSON.parse(String(init?.body)));
		if (failure) return new Response("Synthetic failure", { status: 500 });
		const chunk = {
			choices: [{ index: 0, delta: { content: "synthetic answer" }, finish_reason: "stop" }],
			usage: { prompt_tokens: 100, completion_tokens: 4 },
		};
		return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
			headers: { "content-type": "text/event-stream" },
		});
	});
	const telemetry = new ServingTelemetryController();
	const working = vi.fn();
	telemetry.attach({ ui: { setWorkingMessage: working } } as never);
	const id = telemetry.begin({ enabled: true, label: "foreground", minIntervalMs: 100_000 });
	working.mockClear();
	try {
		const result = await createLlamaCppStream(runtime, telemetry)(model, context, {
			apiKey: "synthetic",
			metadata: { servingTelemetry: false },
		}).result();
		expect(result.stopReason).toBe(failure ? "error" : "stop");
		expect(working).not.toHaveBeenCalled();
		telemetry.update(id, { phase: "decode", outputTokens: 5 });
		expect(working.mock.calls.at(-1)?.[0]).toContain("foreground");
		expect(payloads).toHaveLength(1);
		expect(payloads[0]).not.toHaveProperty("metadata");
		if (!failure) expect(result.usage.output).toBe(4);
	} finally {
		telemetry.end();
		fetchMock.mockRestore();
	}
});
