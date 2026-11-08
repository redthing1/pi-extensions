import { DynamicBorder, type ExtensionContext, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, SettingsList, Spacer, Text } from "@earendil-works/pi-tui";

export async function showWebSearchPanel(
	ctx: ExtensionContext,
	isEnabled: () => boolean,
	change: (enabled: boolean) => string | undefined,
): Promise<void> {
	await ctx.ui.custom<void>((tui, theme, _keys, done) => {
		const panel = new Container();
		const message = new Text("", 0, 0);
		const settings = new SettingsList(
			[
				{
					id: "enabled",
					label: "Search & fetch",
					currentValue: isEnabled() ? "On" : "Off",
					values: ["Off", "On"],
					description: "For this session. Queries and URLs are sent to the search service.",
				},
			],
			1,
			getSettingsListTheme(),
			(_id, value) => {
				const error = change(value === "On");
				settings.updateValue("enabled", isEnabled() ? "On" : "Off");
				message.setText(error ? theme.fg("warning", error) : "");
				tui.requestRender();
			},
			() => done(),
		);
		panel.addChild(new DynamicBorder((text) => theme.fg("border", text)));
		panel.addChild(new Text(theme.fg("accent", theme.bold("Web search")), 0, 0));
		panel.addChild(new Spacer(1));
		panel.addChild(settings);
		panel.addChild(message);
		panel.addChild(new DynamicBorder((text) => theme.fg("border", text)));
		return {
			render: (width) => panel.render(width),
			invalidate: () => panel.invalidate(),
			handleInput: (data) => settings.handleInput(data),
		};
	});
}
