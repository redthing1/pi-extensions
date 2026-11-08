import type { Api, Model, ModelThinkingLevel, OpenAICompletionsCompat } from "@earendil-works/pi-ai";
import type { ServingTelemetrySettings } from "../shared/serving-telemetry.js";

export const DEFAULT_DISCOVERY_TIMEOUT_MS = 5000;

export interface VllmRouterConfig {
	name: string;
	url: string;
	zdr?: boolean;
	stats?: Partial<ServingTelemetrySettings>;
	discoveryTimeoutMs?: number;
	models?: Record<string, VllmModelOverride>;
}

export interface VllmModelOverride {
	name?: string;
	zdr?: boolean;
	reasoning?: boolean;
	defaultThinkingLevel?: ModelThinkingLevel;
	input?: ("text" | "image")[];
	contextWindow?: number;
	maxTokens?: number;
	thinkingLevelMap?: Model<Api>["thinkingLevelMap"];
	compat?: OpenAICompletionsCompat;
}

export interface VllmRuntime {
	router: VllmRouterConfig;
	provider: string;
	serverUrl: string;
	apiBaseUrl: string;
	stats: ServingTelemetrySettings;
	discoveryTimeoutMs: number;
}

export interface VllmModelListing {
	id: string;
	name?: string;
	contextWindow?: number;
	maxTokens?: number;
	input?: ("text" | "image")[];
	reasoning?: {
		thinkingLevelMap: NonNullable<Model<Api>["thinkingLevelMap"]>;
		defaultThinkingLevel?: ModelThinkingLevel;
	};
}
