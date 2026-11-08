import type { Theme } from "@earendil-works/pi-coding-agent";
import { formatDuration, formatTokens } from "../format.js";
import type { Goal } from "../types.js";

export function goalStatusLine(goal: Goal | null, theme?: Theme): string | undefined {
	if (!goal) return undefined;
	const text = `goal ${statusText(goal)}${usageText(goal)}`;
	if (!theme) return text;
	switch (goal.status) {
		case "active":
			return theme.fg("accent", text);
		case "paused":
			return theme.fg("warning", text);
		case "blocked":
			return theme.fg("warning", text);
		case "budget_limited":
			return theme.fg("error", text);
		case "complete":
			return theme.fg("success", text);
	}
}

function statusText(goal: Goal): string {
	switch (goal.status) {
		case "active":
			return goal.continuationErrorAt === undefined ? "active" : "active, provider error";
		case "paused":
			return "paused";
		case "blocked":
			return "blocked";
		case "budget_limited":
			return "budget";
		case "complete":
			return "complete";
	}
}

function usageText(goal: Goal): string {
	if (goal.tokenBudget !== undefined) {
		return ` ${formatTokens(goal.tokensUsed)}/${formatTokens(goal.tokenBudget)}`;
	}
	if (goal.status === "active" || goal.status === "complete") {
		return ` ${formatDuration(goal.timeUsedMs)}`;
	}
	return "";
}
