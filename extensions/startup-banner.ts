import { homedir } from "node:os";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { observeActiveWorkspace } from "./shared/active-workspace.ts";

function shortenPath(filePath: string): string {
	const home = homedir();
	const displayPath = filePath.startsWith(home) ? `~${filePath.slice(home.length)}` : filePath;
	const parts = displayPath.split("/").filter(Boolean);

	if (parts.length <= 4) return displayPath;

	const suffix = parts.slice(-3).join("/");
	return displayPath.startsWith("~/") ? `~/${suffix}` : `.../${suffix}`;
}

function startupBanner(theme: Theme, cwd: string): string[] {
	const mark = theme.bold(theme.fg("accent", "rt1"));
	const name = theme.bold(theme.fg("text", " pi"));
	const version = theme.fg("dim", ` v${VERSION}`);
	const location = theme.fg("muted", shortenPath(cwd));

	return [`  ${mark}${name}${version}`, `  ${location}`];
}

export default function startupBannerExtension(pi: ExtensionAPI) {
	const workspaces = observeActiveWorkspace(pi);
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;

		ctx.ui.setHeader((_tui, theme) => ({
			render: () => {
				const access = workspaces.current();
				return startupBanner(theme, access.kind === "ready" ? access.workspace.identity.label : access.kind === "unavailable" ? access.label : ctx.cwd);
			},
			invalidate() { },
		}));
	});
}
