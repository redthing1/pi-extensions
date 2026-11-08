import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { type AnyModel, type Api, isModelType, type Model } from "@earendil-works/pi-ai";
import { openAICompat } from "./config.js";
import { isInputArray, positiveInteger } from "./guards.js";
import { chatTemplateThinkingKwargs, inferTemplateFeatures, thinkingLevelMapForTemplate } from "./template-compat.js";
import { LOCAL_PROVIDER_API_KEY, type LiveServerInfo, type ModelListing, type RouterRuntime } from "./types.js";

export type ChatModelConfig = Extract<ProviderModelConfig, { type?: "chat" }>;

export function modelConfig(
	runtime: RouterRuntime,
	listing: ModelListing,
	live: LiveServerInfo,
	persisted?: Pick<Model<Api>, "thinkingLevelMap">,
): ChatModelConfig {
	const override = runtime.router.models?.[listing.id];
	const compat = openAICompat(runtime.router, override);
	const templateFeatures = inferTemplateFeatures(live.template);
	const reasoning = override?.reasoning ?? (live.reasoning || templateFeatures.supportsThinking);
	const thinkingLevelMap =
		override?.thinkingLevelMap ?? thinkingLevelMapForTemplate(templateFeatures) ?? persisted?.thinkingLevelMap;
	const hasExplicitThinkingFormat =
		runtime.router.compat?.thinkingFormat !== undefined || override?.compat?.thinkingFormat !== undefined;
	if (reasoning && !hasExplicitThinkingFormat) {
		compat.thinkingFormat = "chat-template";
		compat.chatTemplateKwargs = {
			...chatTemplateThinkingKwargs(templateFeatures),
			...compat.chatTemplateKwargs,
		};
	}
	return {
		id: listing.id,
		name: override?.name ?? `${listing.id} @ ${runtime.router.name}`,
		api: runtime.api,
		zdr: override?.zdr ?? runtime.router.zdr,
		reasoning,
		thinkingLevelMap,
		input: override?.input ?? live.input,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: live.contextWindow,
		maxTokens: Math.min(override?.maxTokens ?? live.contextWindow, live.contextWindow),
		compat,
	};
}

export function restoreModelConfigs(runtime: RouterRuntime, models: readonly AnyModel[]): ChatModelConfig[] {
	return models.flatMap((model): ChatModelConfig[] => {
		if (!isModelType(model, "chat") || model.provider !== runtime.provider || typeof model.id !== "string" || model.id.length === 0) return [];
		const contextWindow = positiveInteger(model.contextWindow);
		if (contextWindow === undefined || !isInputArray(model.input)) return [];

		return [
			modelConfig(
				runtime,
				{ id: model.id },
				{
					contextWindow,
					input: model.input,
					reasoning: model.reasoning === true,
					template: {},
				},
				model,
			),
		];
	});
}

export function persistableModels(runtime: RouterRuntime, models: readonly ChatModelConfig[]): Model<Api>[] {
	return models.map((model) => ({
		...model,
		provider: runtime.provider,
		api: model.api ?? runtime.api,
		baseUrl: runtime.apiBaseUrl,
	}));
}

export function providerApiKey(runtime: RouterRuntime): string {
	return runtime.router.apiKey ?? LOCAL_PROVIDER_API_KEY;
}
