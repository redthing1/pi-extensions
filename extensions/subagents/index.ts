import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { observeChildRuntimeContributors, publishChildToolProvider } from "../shared/child-runtime.ts";
import { publishToolEffectAnalyzer, type ToolEffectAnalyzer } from "../shared/tool-effects.ts";
import { registerSubagentCommands } from "./src/commands.ts";
import { createSubagentEffectAnalyzer } from "./src/commission.ts";
import { loadSubagentConfig } from "./src/config.ts";
import { SubagentScheduler } from "./src/scheduler.ts";
import { registerSubagentTools } from "./src/tool.ts";

export default function registerSubagents(pi: ExtensionAPI): void {
	publishChildToolProvider(pi, {
		id: "subagents.parent-message",
		tools: [{ name: "parent_message", effects: [] }],
		async prepare() {
			return {
				id: "subagents.parent-message",
				args: ["--extension", fileURLToPath(new URL("./child.ts", import.meta.url))],
				metadata: {},
				dispose: async () => {},
			};
		},
	});
	const integrations = observeChildRuntimeContributors(pi);
	const tools = integrations.tools;
	const scheduler = new SubagentScheduler(loadSubagentConfig().maxConcurrency);

	publishToolEffectAnalyzer(pi, createSubagentEffectAnalyzer(tools));
	for (const toolName of ["subagent_wait", "subagent_list", "subagent_cancel", "subagent_send"]) {
		publishToolEffectAnalyzer(pi, safeLifecycleAnalyzer(toolName));
	}

	registerSubagentTools(pi, scheduler, integrations);
	registerSubagentCommands(pi, scheduler);
	pi.on("session_shutdown", async () => scheduler.shutdown());
}

function safeLifecycleAnalyzer(toolName: string): ToolEffectAnalyzer {
	return {
		toolName,
		analyze: () => ({
			toolName,
			effects: [],
			risk: "safe",
			pathInputs: [],
			known: true,
			reason: "subagent lifecycle operation does not add child capability",
		}),
	};
}
