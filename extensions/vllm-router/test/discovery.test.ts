import type { RefreshModelsContext } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createVllmModelRefresh } from "../discovery.ts";
import type { VllmRuntime } from "../types.ts";

function runtime(): VllmRuntime {
	return {
		router: { name: "local", url: "https://vllm.example.com", zdr: true, models: { model: {} } },
		provider: "vllm-local",
		serverUrl: "https://vllm.example.com",
		apiBaseUrl: "https://vllm.example.com/v1",
		stats: { enabled: false, minIntervalMs: 100 },
		discoveryTimeoutMs: 5000,
	};
}

function context(overrides: Partial<RefreshModelsContext> = {}): RefreshModelsContext {
	return {
		allowNetwork: true,
		credential: { type: "api_key", key: "synthetic-key" },
		signal: new AbortController().signal,
		publish: async (publication) => {
			expect(publication).not.toHaveProperty("persist");
			publication.update?.();
			return true;
		},
		...overrides,
	};
}

const vision = {
	id: "model",
	max_model_len: 1048576,
	architecture: { input_modalities: ["text", "image"] },
	supported_parameters: ["reasoning_effort"],
	reasoning_options: ["low", "high", "max"],
	default_parameters: { reasoning_effort: "max" },
};

function serve(data: unknown[] = [vision]) {
	const fetch = vi.fn(async () => Response.json({ data }));
	vi.stubGlobal("fetch", fetch);
	return fetch;
}

afterEach(() => vi.unstubAllGlobals());

describe("vLLM catalog refresh", () => {
	test("keeps discovered capabilities through offline, unauthenticated and failed refreshes", async () => {
		const refresh = createVllmModelRefresh(runtime());
		const fetch = serve();
		expect((await refresh(context({ allowNetwork: false })))[0].input).toEqual(["text"]);
		const learned = await refresh(context());
		expect(learned[0]).toMatchObject({ input: ["text", "image"], contextWindow: 1048576,
			reasoning: true, defaultThinkingLevel: "max", zdr: true });
		expect(await refresh(context({ allowNetwork: false }))).toEqual(learned);
		expect(await refresh(context({ credential: undefined }))).toEqual(learned);
		expect(fetch).toHaveBeenCalledTimes(1);
		fetch.mockResolvedValueOnce(new Response(null, { status: 503 }));
		await expect(refresh(context())).rejects.toThrow("HTTP 503");
		expect(await refresh(context({ allowNetwork: false }))).toEqual(learned);
		fetch.mockRejectedValueOnce(new TypeError("synthetic network failure"));
		await expect(refresh(context())).rejects.toThrow("synthetic network failure");
		expect(await refresh(context({ allowNetwork: false }))).toEqual(learned);
	});

	test("keeps a usable catalog when a response has no usable listings", async () => {
		const refresh = createVllmModelRefresh(runtime());
		const fetch = serve();
		const learned = await refresh(context());
		for (const body of [{ data: [] }, { data: [{ id: "" }] }, {}]) {
			fetch.mockResolvedValueOnce(Response.json(body));
			expect(await refresh(context())).toEqual(learned);
		}
	});

	test("replaces the catalog on successful discovery, including capability removal", async () => {
		const refresh = createVllmModelRefresh(runtime());
		const fetch = serve([vision, { id: "retired", max_model_len: 8192 }]);
		expect(await refresh(context())).toHaveLength(2);
		fetch.mockResolvedValueOnce(Response.json({ data: [
			{ id: "model", max_model_len: 4096, architecture: { input_modalities: ["text"] } },
		] }));
		const changed = await refresh(context());
		expect(changed).toHaveLength(1);
		expect(changed[0]).toMatchObject({ input: ["text"], contextWindow: 4096, reasoning: false });
		expect(await refresh(context({ allowNetwork: false }))).toEqual(changed);
	});

	test("reapplies current local overrides without storing them in the discovered catalog", async () => {
		const config = runtime();
		const refresh = createVllmModelRefresh(config);
		serve();
		await refresh(context());
		config.router.models = { model: { input: ["text"], contextWindow: 4096, reasoning: false, zdr: false } };
		expect((await refresh(context({ allowNetwork: false })))[0]).toMatchObject({
			input: ["text"], contextWindow: 4096, reasoning: false, zdr: false,
		});
		config.router.models = undefined;
		expect((await refresh(context({ allowNetwork: false })))[0]).toMatchObject({
			input: ["text", "image"], contextWindow: 1048576, reasoning: true, zdr: true,
		});
	});

	test("isolates catalogs between router instances and from mutations to returned models", async () => {
		const refresh = createVllmModelRefresh(runtime());
		serve();
		const learned = await refresh(context());
		learned[0].input.splice(0, 2, "text");
		expect((await refresh(context({ allowNetwork: false })))[0].input).toEqual(["text", "image"]);
		const other = createVllmModelRefresh(runtime());
		expect((await other(context({ allowNetwork: false })))[0].input).toEqual(["text"]);
	});

	test("does not remember a result rejected by the runtime publication guard", async () => {
		const refresh = createVllmModelRefresh(runtime());
		const fetch = serve();
		const learned = await refresh(context());
		fetch.mockResolvedValueOnce(Response.json({ data: [{ id: "superseded" }] }));
		const rejected = context({ publish: async () => false });
		expect(await refresh(rejected)).toEqual(learned);
		expect(await refresh(context({ allowNetwork: false }))).toEqual(learned);
	});
});
