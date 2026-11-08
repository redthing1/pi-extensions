import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { OpenAICompletionsCompat } from "@earendil-works/pi-ai";
import type { VllmModelListing, VllmModelOverride, VllmRuntime } from "./types.js";

const DEFAULT_CONTEXT_WINDOW = 128000;

const VLLM_COMPAT: OpenAICompletionsCompat = {
	supportsStore: false,
	supportsDeveloperRole: false,
	supportsReasoningEffort: false,
	supportsUsageInStreaming: true,
	supportsFinishReason: true,
	maxTokensField: "max_tokens",
	requiresToolResultName: false,
	requiresAssistantAfterToolResult: false,
	requiresThinkingAsText: false,
	requiresReasoningContentOnAssistantMessages: false,
	thinkingFormat: "openai",
	supportsThinkingTokenBudget: false,
	supportsOpenAIGrammarTools: false,
	supportsStrictMode: true,
	sendSessionAffinityHeaders: false,
	supportsLongCacheRetention: false,
};

export function configuredModels(runtime: VllmRuntime): ProviderModelConfig[] {
	return Object.entries(runtime.router.models ?? {}).map(([id, override]) => modelConfig(runtime, { id }, override));
}

export function discoveredModels(runtime: VllmRuntime, listings: VllmModelListing[]): ProviderModelConfig[] {
	return listings.map((listing) => modelConfig(runtime, listing, runtime.router.models?.[listing.id]));
}

function modelConfig(
	runtime: VllmRuntime,
	listing: VllmModelListing,
	override: VllmModelOverride | undefined,
): ProviderModelConfig {
	const contextWindow = override?.contextWindow ?? listing.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
	const reasoning = override?.reasoning ?? listing.reasoning !== undefined;
	const advertisedMap = reasoning ? listing.reasoning?.thinkingLevelMap : undefined;
	const thinkingLevelMap = override?.thinkingLevelMap
		? { ...advertisedMap, ...override.thinkingLevelMap }
		: advertisedMap;
	const defaultThinkingLevel = override?.defaultThinkingLevel ?? listing.reasoning?.defaultThinkingLevel;
	return {
		id: listing.id,
		name: override?.name ?? listing.name ?? `${listing.id} @ ${runtime.router.name}`,
		zdr: override?.zdr ?? runtime.router.zdr,
		reasoning,
		defaultThinkingLevel:
			reasoning && defaultThinkingLevel !== undefined && thinkingLevelIsSupported(defaultThinkingLevel, thinkingLevelMap)
				? defaultThinkingLevel
				: undefined,
		thinkingLevelMap: reasoning ? thinkingLevelMap : undefined,
		input: override?.input ?? listing.input ?? ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens: Math.min(override?.maxTokens ?? listing.maxTokens ?? contextWindow, contextWindow),
		compat: {
			...VLLM_COMPAT,
			...(reasoning ? { supportsReasoningEffort: true } : {}),
			...override?.compat,
		},
	};
}

function thinkingLevelIsSupported(
	level: NonNullable<VllmModelOverride["defaultThinkingLevel"]>,
	map: VllmModelOverride["thinkingLevelMap"],
): boolean {
	if (map?.[level] === null) return false;
	return (level !== "xhigh" && level !== "max") || map?.[level] !== undefined;
}
