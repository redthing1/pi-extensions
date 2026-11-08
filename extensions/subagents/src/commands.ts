import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SubagentPanel } from "./panel.ts";
import type { SubagentScheduler } from "./scheduler.ts";

export function registerSubagentCommands(pi: ExtensionAPI, scheduler: SubagentScheduler): void {
	pi.registerCommand("subagents", {
		description: "Inspect subagents and cancel selected work",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			await ctx.ui.custom<void>(
				(tui, theme, keybindings, done) => new SubagentPanel(scheduler, tui, theme, keybindings, done),
			);
		},
	});
}
