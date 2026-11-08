import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ServingTelemetryController } from "../shared/serving-telemetry.js";
import { publishChildProviderRuntime } from "../shared/child-runtime.ts";
import { createRuntime, loadVllmRouters } from "./config.js";
import { createVllmModelRefresh } from "./discovery.js";
import { configuredModels } from "./models.js";
import { createVllmStream } from "./stream.js";

export default function vllmRouter(pi: ExtensionAPI): void {
	const telemetry = new ServingTelemetryController();
	const runtimes = loadVllmRouters().map(createRuntime);
	if (runtimes.length > 0) {
		publishChildProviderRuntime(pi, {
			id: "vllm-router",
			providers: runtimes.map((runtime) => runtime.provider),
			async prepare(intent) {
				return {
					id: "vllm-router",
					args: ["--extension", fileURLToPath(new URL(".", import.meta.url))],
					metadata: { provider: intent.provider },
					dispose: async () => undefined,
				};
			},
		});
	}
	pi.on("agent_start", (_event, ctx) => telemetry.attach(ctx));
	pi.on("session_start", (_event, ctx) => telemetry.attach(ctx));
	pi.on("agent_end", () => telemetry.end());
	pi.on("session_shutdown", () => telemetry.end());

	for (const runtime of runtimes) {
		pi.registerProvider(runtime.provider, {
			name: `vLLM (${runtime.router.name})`,
			baseUrl: runtime.apiBaseUrl,
			api: "openai-completions",
			zdr: runtime.router.zdr,
			streamSimple: createVllmStream(runtime, telemetry),
			models: configuredModels(runtime),
			refreshModels: createVllmModelRefresh(runtime),
		});
	}
}
