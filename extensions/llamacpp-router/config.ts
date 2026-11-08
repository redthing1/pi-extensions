import type { Api, Model, OpenAICompletionsCompat } from "@earendil-works/pi-ai";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
	DEFAULT_SERVING_TELEMETRY_SETTINGS,
	type ServingTelemetrySettings,
} from "../shared/serving-telemetry.js";
import {
	isInputArray,
	isRecord,
	isStringRecord,
	nonNegativeInteger,
	positiveInteger,
	readBoolean,
	readPositiveInteger,
} from "./guards.js";
import {
	DEFAULT_DISCOVERY_TIMEOUT_MS,
	type ModelConfigOverride,
	type RequestConfig,
	type RouterConfig,
	type RouterRuntime,
} from "./types.js";

const SETTINGS_PATH = resolve(homedir(), ".pi/agent/settings.json");

const DEFAULT_REQUEST: RequestConfig = {
	returnProgress: true,
	timingsPerToken: true,
	includeUsage: true,
};

export function loadRouters(): RouterConfig[] {
	try {
		const parsed = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8")) as unknown;
		if (!isRecord(parsed) || !Array.isArray(parsed.llamacppRouters)) return [];
		return parsed.llamacppRouters.flatMap(parseRouterConfig);
	} catch {
		return [];
	}
}

export function createRuntime(router: RouterConfig): RouterRuntime {
	const provider = providerName(router);
	return {
		router,
		provider,
		api: apiName(provider),
		serverUrl: stripTrailingSlash(router.url),
		apiBaseUrl: `${stripTrailingSlash(router.url)}/v1`,
		request: { ...DEFAULT_REQUEST, ...router.request },
		stats: { ...DEFAULT_SERVING_TELEMETRY_SETTINGS, ...router.stats },
		discoveryTimeoutMs: router.discoveryTimeoutMs ?? router.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS,
		requestTimeoutMs: router.requestTimeoutMs,
		httpIdleTimeoutMs: router.httpIdleTimeoutMs,
	};
}

export function providerName(router: RouterConfig): string {
	return `llamacpp-${router.name}`;
}

export function resolveHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
	if (!headers) return undefined;
	const resolved = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, process.env[value] ?? value]));
	return Object.keys(resolved).length > 0 ? resolved : undefined;
}

export function discoveryHeaders(runtime: RouterRuntime, apiKey: string | undefined): Record<string, string> | undefined {
	const headers = resolveHeaders(runtime.router.headers);
	return apiKey ? { ...headers, Authorization: `Bearer ${apiKey}` } : headers;
}

export function openAICompat(
	router: RouterConfig,
	override: ModelConfigOverride | undefined,
): OpenAICompletionsCompat {
	return {
		supportsStore: false,
		supportsDeveloperRole: false,
		supportsReasoningEffort: false,
		supportsUsageInStreaming: true,
		maxTokensField: "max_tokens",
		requiresToolResultName: false,
		requiresAssistantAfterToolResult: false,
		requiresThinkingAsText: false,
		requiresReasoningContentOnAssistantMessages: false,
		thinkingFormat: "openai",
		sendSessionAffinityHeaders: false,
		supportsStrictMode: false,
		...router.compat,
		...override?.compat,
	};
}

function parseRouterConfig(value: unknown): RouterConfig[] {
	if (!isRecord(value)) return [];
	if (typeof value.name !== "string" || typeof value.url !== "string") return [];
	if (value.apiKey !== undefined && typeof value.apiKey !== "string") return [];
	if (value.headers !== undefined && !isStringRecord(value.headers)) return [];
	if (value.compat !== undefined && !isRecord(value.compat)) return [];
	if (value.models !== undefined && !isRecord(value.models)) return [];

	const discoveryTimeoutMs = positiveInteger(value.discoveryTimeoutMs);
	const requestTimeoutMs = nonNegativeInteger(value.requestTimeoutMs);
	const httpIdleTimeoutMs = nonNegativeInteger(value.httpIdleTimeoutMs);
	const timeoutMs = positiveInteger(value.timeoutMs);

	return [
		{
			name: value.name,
			url: value.url,
			apiKey: value.apiKey,
			headers: value.headers,
			zdr: readBoolean(value, "zdr"),
			compat: value.compat as OpenAICompletionsCompat | undefined,
			models: parseModelOverrides(value.models),
			stats: parseStatsConfig(value.stats),
			request: parseRequestConfig(value.request),
			discoveryTimeoutMs,
			requestTimeoutMs,
			httpIdleTimeoutMs,
			timeoutMs,
		},
	];
}

function parseModelOverrides(value: unknown): Record<string, ModelConfigOverride> | undefined {
	if (!isRecord(value)) return undefined;

	const overrides: Record<string, ModelConfigOverride> = {};
	for (const [id, rawOverride] of Object.entries(value)) {
		if (!isRecord(rawOverride)) continue;

		const override: ModelConfigOverride = {};
		if (typeof rawOverride.name === "string") override.name = rawOverride.name;
		override.zdr = readBoolean(rawOverride, "zdr");
		if (typeof rawOverride.reasoning === "boolean") override.reasoning = rawOverride.reasoning;
		if (isInputArray(rawOverride.input)) override.input = rawOverride.input;
		const maxTokens = positiveInteger(rawOverride.maxTokens);
		if (maxTokens !== undefined) override.maxTokens = maxTokens;
		if (isRecord(rawOverride.compat)) override.compat = rawOverride.compat as OpenAICompletionsCompat;
		if (isRecord(rawOverride.thinkingLevelMap)) {
			override.thinkingLevelMap = rawOverride.thinkingLevelMap as Model<Api>["thinkingLevelMap"];
		}

		overrides[id] = override;
	}

	return Object.keys(overrides).length > 0 ? overrides : undefined;
}

function parseStatsConfig(value: unknown): Partial<ServingTelemetrySettings> | undefined {
	if (!isRecord(value)) return undefined;
	const config: Partial<ServingTelemetrySettings> = {};
	config.enabled = readBoolean(value, "enabled");
	config.minIntervalMs = readPositiveInteger(value, "minIntervalMs");
	return stripUndefined(config);
}

function parseRequestConfig(value: unknown): Partial<RequestConfig> | undefined {
	if (!isRecord(value)) return undefined;
	const config: Partial<RequestConfig> = {};
	config.returnProgress = readBoolean(value, "returnProgress");
	config.timingsPerToken = readBoolean(value, "timingsPerToken");
	config.includeUsage = readBoolean(value, "includeUsage");
	return stripUndefined(config);
}

function stripUndefined<T extends Record<string, unknown>>(value: T): Partial<T> | undefined {
	const entries = Object.entries(value).filter(([, entry]) => entry !== undefined);
	return entries.length > 0 ? (Object.fromEntries(entries) as Partial<T>) : undefined;
}

function stripTrailingSlash(value: string): string {
	return value.replace(/\/+$/, "");
}

function apiName(provider: string): string {
	return `llamacpp-router:${provider}`;
}
