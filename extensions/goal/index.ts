import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerGoalCommand } from "./src/commands.js";
import { GoalRuntime } from "./src/runtime.js";
import { registerGoalShortcuts } from "./src/shortcuts.js";
import { registerGoalTools } from "./src/tools.js";

export default function (pi: ExtensionAPI): void {
	const runtime = new GoalRuntime(pi);

	registerGoalTools(pi, runtime);
	registerGoalCommand(pi, runtime);
	registerGoalShortcuts(pi, runtime);

	pi.on("session_start", async (_event, ctx) => {
		runtime.restore(ctx);
		runtime.maybeContinue(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		runtime.restore(ctx);
		runtime.maybeContinue(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		runtime.onSessionShutdown(ctx);
	});

	pi.on("turn_start", async (_event, ctx) => {
		runtime.onTurnStart(ctx);
	});

	pi.on("message_end", async (event, ctx) => {
		runtime.onMessageEnd(event.message, ctx);
	});

	pi.on("turn_end", async (_event, ctx) => {
		runtime.onTurnEnd(ctx);
	});

	pi.on("agent_end", async (event, ctx) => {
		runtime.onAgentEnd(event.messages, ctx);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		runtime.onAgentSettled(ctx);
	});
}
