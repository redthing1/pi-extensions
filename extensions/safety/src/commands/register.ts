import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SafetyController } from "../controller/controller.js";
import { handleSafetyCommand } from "./handlers.js";

export interface RegisterSafetyCommandsOptions {
	getController: (ctx: ExtensionCommandContext) => SafetyController;
	updateStatus: (ctx: ExtensionCommandContext) => void;
}

export interface CommandRegistry {
	registerCommand(
		name: string,
		options: {
			description?: string;
			handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void;
		},
	): void;
}

export function registerSafetyCommands(registry: CommandRegistry, options: RegisterSafetyCommandsOptions): void {
	registry.registerCommand("safety", {
		description: "Inspect and configure the Safety extension",
		handler: async (args, ctx) => {
			const controller = options.getController(ctx);
			await handleSafetyCommand(args, { controller, ctx, updateStatus: options.updateStatus });
		},
	});
}
