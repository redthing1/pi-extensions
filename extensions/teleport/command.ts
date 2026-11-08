import {
	DynamicBorder,
	getSelectListTheme,
	type ExtensionAPI,
	type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Container, SelectList, Spacer, Text, safeTerminalText, safeTerminalLabel } from "@earendil-works/pi-tui";
import type { TeleportController } from "./controller.ts";

export function teleportSummary(controller: TeleportController | undefined, clientZdr: boolean): string {
	if (!controller) return "Teleport is inactive. Start a workspace with --teleport host[:path].";
	const state = controller.state;
	return safeTerminalText(
		[
			safeTerminalLabel(controller.label),
			`Connection: ${state.phase}`,
			...((state.phase === "disconnected" || state.phase === "disconnecting") && state.reason
				? [`Reason: ${safeTerminalLabel(state.reason)}`]
				: []),
			...(clientZdr ? ["Client ZDR: enabled"] : []),
			...(controller.cleanup ? [controller.cleanup] : []),
		].join("\n"),
	);
}

export function registerTeleportCommand(pi: ExtensionAPI, getController: () => TeleportController | undefined): void {
	pi.registerCommand("teleport", {
		description: "Inspect Teleport, reconnect, or disconnect",
		getArgumentCompletions: (prefix) =>
			["reconnect", "disconnect"]
				.filter((value) => value.startsWith(prefix))
				.map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			const controller = getController();
			let action = args.trim();
			if (!action) {
				if (!controller || !ctx.hasUI || ctx.mode !== "tui") {
					ctx.ui.notify(teleportSummary(controller, ctx.privacy.clientZdr), "info");
					return;
				}
				action = (await openPanel(controller, ctx)) ?? "";
				if (!action) return;
			}
			if (action !== "reconnect" && action !== "disconnect") {
				ctx.ui.notify("Usage: /teleport [reconnect|disconnect]", "info");
				return;
			}
			if (!controller || controller !== getController()) {
				ctx.ui.notify("Teleport is inactive. Start a workspace with --teleport host[:path].", "info");
				return;
			}
			try {
				if (action === "disconnect") {
					await controller.disconnect();
				} else {
					if (controller.state.phase === "connected") return;
					// A failed run must settle before replacing any tool definitions.
					await ctx.waitForIdle();
					if (controller !== getController()) return;
					await controller.reconnect();
				}
			} catch (error) {
				ctx.ui.notify(
					safeTerminalText(`Teleport: ${error instanceof Error ? error.message : String(error)}`),
					"error",
				);
			}
		},
	});
}

async function openPanel(controller: TeleportController, ctx: ExtensionCommandContext): Promise<string | undefined> {
	return ctx.ui.custom<string | undefined>((tui, theme, _keys, done) => {
		const panel = new Container();
		const summary = new Text("", 0, 0);
		let phase = controller.state.phase;
		let list: SelectList;
		const rebuild = () => {
			phase = controller.state.phase;
			panel.clear();
			panel.addChild(new DynamicBorder());
			panel.addChild(new Text(theme.bold("Teleport"), 0, 0));
			panel.addChild(summary);
			panel.addChild(new Spacer(1));
			const actions =
				phase === "connected"
					? [{ value: "disconnect", label: "Disconnect", description: "Keep the client session and conversation" }]
					: phase === "disconnected"
						? [
								{
									value: "reconnect",
									label: "Reconnect",
									description: "Connect to the same workspace; do not replay commands",
								},
							]
						: phase === "connecting"
							? [{ value: "disconnect", label: "Cancel connection", description: "Keep the client session" }]
							: [];
			list = new SelectList([...actions, { value: "", label: "Close" }], 4, getSelectListTheme());
			list.onSelect = (item) => done(item.value || undefined);
			list.onCancel = () => done(undefined);
			panel.addChild(list);
			panel.addChild(new DynamicBorder());
		};
		rebuild();
		return {
			render(width) {
				if (phase !== controller.state.phase) rebuild();
				summary.setText(teleportSummary(controller, ctx.privacy.clientZdr));
				return panel.render(width);
			},
			handleInput(data) {
				if (phase !== controller.state.phase) {
					rebuild();
					tui.requestRender();
					return;
				}
				list.handleInput(data);
				tui.requestRender();
			},
			invalidate() {
				panel.invalidate();
			},
		};
	});
}
