import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { openSchedulePanel, scheduleDelayedPrompt } from "./src/commands.js";
import { ScheduleController } from "./src/controller.js";
import { scheduleStatusLine } from "./src/ui/status.js";

const SCHEDULE_STATUS_KEY = "schedule";

export default function (pi: ExtensionAPI): void {
	let controller: ScheduleController;

	function updateStatus(ctx: ExtensionContext): void {
		ctx.ui.setStatus(SCHEDULE_STATUS_KEY, scheduleStatusLine(controller.items(), ctx.ui.theme));
	}

	controller = new ScheduleController(pi, updateStatus);

	pi.registerCommand("schedule", {
		description: "Manage scheduled prompts",
		handler: async (_args, ctx) => {
			await openSchedulePanel(ctx, controller);
		},
	});

	pi.registerCommand("delay", {
		description: "Send a follow-up after a delay",
		handler: async (args, ctx) => {
			scheduleDelayedPrompt(args, ctx, controller);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		controller.restore(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		controller.restore(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		controller.clear(ctx);
		ctx.ui.setStatus(SCHEDULE_STATUS_KEY, undefined);
	});
}
