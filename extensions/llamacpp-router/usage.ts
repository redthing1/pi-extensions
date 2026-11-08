import { calculateCost, type Api, type Model, type Usage } from "@earendil-works/pi-ai";
import { isRecord } from "./guards.js";
import type { LlamaPromptProgress, LlamaTimings } from "./types.js";

export function zeroUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

export function isZeroUsage(usage: Usage): boolean {
	return (
		usage.totalTokens === 0 &&
		usage.input === 0 &&
		usage.output === 0 &&
		usage.cacheRead === 0 &&
		usage.cacheWrite === 0
	);
}

export function parseUsage(raw: unknown, model: Model<Api>): Usage {
	if (!isRecord(raw)) return zeroUsage();
	const promptTokens = numberOrZero(raw.prompt_tokens);
	const completionTokens = numberOrZero(raw.completion_tokens);
	const promptDetails = isRecord(raw.prompt_tokens_details) ? raw.prompt_tokens_details : undefined;
	const reportedCachedTokens = numberOrZero(promptDetails?.cached_tokens ?? raw.prompt_cache_hit_tokens);
	const cacheWriteTokens = numberOrZero(promptDetails?.cache_write_tokens);
	const cacheReadTokens =
		cacheWriteTokens > 0 ? Math.max(0, reportedCachedTokens - cacheWriteTokens) : reportedCachedTokens;
	const input = Math.max(0, promptTokens - cacheReadTokens - cacheWriteTokens);
	const usage: Usage = {
		input,
		output: completionTokens,
		cacheRead: cacheReadTokens,
		cacheWrite: cacheWriteTokens,
		totalTokens: input + completionTokens + cacheReadTokens + cacheWriteTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	calculateCost(model, usage);
	return usage;
}

export function usageFromLlamaTimings(
	model: Model<Api>,
	progress: LlamaPromptProgress | undefined,
	timings: LlamaTimings | undefined,
): Usage {
	const cacheRead = Math.max(0, timings?.cacheN ?? progress?.cache ?? 0);
	const promptTotal = Math.max(0, progress?.total ?? timings?.promptN ?? 0);
	const output = Math.max(0, timings?.predictedN ?? 0);
	const input = Math.max(0, promptTotal - cacheRead);
	const usage: Usage = {
		input,
		output,
		cacheRead,
		cacheWrite: 0,
		totalTokens: input + output + cacheRead,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	calculateCost(model, usage);
	return usage;
}

function numberOrZero(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}
