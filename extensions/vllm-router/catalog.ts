import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { VllmModelListing } from "./types.js";

const THINKING_LEVELS: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

type ThinkingLevelMap = NonNullable<Model<Api>["thinkingLevelMap"]>;

/** Parse the conventional, endpoint-owned model metadata understood by this adapter. */
export function parseVllmModelCatalog(value: unknown): VllmModelListing[] {
	if (!isRecord(value) || !Array.isArray(value.data)) return [];
	return value.data.flatMap(parseModelListing);
}

function parseModelListing(value: unknown): VllmModelListing[] {
	if (!isRecord(value) || typeof value.id !== "string" || !value.id.trim()) return [];
	const input = parseInputModalities(value.architecture);
	const reasoning = parseReasoningCapability(value);
	return [
		{
			id: value.id,
			name: nonEmptyString(value.name),
			contextWindow: positiveInteger(value.max_model_len) ?? positiveInteger(value.context_length),
			maxTokens: positiveInteger(value.max_completion_tokens),
			input,
			reasoning,
		},
	];
}

function parseInputModalities(value: unknown): ("text" | "image")[] | undefined {
	if (!isRecord(value) || !Array.isArray(value.input_modalities)) return undefined;
	const supported = value.input_modalities.filter((entry): entry is "text" | "image" => entry === "text" || entry === "image");
	if (supported.length === 0) return undefined;
	return [...new Set(supported)];
}

function parseReasoningCapability(value: Record<string, unknown>): VllmModelListing["reasoning"] {
	if (!Array.isArray(value.supported_parameters) || !value.supported_parameters.includes("reasoning_effort")) {
		return undefined;
	}
	if (!Array.isArray(value.reasoning_options)) return undefined;

	const thinkingLevelMap = Object.fromEntries(THINKING_LEVELS.map((level) => [level, null])) as ThinkingLevelMap;
	let activeOptionCount = 0;
	for (const option of value.reasoning_options) {
		if (typeof option !== "string") continue;
		const level = reasoningOptionToThinkingLevel(option);
		if (!level || thinkingLevelMap[level] !== null) continue;
		thinkingLevelMap[level] = option;
		if (level !== "off") activeOptionCount += 1;
	}
	if (activeOptionCount === 0) return undefined;

	const advertisedDefault = isRecord(value.default_parameters) ? value.default_parameters.reasoning_effort : undefined;
	const defaultThinkingLevel = typeof advertisedDefault === "string" ? reasoningOptionToThinkingLevel(advertisedDefault) : undefined;
	const defaultIsSupported = defaultThinkingLevel !== undefined && thinkingLevelMap[defaultThinkingLevel] === advertisedDefault;

	return {
		thinkingLevelMap,
		defaultThinkingLevel: defaultIsSupported ? defaultThinkingLevel : undefined,
	};
}

function reasoningOptionToThinkingLevel(value: string): ModelThinkingLevel | undefined {
	const normalized = value.trim().toLowerCase();
	if (normalized === "none") return "off";
	return THINKING_LEVELS.find((level) => level === normalized);
}

function positiveInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
