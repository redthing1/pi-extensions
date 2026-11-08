import type {
	Api,
	ChatTemplateKwargValue,
	Model,
	OpenAICompletionsCompat,
	ProviderId,
} from "@earendil-works/pi-ai";
import type { ServingTelemetrySettings } from "../shared/serving-telemetry.js";

export const LOCAL_PROVIDER_API_KEY = "llamacpp";
export const DEFAULT_DISCOVERY_TIMEOUT_MS = 5000;

export interface RouterConfig {
	name: string;
	url: string;
	apiKey?: string;
	headers?: Record<string, string>;
	zdr?: boolean;
	compat?: OpenAICompletionsCompat;
	models?: Record<string, ModelConfigOverride>;
	stats?: Partial<ServingTelemetrySettings>;
	request?: Partial<RequestConfig>;
	discoveryTimeoutMs?: number;
	requestTimeoutMs?: number;
	httpIdleTimeoutMs?: number;
	timeoutMs?: number;
}

export interface ModelConfigOverride {
	name?: string;
	zdr?: boolean;
	reasoning?: boolean;
	input?: ("text" | "image")[];
	maxTokens?: number;
	compat?: OpenAICompletionsCompat;
	thinkingLevelMap?: Model<Api>["thinkingLevelMap"];
}

export interface RequestConfig {
	returnProgress: boolean;
	timingsPerToken: boolean;
	includeUsage: boolean;
}

export interface RouterRuntime {
	router: RouterConfig;
	provider: ProviderId;
	api: Api;
	serverUrl: string;
	apiBaseUrl: string;
	request: RequestConfig;
	stats: ServingTelemetrySettings;
	discoveryTimeoutMs: number;
	requestTimeoutMs?: number;
	httpIdleTimeoutMs?: number;
}

export interface ModelListing {
	id: string;
}

export interface GenerationSettings {
	n_ctx?: unknown;
}

export interface PropsResponse {
	default_generation_settings?: GenerationSettings;
	chat_template_caps?: {
		supports_thinking?: unknown;
		supports_reasoning_effort?: unknown;
		reasoning_effort_levels?: unknown;
		supports_preserve_reasoning?: unknown;
	};
	modalities?: {
		vision?: unknown;
	};
}

export interface ChatTemplateInfo {
	supportsThinking?: boolean;
	supportsReasoningEffort?: boolean;
	reasoningEffortLevels?: string[];
	supportsPreserveReasoning?: boolean;
}

export interface SlotResponse {
	n_ctx?: unknown;
}

export interface LiveServerInfo {
	contextWindow: number;
	input: ("text" | "image")[];
	reasoning: boolean;
	template: ChatTemplateInfo;
}

export interface LlamaPromptProgress {
	total?: number;
	cache?: number;
	processed?: number;
	timeMs?: number;
}

export interface LlamaTimings {
	cacheN?: number;
	promptN?: number;
	promptMs?: number;
	promptPerSecond?: number;
	predictedN?: number;
	predictedMs?: number;
	predictedPerSecond?: number;
}

export interface ResolvedCompat {
	supportsReasoningEffort: boolean;
	supportsStrictMode: boolean;
	requiresToolResultName: boolean;
	requiresAssistantAfterToolResult: boolean;
	requiresThinkingAsText: boolean;
	requiresReasoningContentOnAssistantMessages: boolean;
	thinkingFormat: OpenAICompletionsCompat["thinkingFormat"];
	chatTemplateKwargs: Record<string, ChatTemplateKwargValue>;
	maxTokensField: "max_tokens" | "max_completion_tokens";
}
