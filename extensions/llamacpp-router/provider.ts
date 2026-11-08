import type { ProviderConfig } from "@earendil-works/pi-coding-agent";
import { discoverProviderModels } from "./discovery.js";
import { persistableModels, providerApiKey, restoreModelConfigs } from "./models.js";
import { createLlamaCppStream } from "./stream.js";
import type { ServingTelemetryController } from "../shared/serving-telemetry.js";
import type { RouterRuntime } from "./types.js";

export function createRouterProviderConfig(
	runtime: RouterRuntime,
	telemetry: ServingTelemetryController,
): ProviderConfig {
	return {
		name: `llama.cpp (${runtime.router.name})`,
		baseUrl: runtime.apiBaseUrl,
		apiKey: providerApiKey(runtime),
		api: runtime.api,
		zdr: runtime.router.zdr,
		streamSimple: createLlamaCppStream(runtime, telemetry),
		headers: runtime.router.headers,
		refreshModels: async (context) => {
			const cached = restoreModelConfigs(runtime, context.stored?.models ?? []);
			if (!context.allowNetwork) return cached;
			if (context.credential?.type !== "api_key") return cached;

			const discovered = await discoverProviderModels(runtime, {
				apiKey: context.credential.key,
				signal: context.signal,
			});
			const published = await context.publish({
				persist: {
					models: persistableModels(runtime, discovered),
					checkedAt: Date.now(),
				},
			});
			return published ? discovered : cached;
		},
	};
}
