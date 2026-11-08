/**
 * Permission Gate Extension
 *
 * Opt-in confirmation before running potentially dangerous bash commands.
 * Patterns checked: rm -rf, sudo, chmod/chown 777
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	const dangerousPatterns = [/\brm\s+(-rf?|--recursive)/i, /\bsudo\b/i, /\b(chmod|chown)\b.*777/i];

	pi.registerFlag("permission-gate", {
		description: "Prompt for confirmation before potentially dangerous bash commands",
		type: "boolean",
		default: false,
	});

	let enabled = false;

	pi.on("session_start", () => {
		enabled = (pi.getFlag("permission-gate") as boolean | undefined) === true;

		// If the OS sandbox is enabled, don't stack a prompt-based gate on top.
		if ((pi.getFlag("sandbox") as boolean | undefined) === true) enabled = false;
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!enabled || event.toolName !== "bash") return undefined;

		const command = event.input.command as string;
		const isDangerous = dangerousPatterns.some((p) => p.test(command));

		if (isDangerous) {
			if (!ctx.hasUI) {
				// In non-interactive mode, block by default
				return { block: true, reason: "Dangerous command blocked (no UI for confirmation)" };
			}

			const choice = await ctx.ui.select(`⚠️ Dangerous command:\n\n  ${command}\n\nAllow?`, ["Yes", "No"]);

			if (choice !== "Yes") {
				return { block: true, reason: "Blocked by user" };
			}
		}

		return undefined;
	});
}
