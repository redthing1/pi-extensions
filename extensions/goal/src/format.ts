import type { Goal, GoalLoopStatus } from "./types.js";

const TOKEN_SUFFIXES = [
	{ suffix: "m", scale: 1_000_000 },
	{ suffix: "k", scale: 1_000 },
] as const;

export function parseTokenBudget(input: string): number {
	const trimmed = input.trim();
	if (trimmed.length === 0) throw new Error("Token budget is required.");

	const match = /^(\d+(?:\.\d+)?)([kKmM])?$/.exec(trimmed);
	if (!match) throw new Error(`Invalid token budget: ${input}`);

	const value = Number(match[1]);
	if (!Number.isFinite(value) || value <= 0) throw new Error("Token budget must be positive.");

	const suffix = match[2]?.toLowerCase();
	const multiplier = suffix === "m" ? 1_000_000 : suffix === "k" ? 1_000 : 1;
	const budget = Math.round(value * multiplier);
	if (!Number.isSafeInteger(budget) || budget <= 0) throw new Error("Token budget is out of range.");
	return budget;
}

export function formatTokens(tokens: number): string {
	const abs = Math.abs(tokens);
	for (const { suffix, scale } of TOKEN_SUFFIXES) {
		if (abs >= scale) {
			const value = tokens / scale;
			return `${trimFixed(value, value >= 10 ? 0 : 1)}${suffix.toUpperCase()}`;
		}
	}
	return `${tokens}`;
}

export function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const remMinutes = minutes % 60;
	if (hours < 24) return remMinutes > 0 ? `${hours}h ${remMinutes}m` : `${hours}h`;
	const days = Math.floor(hours / 24);
	const remHours = hours % 24;
	return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
}

export function remainingTokens(goal: Goal): number | undefined {
	return goal.tokenBudget === undefined ? undefined : Math.max(0, goal.tokenBudget - goal.tokensUsed);
}

export function budgetSummary(goal: Goal): string {
	if (goal.tokenBudget === undefined) return "none";
	const remaining = remainingTokens(goal) ?? 0;
	return `${formatTokens(goal.tokensUsed)} / ${formatTokens(goal.tokenBudget)}, ${formatTokens(remaining)} remaining`;
}

export function statusLabel(status: Goal["status"]): string {
	switch (status) {
		case "active":
			return "Active";
		case "paused":
			return "Paused";
		case "blocked":
			return "Blocked";
		case "budget_limited":
			return "Budget limited";
		case "complete":
			return "Complete";
	}
}

export function loopStatus(goal: Goal | null, queued = false): GoalLoopStatus {
	if (!goal) return { enabled: false, reason: "no goal" };
	switch (goal.status) {
		case "active":
			if (goal.continuationErrorAt !== undefined) {
				return { enabled: false, reason: "waiting after provider error" };
			}
			return { enabled: true, reason: queued ? "continuation queued" : "continuation enabled" };
		case "paused":
			return { enabled: false, reason: pauseReasonLabel(goal) };
		case "blocked":
			return { enabled: false, reason: "blocked" };
		case "budget_limited":
			return { enabled: false, reason: "stopped by token budget" };
		case "complete":
			return { enabled: false, reason: "complete" };
	}
}

function pauseReasonLabel(goal: Goal): string {
	switch (goal.pauseReason) {
		case "interrupted":
			return "paused after interrupt";
		default:
			return "paused by user";
	}
}

export function goalSummary(goal: Goal | null): string {
	if (!goal) return "No goal set.";
	const parts = [`Goal ${goal.status}`, `Objective: ${goal.objective}`, `Time: ${formatDuration(goal.timeUsedMs)}`];
	if (goal.tokenBudget !== undefined) {
		parts.push(`Tokens: ${formatTokens(goal.tokensUsed)} / ${formatTokens(goal.tokenBudget)}`);
	} else if (goal.tokensUsed > 0) {
		parts.push(`Tokens: ${formatTokens(goal.tokensUsed)}`);
	}
	if (goal.continuationErrorAt !== undefined) parts.push("Loop: waiting after provider error");
	return parts.join("\n");
}

export function completionBudgetReport(goal: Goal): string | undefined {
	const parts: string[] = [];
	if (goal.tokenBudget !== undefined) parts.push(`tokens used: ${goal.tokensUsed} of ${goal.tokenBudget}`);
	if (goal.timeUsedMs > 0) parts.push(`time used: ${Math.floor(goal.timeUsedMs / 1000)} seconds`);
	return parts.length > 0 ? `Goal achieved. Report final budget usage to the user: ${parts.join("; ")}.` : undefined;
}

function trimFixed(value: number, digits: number): string {
	return value.toFixed(digits).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}
