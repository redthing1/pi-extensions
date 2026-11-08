import { describe, expect, test } from "vitest";
import { parseVllmModelCatalog } from "../catalog.ts";
import { discoveredModels } from "../models.ts";
import type { VllmRuntime } from "../types.ts";

const runtime: VllmRuntime = {
	router: { name: "local", url: "https://vllm.example.com", zdr: true },
	provider: "vllm-local",
	serverUrl: "https://vllm.example.com",
	apiBaseUrl: "https://vllm.example.com/v1",
	stats: { enabled: true, minIntervalMs: 100 },
	discoveryTimeoutMs: 5000,
};

describe("vLLM model catalog", () => {
	test("translates conventional endpoint metadata into exact Pi capabilities", () => {
		const listings = parseVllmModelCatalog({
			data: [
				{
					id: "reasoning-model",
					name: "Reasoning Model",
					max_model_len: 1048576,
					max_completion_tokens: 65536,
					architecture: { input_modalities: ["text", "image"] },
					supported_parameters: ["temperature", "reasoning_effort"],
					reasoning_options: ["none", "low", "high", "max"],
					default_parameters: { reasoning_effort: "max" },
				},
			],
		});

		expect(listings).toEqual([
			{
				id: "reasoning-model",
				name: "Reasoning Model",
				contextWindow: 1048576,
				maxTokens: 65536,
				input: ["text", "image"],
				reasoning: {
					thinkingLevelMap: {
						off: "none",
						minimal: null,
						low: "low",
						medium: null,
						high: "high",
						xhigh: null,
						max: "max",
					},
					defaultThinkingLevel: "max",
				},
			},
		]);

		const [model] = discoveredModels(runtime, listings);
		expect(model).toMatchObject({
			reasoning: true,
			defaultThinkingLevel: "max",
			contextWindow: 1048576,
			maxTokens: 65536,
			zdr: true,
			compat: {
				thinkingFormat: "openai",
				supportsReasoningEffort: true,
				supportsThinkingTokenBudget: false,
			},
		});
	});

	test("does not infer reasoning support from model names or partial metadata", () => {
		const listings = parseVllmModelCatalog({
			data: [
				{ id: "deepseek-reasoning-looking-name", max_model_len: 8192 },
				{ id: "options-without-parameter", reasoning_options: ["low", "high"] },
				{
					id: "parameter-without-options",
					supported_parameters: ["reasoning_effort"],
				},
			],
		});

		expect(listings).toHaveLength(3);
		expect(listings.every((listing) => listing.reasoning === undefined)).toBe(true);
		expect(discoveredModels(runtime, listings).every((model) => model.reasoning === false)).toBe(true);
		expect(discoveredModels(runtime, listings).map((model) => model.maxTokens)).toEqual([8192, 128000, 128000]);
	});

	test("ignores a default that is not one of the exact advertised wire values", () => {
		const [listing] = parseVllmModelCatalog({
			data: [
				{
					id: "model",
					supported_parameters: ["reasoning_effort"],
					reasoning_options: ["none", "high"],
					default_parameters: { reasoning_effort: "off" },
				},
			],
		});

		expect(listing.reasoning?.defaultThinkingLevel).toBeUndefined();
	});

	test("keeps local policy and overrides above advertised metadata", () => {
		const [listing] = parseVllmModelCatalog({
			data: [
				{
					id: "model",
					max_model_len: 100000,
					max_completion_tokens: 20000,
					architecture: { input_modalities: ["text", "image"] },
					supported_parameters: ["reasoning_effort"],
					reasoning_options: ["none", "low", "high"],
					default_parameters: { reasoning_effort: "high" },
				},
			],
		});
		const overridden = discoveredModels(
			{
				...runtime,
				router: {
					...runtime.router,
					models: {
						model: {
							name: "Operator Name",
							zdr: false,
							defaultThinkingLevel: "low",
							input: ["text"],
							contextWindow: 64000,
							maxTokens: 12000,
						},
					},
				},
			},
			[listing],
		)[0];

		expect(overridden).toMatchObject({
			name: "Operator Name",
			zdr: false,
			defaultThinkingLevel: "low",
			input: ["text"],
			contextWindow: 64000,
			maxTokens: 12000,
		});
	});
});
