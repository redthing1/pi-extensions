import type { ToolEffectAnalysis, ToolEffectAnalyzer } from "../shared/tool-effects.ts";

export const AGENT_SEARCH_TOOLS = [
	{ name: "web_search", effects: ["network"] as const },
	{ name: "web_fetch", effects: ["network"] as const },
] as const;

export function createAgentSearchEffectAnalyzer(toolName: "web_search" | "web_fetch"): ToolEffectAnalyzer {
	return {
		toolName,
		analyze(input) {
			return analyzeAgentSearchTool(toolName, input);
		},
	};
}

export function analyzeAgentSearchTool(
	toolName: "web_search" | "web_fetch",
	input?: Record<string, unknown>,
): ToolEffectAnalysis {
	if (toolName === "web_search") {
		const query = compactText(input?.query);
		const corpus = input?.source === "wikipedia" ? "Wikipedia" : "web";
		return {
			toolName,
			summary: query ? `Search ${corpus}: ${query}` : `Search ${corpus}`,
			effects: ["network"],
			risk: "unknown",
			pathInputs: [],
			known: true,
			reason: "web search requires network access",
		};
	}
	return {
		toolName,
		summary: fetchSummary(input?.url),
		effects: ["network"],
		risk: "unknown",
		pathInputs: [],
		known: true,
		reason: "web fetch requires network access",
	};
}

function fetchSummary(value: unknown): string {
	if (typeof value !== "string") return "Fetch public web page";
	try {
		const url = new URL(value);
		if (url.protocol !== "http:" && url.protocol !== "https:") return "Fetch public web page";
		const path = url.pathname === "/" ? "" : url.pathname;
		return `Fetch ${truncate(`${url.protocol}//${url.host}${path}`)}`;
	} catch {
		return "Fetch public web page";
	}
}

function compactText(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const compact = value.replace(/\s+/gu, " ").trim();
	return compact ? truncate(compact) : undefined;
}

function truncate(value: string): string {
	return value.length <= 160 ? value : `${value.slice(0, 157)}...`;
}
