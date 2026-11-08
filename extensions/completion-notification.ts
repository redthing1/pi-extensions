import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MESSAGE = "Pi finished working";
const SETTLEMENT_DELAY_MS = 100;

function supportsOsc9(): boolean {
	const program = process.env.TERM_PROGRAM?.toLowerCase() ?? "";
	return (
		program.includes("ghostty") ||
		program.includes("iterm") ||
		program.includes("kitty") ||
		program.includes("warp") ||
		program.includes("wezterm") ||
		process.env.KITTY_WINDOW_ID !== undefined ||
		process.env.WEZTERM_PANE !== undefined
	);
}

function notificationSequence(): string {
	if (!supportsOsc9()) return "\x07";
	const osc9 = `\x1b]9;${MESSAGE}\x07`;
	return process.env.TMUX ? `\x1bPtmux;\x1b${osc9}\x1b\\` : osc9;
}

export default function completionNotification(pi: ExtensionAPI): void {
	let pending: ReturnType<typeof setTimeout> | undefined;

	const cancelPending = (): void => {
		if (pending !== undefined) clearTimeout(pending);
		pending = undefined;
	};

	pi.on("agent_start", cancelPending);
	pi.on("session_shutdown", cancelPending);
	pi.on("agent_settled", (_event, ctx) => {
		cancelPending();
		if (ctx.mode !== "tui") return;

		pending = setTimeout(() => {
			pending = undefined;
			if (!ctx.isIdle() || ctx.hasPendingMessages()) return;
			process.stdout.write(notificationSequence());
		}, SETTLEMENT_DELAY_MS);
	});
}
