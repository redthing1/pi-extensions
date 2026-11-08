import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ServingTelemetryController } from "../shared/serving-telemetry.js";
import { publishChildProviderRuntime } from "../shared/child-runtime.ts";
import { createRuntime, loadRouters } from "./config.js";
import { createRouterProviderConfig } from "./provider.js";

export default function llamaCppRouter(pi: ExtensionAPI): void {
	const telemetry = new ServingTelemetryController();
	const runtimes = loadRouters().map(createRuntime);
	if (runtimes.length > 0) {
		publishChildProviderRuntime(pi, {
			id: "llamacpp-router",
			providers: runtimes.map((runtime) => runtime.provider),
			async prepare(intent) {
				return {
					id: "llamacpp-router",
					args: ["--extension", fileURLToPath(new URL(".", import.meta.url))],
					metadata: { provider: intent.provider },
					dispose: async () => undefined,
				};
			},
		});
	}

	pi.on("agent_start", (_event, ctx) => {
		telemetry.attach(ctx);
	});
	pi.on("session_start", (_event, ctx) => {
		telemetry.attach(ctx);
	});
	pi.on("agent_end", () => {
		telemetry.end();
	});
	pi.on("session_shutdown", () => {
		telemetry.end();
	});

	for (const runtime of runtimes) {
		pi.registerProvider(runtime.provider, createRouterProviderConfig(runtime, telemetry));
	}
}
