import { discoveryHeaders } from "./config.js";
import { isRecord, positiveInteger } from "./guards.js";
import { getJson, JsonRequestError } from "./http.js";
import { type ChatModelConfig, modelConfig } from "./models.js";
import { inferTemplateFeatures } from "./template-compat.js";
import type {
	ChatTemplateInfo,
	LiveServerInfo,
	ModelListing,
	PropsResponse,
	RouterRuntime,
	SlotResponse,
} from "./types.js";

interface ModelsResponse {
	data?: unknown;
}

const UNSUPPORTED_CAPABILITY_STATUSES = new Set([404, 501]);
const INITIAL_RETRY_DELAY_MS = 100;
const MAX_RETRY_DELAY_MS = 1000;

export async function discoverProviderModels(
	runtime: RouterRuntime,
	options: { apiKey?: string; signal: AbortSignal },
): Promise<ChatModelConfig[]> {
	let lastError: Error | undefined;
	const timeoutController = new AbortController();
	const timeout = setTimeout(
		() => timeoutController.abort(readinessTimeoutError(runtime, lastError)),
		runtime.discoveryTimeoutMs,
	);
	const signal = AbortSignal.any([options.signal, timeoutController.signal]);
	let retryDelayMs = INITIAL_RETRY_DELAY_MS;

	try {
		while (true) {
			try {
				return await discoverCatalog(runtime, options.apiKey, signal);
			} catch (error) {
				if (signal.aborted) throw asError(signal.reason);
				if (!(error instanceof JsonRequestError) || !error.retryable) throw error;
				lastError = asError(error);
				await delay(retryDelayMs, signal);
				retryDelayMs = Math.min(retryDelayMs * 2, MAX_RETRY_DELAY_MS);
			}
		}
	} finally {
		clearTimeout(timeout);
	}
}

async function discoverCatalog(
	runtime: RouterRuntime,
	apiKey: string | undefined,
	signal: AbortSignal,
): Promise<ChatModelConfig[]> {
	const headers = discoveryHeaders(runtime, apiKey);
	const listings = parseModelListings(await getJson<ModelsResponse>(`${runtime.apiBaseUrl}/models`, headers, signal));
	if (listings.length === 0) return [];

	const [propsResponse, slotsResponse] = await Promise.all([
		getCapabilityJson(`${runtime.serverUrl}/props`, headers, signal),
		getCapabilityJson(`${runtime.serverUrl}/slots`, headers, signal),
	]);
	const live = liveServerInfo(parseProps(propsResponse), parseSlots(slotsResponse));
	if (!live) throw new Error(`Provider "${runtime.provider}" did not report a valid context window`);

	return listings.map((listing) => modelConfig(runtime, listing, live));
}

async function getCapabilityJson(
	url: string,
	headers: Record<string, string> | undefined,
	signal: AbortSignal,
): Promise<unknown | undefined> {
	try {
		return await getJson<unknown>(url, headers, signal);
	} catch (error) {
		if (error instanceof JsonRequestError && UNSUPPORTED_CAPABILITY_STATUSES.has(error.status ?? -1)) return undefined;
		throw error;
	}
}

function readinessTimeoutError(runtime: RouterRuntime, lastError: Error | undefined): Error {
	const message = `Provider "${runtime.provider}" did not become ready within ${runtime.discoveryTimeoutMs}ms`;
	return lastError ? new Error(`${message}: ${lastError.message}`, { cause: lastError }) : new Error(message);
}

function parseModelListings(response: ModelsResponse): ModelListing[] {
	if (!Array.isArray(response.data)) throw new Error("llama.cpp /v1/models response did not contain a data array");
	return response.data.flatMap((entry): ModelListing[] => {
		if (!isRecord(entry) || typeof entry.id !== "string" || entry.id.length === 0) return [];
		return [{ id: entry.id }];
	});
}

function parseProps(value: unknown | undefined): PropsResponse | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) throw new Error("llama.cpp /props response was not an object");
	return value as PropsResponse;
}

function parseSlots(value: unknown | undefined): SlotResponse[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new Error("llama.cpp /slots response was not an array");
	return value.filter(isRecord) as SlotResponse[];
}

function delay(delayMs: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const finish = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", abort);
			resolve();
		};
		const abort = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", abort);
			reject(asError(signal.reason));
		};
		const timer = setTimeout(finish, delayMs);
		if (signal.aborted) abort();
		else signal.addEventListener("abort", abort, { once: true });
	});
}

function asError(value: unknown): Error {
	return value instanceof Error ? value : new Error(value === undefined ? "Request was aborted" : String(value));
}

function liveContextWindow(props: PropsResponse | undefined, slots: SlotResponse[]): number | undefined {
	const fromProps = positiveInteger(props?.default_generation_settings?.n_ctx);
	if (fromProps !== undefined) return fromProps;

	const slotContexts = slots.flatMap((slot) => {
		const context = positiveInteger(slot.n_ctx);
		return context === undefined ? [] : [context];
	});
	if (slotContexts.length === 0) return undefined;

	return Math.min(...slotContexts);
}

function liveInputTypes(props: PropsResponse | undefined): ("text" | "image")[] {
	return props?.modalities?.vision === true ? ["text", "image"] : ["text"];
}

function templateInfo(props: PropsResponse | undefined): ChatTemplateInfo {
	const levels = props?.chat_template_caps?.reasoning_effort_levels;
	return {
		supportsThinking: props?.chat_template_caps?.supports_thinking === true,
		supportsReasoningEffort: props?.chat_template_caps?.supports_reasoning_effort === true,
		reasoningEffortLevels: Array.isArray(levels)
			? levels.filter((level): level is string => typeof level === "string" && level.length > 0)
			: undefined,
		supportsPreserveReasoning: props?.chat_template_caps?.supports_preserve_reasoning === true,
	};
}

function liveServerInfo(props: PropsResponse | undefined, slots: SlotResponse[]): LiveServerInfo | undefined {
	const contextWindow = liveContextWindow(props, slots);
	if (contextWindow === undefined) return undefined;
	const template = templateInfo(props);

	return {
		contextWindow,
		input: liveInputTypes(props),
		reasoning: inferTemplateFeatures(template).supportsThinking,
		template,
	};
}
