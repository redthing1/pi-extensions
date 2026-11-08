import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

const RETRYABLE_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

export async function getJson<T>(
	url: string,
	headers: Record<string, string> | undefined,
	signal: AbortSignal,
): Promise<T> {
	let response: Response;
	try {
		response = await fetch(url, { signal, headers });
	} catch (error) {
		if (signal.aborted) throw abortError(signal.reason);
		throw new JsonRequestError(`Could not connect to ${url}`, true, undefined, { cause: error });
	}

	if (!response.ok) {
		throw new JsonRequestError(
			`llama.cpp discovery request failed with HTTP ${response.status}: ${url}`,
			isRetryableStatus(response.status),
			response.status,
		);
	}

	try {
		return (await response.json()) as T;
	} catch (error) {
		throw new JsonRequestError(`llama.cpp discovery returned invalid JSON: ${url}`, false, response.status, {
			cause: error,
		});
	}
}

export class JsonRequestError extends Error {
	readonly retryable: boolean;
	readonly status: number | undefined;

	constructor(message: string, retryable: boolean, status?: number, options?: ErrorOptions) {
		super(message, options);
		this.name = "JsonRequestError";
		this.retryable = retryable;
		this.status = status;
	}
}

function isRetryableStatus(status: number): boolean {
	return RETRYABLE_HTTP_STATUSES.has(status);
}

export async function responseErrorMessage(response: Response): Promise<string> {
	const base = `llama.cpp request failed with HTTP ${response.status}`;
	try {
		const text = await response.text();
		const trimmed = text.trim();
		return trimmed.length > 0 ? `${base}: ${trimmed.slice(0, 500)}` : base;
	} catch {
		return base;
	}
}

export function postJsonWithIdleTimeout(
	url: string,
	headers: Record<string, string>,
	body: string,
	signal: AbortSignal | undefined,
	idleTimeoutMs: number | undefined,
): Promise<Response> {
	if (idleTimeoutMs === undefined) {
		return fetch(url, { method: "POST", headers, body, signal });
	}

	return sendJsonRequest(url, headers, body, signal, idleTimeoutMs).then((response) =>
		responseToFetchResponse(response, signal, idleTimeoutMs),
	);
}

function sendJsonRequest(
	url: string,
	headers: Record<string, string>,
	body: string,
	signal: AbortSignal | undefined,
	idleTimeoutMs: number,
): Promise<import("node:http").IncomingMessage> {
	const target = new URL(url);
	const request = (target.protocol === "https:" ? httpsRequest : httpRequest)(target, {
		method: "POST",
		headers,
	});

	return new Promise((resolve, reject) => {
		let settled = false;
		const watchdog = createIdleWatchdog(idleTimeoutMs, () => {
			fail(new Error(`llama.cpp request idle timeout after ${idleTimeoutMs} ms`));
		});
		const abort = () => fail(abortError(signal?.reason));
		const cleanup = () => {
			watchdog.stop();
			signal?.removeEventListener("abort", abort);
		};
		const fail = (error: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			request.destroy(error);
			reject(error);
		};

		request.once("error", (error) => fail(asError(error)));
		request.once("response", (response) => {
			if (settled) {
				response.destroy();
				return;
			}
			settled = true;
			cleanup();
			resolve(response);
		});
		if (signal?.aborted) abort();
		else signal?.addEventListener("abort", abort, { once: true });

		request.end(body);
		watchdog.reset();
	});
}

function responseToFetchResponse(
	response: import("node:http").IncomingMessage,
	signal: AbortSignal | undefined,
	idleTimeoutMs: number,
): Response {
	let cancelResponse: () => void = () => {
		response.destroy();
	};
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			let closed = false;
			const watchdog = createIdleWatchdog(idleTimeoutMs, () => {
				fail(new Error(`llama.cpp response idle timeout after ${idleTimeoutMs} ms`));
			});
			const abort = () => fail(abortError(signal?.reason));
			const cleanup = () => {
				watchdog.stop();
				signal?.removeEventListener("abort", abort);
			};
			const fail = (error: Error) => {
				if (closed) return;
				closed = true;
				cleanup();
				response.destroy(error);
				controller.error(error);
			};
			const finish = () => {
				if (closed) return;
				closed = true;
				cleanup();
				controller.close();
			};
			cancelResponse = () => {
				if (closed) return;
				closed = true;
				cleanup();
				response.destroy();
			};
			response.on("data", (chunk: Uint8Array) => {
				if (closed) return;
				watchdog.reset();
				controller.enqueue(chunk);
			});
			response.once("end", finish);
			response.once("error", (error) => fail(asError(error)));
			response.once("close", () => {
				if (!response.complete) fail(new Error("llama.cpp response closed before completion"));
			});
			if (signal?.aborted) abort();
			else signal?.addEventListener("abort", abort, { once: true });
			watchdog.reset();
		},
		cancel() {
			cancelResponse();
		},
	});

	const headers = new Headers();
	for (const [name, value] of Object.entries(response.headers)) {
		if (Array.isArray(value)) {
			for (const item of value) headers.append(name, item);
		} else if (value !== undefined) {
			headers.append(name, String(value));
		}
	}
	return new Response(body, {
		status: response.statusCode ?? 500,
		statusText: response.statusMessage,
		headers,
	});
}

function createIdleWatchdog(timeoutMs: number, onTimeout: () => void): {
	reset(): void;
	stop(): void;
} {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return {
		reset() {
			if (timeoutMs === 0) return;
			if (timer) clearTimeout(timer);
			timer = setTimeout(onTimeout, timeoutMs);
		},
		stop() {
			if (timer) clearTimeout(timer);
		},
	};
}

function asError(value: unknown): Error {
	return value instanceof Error ? value : new Error(String(value));
}

function abortError(reason: unknown): Error {
	return reason instanceof Error ? reason : new Error("Request was aborted");
}

export function withAbortTimeout(
	signal: AbortSignal | undefined,
	timeoutMs: number | undefined,
): { signal?: AbortSignal; cleanup(): void } {
	const effectiveTimeoutMs = timeoutMs !== undefined && timeoutMs > 0 ? timeoutMs : undefined;
	if (!signal && effectiveTimeoutMs === undefined) return { cleanup: () => {} };

	const controller = new AbortController();
	let timeout: ReturnType<typeof setTimeout> | undefined;
	const abort = () => controller.abort(signal?.reason);

	if (signal) {
		if (signal.aborted) {
			controller.abort(signal.reason);
		} else {
			signal.addEventListener("abort", abort, { once: true });
		}
	}

	if (effectiveTimeoutMs !== undefined) {
		timeout = setTimeout(
			() => controller.abort(new Error(`Request timed out after ${effectiveTimeoutMs} ms`)),
			effectiveTimeoutMs,
		);
	}

	return {
		signal: controller.signal,
		cleanup: () => {
			if (timeout) clearTimeout(timeout);
			signal?.removeEventListener("abort", abort);
		},
	};
}
