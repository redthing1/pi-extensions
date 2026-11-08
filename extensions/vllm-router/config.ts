import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
	DEFAULT_SERVING_TELEMETRY_SETTINGS,
	type ServingTelemetrySettings,
} from "../shared/serving-telemetry.js";
import {
	DEFAULT_DISCOVERY_TIMEOUT_MS,
	type VllmModelOverride,
	type VllmRouterConfig,
	type VllmRuntime,
} from "./types.js";

const SETTINGS_PATH = resolve(homedir(), ".pi/agent/settings.json");
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export function loadVllmRouters(): VllmRouterConfig[] {
	try {
		const parsed = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8")) as unknown;
		if (!isRecord(parsed) || !Array.isArray(parsed.vllmRouters)) return [];
		return parsed.vllmRouters.flatMap(parseRouter);
	} catch {
		return [];
	}
}

export function createRuntime(router: VllmRouterConfig): VllmRuntime {
	const serverUrl = router.url.replace(/\/+$/u, "");
	return {
		router,
		provider: `vllm-${router.name}`,
		serverUrl,
		apiBaseUrl: serverUrl.endsWith("/v1") ? serverUrl : `${serverUrl}/v1`,
		stats: { ...DEFAULT_SERVING_TELEMETRY_SETTINGS, ...router.stats },
		discoveryTimeoutMs: router.discoveryTimeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS,
	};
}

function parseRouter(value: unknown): VllmRouterConfig[] {
	if (!isRecord(value) || typeof value.name !== "string" || typeof value.url !== "string") return [];
	const name = value.name.trim();
	const url = value.url.trim();
	if (!/^[a-z0-9][a-z0-9._-]*$/u.test(name) || !url) return [];

	return [{
		name,
		url,
		zdr: typeof value.zdr === "boolean" ? value.zdr : undefined,
		stats: parseStats(value.stats),
		discoveryTimeoutMs: positiveInteger(value.discoveryTimeoutMs),
		models: parseModels(value.models),
	}];
}

function parseStats(value: unknown): Partial<ServingTelemetrySettings> | undefined {
	if (!isRecord(value)) return undefined;
	const enabled = typeof value.enabled === "boolean" ? value.enabled : undefined;
	const minIntervalMs = positiveInteger(value.minIntervalMs);
	if (enabled === undefined && minIntervalMs === undefined) return undefined;
	return {
		...(enabled === undefined ? {} : { enabled }),
		...(minIntervalMs === undefined ? {} : { minIntervalMs }),
	};
}

function parseModels(value: unknown): Record<string, VllmModelOverride> | undefined {
	if (!isRecord(value)) return undefined;
	const models: Record<string, VllmModelOverride> = {};
	for (const [id, raw] of Object.entries(value)) {
		if (!id || !isRecord(raw)) continue;
		const input = Array.isArray(raw.input) && raw.input.every((entry) => entry === "text" || entry === "image")
			? raw.input as ("text" | "image")[]
			: undefined;
		models[id] = {
			name: typeof raw.name === "string" ? raw.name : undefined,
			zdr: typeof raw.zdr === "boolean" ? raw.zdr : undefined,
			reasoning: typeof raw.reasoning === "boolean" ? raw.reasoning : undefined,
			defaultThinkingLevel: parseThinkingLevel(raw.defaultThinkingLevel),
			input,
			contextWindow: positiveInteger(raw.contextWindow),
			maxTokens: positiveInteger(raw.maxTokens),
			thinkingLevelMap: parseThinkingLevelMap(raw.thinkingLevelMap),
			compat: isRecord(raw.compat) ? raw.compat as VllmModelOverride["compat"] : undefined,
		};
	}
	return Object.keys(models).length > 0 ? models : undefined;
}

function parseThinkingLevelMap(value: unknown): VllmModelOverride["thinkingLevelMap"] {
	if (!isRecord(value)) return undefined;
	const map: NonNullable<VllmModelOverride["thinkingLevelMap"]> = {};
	for (const level of THINKING_LEVELS) {
		const mapped = value[level];
		if (typeof mapped === "string" || mapped === null) map[level] = mapped;
	}
	return Object.keys(map).length > 0 ? map : undefined;
}

function parseThinkingLevel(value: unknown): VllmModelOverride["defaultThinkingLevel"] {
	return THINKING_LEVELS.find((level) => level === value);
}

function positiveInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
