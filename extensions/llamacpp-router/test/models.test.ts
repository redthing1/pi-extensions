import type { AnyModel } from "@earendil-works/pi-ai";
import { expect, test } from "vitest";
import { createRuntime } from "../config.ts";
import { modelConfig, persistableModels, restoreModelConfigs } from "../models.ts";

test("restores only this router's chat models from a mixed persisted catalog", () => {
	const runtime = createRuntime({ name: "local", url: "http://fixture.invalid" });
	const config = modelConfig(runtime, { id: "chat" }, {
		contextWindow: 32768,
		input: ["text", "image"],
		reasoning: false,
		template: {},
	});
	const [chat] = persistableModels(runtime, [config]);
	const base = { name: "Fixture", provider: runtime.provider, baseUrl: runtime.apiBaseUrl, input: ["text"] as ("text" | "image")[], cost: chat.cost };
	const catalog: AnyModel[] = [
		chat,
		{ ...chat, provider: "other-router" },
		{ ...base, id: "image", type: "image", api: "openrouter-images", output: ["image"] },
		{ ...base, id: "classifier", type: "classifier", api: "typesafe-system-one", contextWindow: 8192 },
	];
	expect(restoreModelConfigs(runtime, catalog)).toEqual([config]);
	expect(restoreModelConfigs(runtime, [{ ...chat, type: "chat" } satisfies AnyModel])).toEqual([config]);
	expect(persistableModels(runtime, restoreModelConfigs(runtime, catalog))).toEqual([chat]);
});
