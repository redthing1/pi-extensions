import type {
	FetchRequest,
	FetchResponse,
	ResolvedAgentSearchConfig,
	SearchRequest,
	SearchResponse,
} from "./types.ts";

const RESPONSE_LIMIT_BYTES = 512 * 1024;
const REQUEST_TIMEOUT_MS = 35_000;

export class AgentSearchClient {
	readonly #config: ResolvedAgentSearchConfig;

	constructor(config: ResolvedAgentSearchConfig) {
		this.#config = config;
	}

	async search(
		request: SearchRequest,
		signal?: AbortSignal,
	): Promise<SearchResponse> {
		const response = await this.#post("/v1/search", request, signal);
		return parseSearchResponse(response, request);
	}

	async fetch(
		request: FetchRequest,
		signal?: AbortSignal,
	): Promise<FetchResponse> {
		const response = await this.#post("/v1/fetch", request, signal);
		return parseFetchResponse(response);
	}

	async #post(
		path: string,
		payload: object,
		signal?: AbortSignal,
	): Promise<unknown> {
		const controller = new AbortController();
		const timeout = setTimeout(
			() => controller.abort(new Error("Search service request timed out")),
			REQUEST_TIMEOUT_MS,
		);
		const abort = () => controller.abort(signal?.reason);
		if (signal?.aborted) abort();
		else signal?.addEventListener("abort", abort, { once: true });
		try {
			let response: Response;
			try {
				response = await fetch(`${this.#config.baseUrl}${path}`, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${this.#config.token}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify(payload),
					redirect: "error",
					signal: controller.signal,
				});
			} catch (error) {
				if (signal?.aborted) throw error;
				if (controller.signal.aborted)
					throw new Error("Search service request timed out");
				throw new Error("Search service is unavailable");
			}
			const contentType = response.headers
				.get("content-type")
				?.split(";", 1)[0]
				?.trim()
				.toLowerCase();
			if (contentType !== "application/json")
				throw new Error("Search service returned a non-JSON response");
			const decoded = parseJson(await readBoundedText(response));
			if (!response.ok) throw bridgeResponseError(response.status, decoded);
			return decoded;
		} finally {
			clearTimeout(timeout);
			signal?.removeEventListener("abort", abort);
		}
	}
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		throw new Error("Search service returned malformed JSON");
	}
}

async function readBoundedText(response: Response): Promise<string> {
	if (!response.body) return "";
	const reader = response.body.getReader();
	const decoder = new TextDecoder("utf-8", { fatal: true });
	let received = 0;
	let text = "";
	try {
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) break;
			received += chunk.value.byteLength;
			if (received > RESPONSE_LIMIT_BYTES) {
				await reader.cancel();
				throw new Error("Search service response exceeded 512 KiB");
			}
			text += decoder.decode(chunk.value, { stream: true });
		}
		return text + decoder.decode();
	} finally {
		reader.releaseLock();
	}
}

function bridgeResponseError(status: number, value: unknown): Error {
	if (
		isRecord(value) &&
		isRecord(value.error) &&
		typeof value.error.code === "string" &&
		typeof value.error.message === "string"
	) {
		return new Error(
			`Search service error (${status}): ${value.error.message}`,
		);
	}
	return new Error(`Search service request failed with HTTP ${status}`);
}

function parseSearchResponse(
	value: unknown,
	request: SearchRequest,
): SearchResponse {
	if (
		!isRecord(value) ||
		!hasStrings(value, ["requestId", "source", "query", "searchedAt"]) ||
		!isPositiveInteger(value.requestedMaxResults) ||
		!isNonNegativeInteger(value.resultCount) ||
		!Array.isArray(value.results)
	) {
		throw new Error("Search service returned a malformed search response");
	}
	const expectedMaximum = request.maxResults ?? 8;
	const expectedSource = request.source ?? "web";
	if (
		value.query !== request.query.trim() ||
		value.source !== expectedSource ||
		(value.source !== "web" && value.source !== "wikipedia") ||
		value.requestedMaxResults !== expectedMaximum ||
		value.resultCount !== value.results.length ||
		value.results.length > expectedMaximum ||
		!value.results.every((result, index) => isSearchResult(result, index + 1))
	) {
		throw new Error("Search service returned malformed search results");
	}
	return {
		requestId: value.requestId,
		source: value.source,
		query: value.query,
		searchedAt: value.searchedAt,
		requestedMaxResults: value.requestedMaxResults,
		resultCount: value.resultCount,
		results: value.results,
	};
}

function parseFetchResponse(value: unknown): FetchResponse {
	if (
		!isRecord(value) ||
		!hasStrings(value, [
			"requestId",
			"requestedUrl",
			"finalUrl",
			"fetchedAt",
			"contentType",
			"text",
		]) ||
		!(value.title === null || typeof value.title === "string") ||
		!hasNonNegativeIntegers(value, ["offset", "returnedChars", "totalChars"]) ||
		typeof value.truncated !== "boolean" ||
		!(
			value.nextOffset === undefined || isNonNegativeInteger(value.nextOffset)
		) ||
		value.returnedChars !== value.text.length ||
		value.offset + value.returnedChars > value.totalChars ||
		(value.nextOffset !== undefined &&
			value.nextOffset !== value.offset + value.returnedChars)
	) {
		throw new Error("Search service returned a malformed fetch response");
	}
	return {
		requestId: value.requestId,
		requestedUrl: value.requestedUrl,
		finalUrl: value.finalUrl,
		fetchedAt: value.fetchedAt,
		title: value.title,
		contentType: value.contentType,
		text: value.text,
		offset: value.offset,
		returnedChars: value.returnedChars,
		totalChars: value.totalChars,
		truncated: value.truncated,
		...(value.nextOffset === undefined ? {} : { nextOffset: value.nextOffset }),
	};
}

function isSearchResult(
	value: unknown,
	expectedRank: number,
): value is SearchResponse["results"][number] {
	return (
		isRecord(value) &&
		value.rank === expectedRank &&
		hasStrings(value, ["title", "url", "snippet"]) &&
		value.title.length > 0 &&
		isPublicWebUrl(value.url)
	);
}

function hasStrings<T extends string>(
	value: Record<string, unknown>,
	keys: T[],
): value is Record<T, string> & Record<string, unknown> {
	return keys.every((key) => typeof value[key] === "string");
}

function hasNonNegativeIntegers<T extends string>(
	value: Record<string, unknown>,
	keys: T[],
): value is Record<T, number> & Record<string, unknown> {
	return keys.every((key) => isNonNegativeInteger(value[key]));
}

function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
	return isNonNegativeInteger(value) && value > 0;
}

function isPublicWebUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return (
			(url.protocol === "http:" || url.protocol === "https:") &&
			!url.username &&
			!url.password
		);
	} catch {
		return false;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
