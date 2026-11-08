import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { GoalRuntime } from "./runtime.js";

export function registerGoalShortcuts(registry: Pick<ExtensionAPI, "registerShortcut">, runtime: GoalRuntime): void {
	registry.registerShortcut("f8", {
		description: "Pause or resume goal",
		handler: (ctx) => {
			try {
				ctx.ui.notify(runtime.togglePause(ctx).message, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}
