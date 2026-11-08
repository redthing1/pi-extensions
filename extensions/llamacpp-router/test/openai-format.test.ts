import { describe, expect, test } from "vitest";
import { normalizeContext, type Context, type Model } from "@earendil-works/pi-ai";
import { createRuntime } from "../config.ts";
import { modelConfig } from "../models.ts";
import { buildChatRequest, resolveCompat } from "../openai-format.ts";
import { inferTemplateFeatures } from "../template-compat.ts";
import type { LiveServerInfo } from "../types.ts";

const model: Model<"openai-completions"> = {
	id: "local-model",
	name: "Local Model",
	api: "openai-completions",
	provider: "llamacpp-local",
	baseUrl: "http://localhost:8080/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 131072,
	maxTokens: 131072,
};
const context: Context = {
	messages: [{ role: "user", content: "hello", timestamp: 1 }],
};
const request = {
	returnProgress: true,
	timingsPerToken: true,
	includeUsage: true,
};

describe("llama.cpp transcript serialization", () => {
	test.each([false, true])("preserves system instructions and tools (normalized: %s)", (normalized) => {
		const input: Context = {
			...context,
			systemPrompt: "Synthetic instructions",
			tools: [{ name: "read", description: "Read", parameters: { type: "object", properties: {} } }],
		};
		const prepared = normalized ? normalizeContext(input) : input;
		const main = buildChatRequest(model, prepared, undefined, request, resolveCompat(model));
		const side = buildChatRequest(
			model,
			{
				...prepared,
				messages: [...prepared.messages, { role: "user", content: "side question", timestamp: 2 }],
			},
			undefined,
			request,
			resolveCompat(model),
		);

		expect(main.messages).toEqual([
			{ role: "system", content: "Synthetic instructions" },
			{ role: "user", content: "hello" },
		]);
		expect(main.tools).toMatchObject([{ type: "function", function: { name: "read" } }]);
		expect(side.messages).toEqual([...main.messages, { role: "user", content: "side question" }]);
		expect(side.tools).toEqual(main.tools);
	});
});

describe("llama.cpp output limits", () => {
	test("leaves ordinary output length to the server", () => {
		const payload = buildChatRequest(
			model,
			context,
			undefined,
			request,
			resolveCompat(model),
		);
		expect(payload.max_tokens).toBeUndefined();
		expect(payload.max_completion_tokens).toBeUndefined();
	});

	test("honors an explicit per-request limit", () => {
		const payload = buildChatRequest(
			model,
			context,
			{ maxTokens: 4096 },
			request,
			resolveCompat(model),
		);
		expect(payload.max_tokens).toBe(4096);
		expect(payload.max_completion_tokens).toBeUndefined();
	});
});

describe("llama.cpp template reasoning", () => {
	test("uses advertised effort levels as Pi model capabilities", () => {
		const live: LiveServerInfo = {
			contextWindow: 131072,
			input: ["text"],
			reasoning: false,
			template: {
				supportsReasoningEffort: true,
				reasoningEffortLevels: ["low", "medium", "high", "xhigh"],
				supportsPreserveReasoning: true,
			},
		};
		const discovered = modelConfig(createRuntime({ name: "local", url: "http://localhost:8080" }), {
			id: "qwen3.8-27b",
		}, live);

		expect(discovered.reasoning).toBe(true);
		expect(discovered.thinkingLevelMap).toEqual({
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: null,
		});
		expect(discovered.compat).toMatchObject({
			thinkingFormat: "chat-template",
			chatTemplateKwargs: {
				enable_thinking: { $var: "thinking.enabled" },
				preserve_thinking: true,
				reasoning_effort: { $var: "thinking.effort", omitWhenOff: true },
			},
		});

		const discoveredModel: Model = { ...discovered, provider: "llamacpp-local" };
		const payload = buildChatRequest(
			discoveredModel,
			context,
			{ reasoning: "xhigh" },
			request,
			resolveCompat(discoveredModel),
		);
		expect(payload.chat_template_kwargs).toEqual({
			enable_thinking: true,
			preserve_thinking: true,
			reasoning_effort: "xhigh",
		});
	});

	test("disables thinking without dropping template preservation", () => {
		const modelWithTemplate: Model<"openai-completions"> = {
			...model,
			reasoning: true,
			compat: {
				thinkingFormat: "chat-template",
				chatTemplateKwargs: {
					enable_thinking: { $var: "thinking.enabled" },
					preserve_thinking: true,
					reasoning_effort: { $var: "thinking.effort", omitWhenOff: true },
				},
			},
		};
		const payload = buildChatRequest(
			modelWithTemplate,
			context,
			undefined,
			request,
			resolveCompat(modelWithTemplate),
		);

		expect(payload.chat_template_kwargs).toEqual({
			enable_thinking: false,
			preserve_thinking: true,
		});
	});

	test("does not invent effort support without server capability metadata", () => {
		expect(inferTemplateFeatures({})).toEqual({
			supportsThinking: false,
			supportsReasoningEffort: false,
			supportsPreserveReasoning: false,
		});
		expect(inferTemplateFeatures({ reasoningEffortLevels: ["low", "xhigh"] })).toMatchObject({
			supportsThinking: true,
			supportsReasoningEffort: true,
			reasoningEffortLevels: ["low", "xhigh"],
		});
		expect(inferTemplateFeatures({ reasoningEffortLevels: ["provider-specific"] })).toEqual({
			supportsThinking: false,
			supportsReasoningEffort: false,
			reasoningEffortLevels: [],
			supportsPreserveReasoning: false,
		});
	});

	test("does not send a level that the server advertised as unsupported", () => {
		const mappedModel: Model<"openai-completions"> = {
			...model,
			reasoning: true,
			thinkingLevelMap: {
				minimal: null,
				low: "low",
				medium: "medium",
				high: "high",
				xhigh: "xhigh",
				max: null,
			},
			compat: {
				thinkingFormat: "chat-template",
				chatTemplateKwargs: {
					enable_thinking: { $var: "thinking.enabled" },
					reasoning_effort: { $var: "thinking.effort", omitWhenOff: true },
				},
			},
		};
		const payload = buildChatRequest(
			mappedModel,
			context,
			{ reasoning: "minimal" },
			request,
			resolveCompat(mappedModel),
		);

		expect(payload.chat_template_kwargs).toEqual({ enable_thinking: false });
	});
});
