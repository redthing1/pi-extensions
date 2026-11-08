import { finiteNumber, isRecord, nonNegativeInteger } from "./guards.js";
import type { ServingTelemetryUpdate } from "../shared/serving-telemetry.js";
import type { LlamaPromptProgress, LlamaTimings } from "./types.js";

export interface LlamaChunkStats {
	progress?: LlamaPromptProgress;
	timings?: LlamaTimings;
	telemetry?: ServingTelemetryUpdate;
}

export function readLlamaChunkStats(chunk: Record<string, unknown>, lastProgress?: LlamaPromptProgress): LlamaChunkStats {
	const progress = parsePromptProgress(chunk.prompt_progress);
	const timings = parseTimings(chunk.timings);

	return {
		progress,
		timings,
		telemetry: progress ? telemetryFromProgress(progress) : timings ? telemetryFromTimings(timings, lastProgress) : undefined,
	};
}

export function parsePromptProgress(value: unknown): LlamaPromptProgress | undefined {
	if (!isRecord(value)) return undefined;
	return {
		total: nonNegativeInteger(value.total),
		cache: nonNegativeInteger(value.cache),
		processed: nonNegativeInteger(value.processed),
		timeMs: nonNegativeInteger(value.time_ms),
	};
}

export function parseTimings(value: unknown): LlamaTimings | undefined {
	if (!isRecord(value)) return undefined;
	return {
		cacheN: nonNegativeInteger(value.cache_n),
		promptN: nonNegativeInteger(value.prompt_n),
		promptMs: finiteNumber(value.prompt_ms),
		promptPerSecond: finiteNumber(value.prompt_per_second),
		predictedN: nonNegativeInteger(value.predicted_n),
		predictedMs: finiteNumber(value.predicted_ms),
		predictedPerSecond: finiteNumber(value.predicted_per_second),
	};
}

function telemetryFromProgress(progress: LlamaPromptProgress): ServingTelemetryUpdate {
	return {
		phase: "prefill",
		promptTotal: progress.total,
		promptProcessed: progress.processed,
		promptCached: progress.cache,
		prefillTokensPerSecond: progressRate(progress),
		elapsedMs: progress.timeMs,
	};
}

function telemetryFromTimings(
	timings: LlamaTimings,
	lastProgress: LlamaPromptProgress | undefined,
): ServingTelemetryUpdate {
	return {
		phase: timings.predictedN !== undefined && timings.predictedN > 0 ? "decode" : "prefill",
		promptTotal: lastProgress?.total ?? timings.promptN,
		promptProcessed: lastProgress?.processed ?? timings.promptN,
		promptCached: timings.cacheN ?? lastProgress?.cache,
		prefillTokensPerSecond: timings.promptPerSecond,
		outputTokens: timings.predictedN,
		decodeTokensPerSecond: timings.predictedPerSecond,
		elapsedMs: timings.predictedMs ?? timings.promptMs,
	};
}

function progressRate(progress: LlamaPromptProgress): number | undefined {
	if (progress.processed === undefined || progress.timeMs === undefined || progress.timeMs <= 0) return undefined;
	const cached = progress.cache ?? 0;
	const processedByPrefill = Math.max(0, progress.processed - cached);
	return processedByPrefill > 0 ? processedByPrefill / (progress.timeMs / 1000) : undefined;
}
