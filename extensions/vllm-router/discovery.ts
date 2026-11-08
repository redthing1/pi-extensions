import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { RefreshModelsContext } from "@earendil-works/pi-ai";
import { parseVllmModelCatalog } from "./catalog.js";
import { configuredModels, discoveredModels } from "./models.js";
import type { VllmModelListing, VllmRuntime } from "./types.js";

export function createVllmModelRefresh(
	runtime: VllmRuntime,
): (context: RefreshModelsContext) => Promise<ProviderModelConfig[]> {
	let catalog: VllmModelListing[] | undefined;
	const currentModels = () => catalog
		? discoveredModels(runtime, structuredClone(catalog))
		: configuredModels(runtime);

	return async (context) => {
		if (!context.allowNetwork || context.credential?.type !== "api_key" || !context.credential.key) {
			return currentModels();
		}

		const signal = AbortSignal.any([context.signal, AbortSignal.timeout(runtime.discoveryTimeoutMs)]);
		const response = await fetch(`${runtime.apiBaseUrl}/models`, {
			headers: { Authorization: `Bearer ${context.credential.key}` },
			signal,
		});
		if (!response.ok) throw new Error(`vLLM model discovery failed with HTTP ${response.status}`);

		const listings = parseVllmModelCatalog(await response.json() as unknown);
		if (listings.length > 0) {
			// Keep only endpoint metadata, in memory. The runtime rejects stale
			// refresh publications; local overrides are applied on every read.
			await context.publish({ update: () => { catalog = listings; } });
		}
		return currentModels();
	};
}
