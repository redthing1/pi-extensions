export interface ResolvedAgentSearchConfig {
	baseUrl: string;
	token: string;
}

export interface SearchRequest {
	query: string;
	maxResults?: number;
	source?: "web" | "wikipedia";
	site?: string;
	timeRange?: "day" | "week" | "month" | "year";
}

export interface SearchResult {
	rank: number;
	title: string;
	url: string;
	snippet: string;
}

export interface SearchResponse {
	requestId: string;
	source: "web" | "wikipedia";
	query: string;
	searchedAt: string;
	requestedMaxResults: number;
	resultCount: number;
	results: SearchResult[];
}

export interface FetchRequest {
	url: string;
	offset?: number;
	maxChars?: number;
}

export interface FetchResponse {
	requestId: string;
	requestedUrl: string;
	finalUrl: string;
	fetchedAt: string;
	title: string | null;
	contentType: string;
	text: string;
	offset: number;
	returnedChars: number;
	totalChars: number;
	truncated: boolean;
	nextOffset?: number;
}
