import type { FetchResponse, SearchResponse } from "./types.ts";

const MODEL_OUTPUT_LIMIT_BYTES = 50 * 1024;

export function renderSearch(response: SearchResponse): string {
	const label =
		response.source === "wikipedia" ? "Wikipedia results" : "Web results";
	const lines = [`${label} (${response.resultCount}) for: ${response.query}`];
	for (const result of response.results) {
		lines.push("", `${result.rank}. ${result.title}`, `   ${result.url}`);
		if (result.snippet) lines.push(`   ${result.snippet}`);
	}
	if (response.results.length === 0) lines.push("", "No results found.");
	return truncateUtf8(lines.join("\n"));
}

export function renderFetch(response: FetchResponse): string {
	const metadata = [
		`Source: ${response.finalUrl}`,
		...(response.title ? [`Title: ${response.title}`] : []),
		`Characters: ${response.offset}-${response.offset + response.returnedChars} of ${response.totalChars}`,
		...(response.nextOffset === undefined
			? []
			: [`Next offset: ${response.nextOffset}`]),
		"",
	].join("\n");
	return truncateUtf8(metadata + response.text);
}

function truncateUtf8(value: string): string {
	const encoded = new TextEncoder().encode(value);
	if (encoded.byteLength <= MODEL_OUTPUT_LIMIT_BYTES) return value;
	const suffix = "\n[output truncated by AgentSearch client]";
	const suffixBytes = new TextEncoder().encode(suffix).byteLength;
	const prefix = encoded.slice(0, MODEL_OUTPUT_LIMIT_BYTES - suffixBytes);
	return new TextDecoder("utf-8", { fatal: false }).decode(prefix) + suffix;
}
