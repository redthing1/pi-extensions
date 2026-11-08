import { budgetSummary, formatDuration, formatTokens, loopStatus, statusLabel } from "../format.js";
import type { Goal } from "../types.js";
import type { GoalDraft } from "./panel-types.js";
import type { GoalPanelModel } from "./panel-types.js";

export function panelSummary(model: GoalPanelModel): string {
	if (model.mode.type === "setup") {
		const objective = objectiveDraftSummary(model.mode.draft);
		const budget = draftBudgetValue(model.mode.draft);
		return `${objective} | budget ${budget}`;
	}
	const goal = model.goal;
	if (!goal) return "No goal set";
	const budget = goal.tokenBudget === undefined ? formatDuration(goal.timeUsedMs) : budgetSummary(goal);
	return `${statusLabel(goal.status)} | ${budget} | ${model.loop.reason}`;
}

export function objectiveSummary(goal: Goal): string {
	return truncateSummary(goal.objective, "unset");
}

export function objectiveDraftSummary(draft: GoalDraft): string {
	return truncateSummary(draft.objective, "objective unset");
}

export function statusValue(goal: Goal): string {
	return goal.continuationErrorAt === undefined ? statusLabel(goal.status) : "Active, provider error";
}

export function usageValue(goal: Goal): string {
	const parts = [`time ${formatDuration(goal.timeUsedMs)}`, `tokens ${formatTokens(goal.tokensUsed)}`];
	return parts.join(", ");
}

export function budgetValue(goal: Goal): string {
	return goal.tokenBudget === undefined ? "none" : budgetSummary(goal);
}

export function draftBudgetValue(draft: GoalDraft): string {
	return draft.tokenBudget === undefined ? "none" : formatTokens(draft.tokenBudget);
}

export function objectiveDetails(goal: Goal): string[] {
	return ["Objective", "", ...wrapPlain(goal.objective, 74)];
}

export function goalDetails(goal: Goal): string[] {
	const lines = [
		`Status: ${statusValue(goal)}`,
		`Loop: ${loopStatus(goal).reason}`,
		...(goal.pauseReason ? [`Pause reason: ${pauseReasonLabel(goal.pauseReason)}`] : []),
		`Time used: ${formatDuration(goal.timeUsedMs)}`,
		`Tokens used: ${formatTokens(goal.tokensUsed)}`,
		`Token budget: ${goal.tokenBudget === undefined ? "none" : formatTokens(goal.tokenBudget)}`,
		`Created: ${new Date(goal.createdAt).toLocaleString()}`,
		`Updated: ${new Date(goal.updatedAt).toLocaleString()}`,
	];
	return lines;
}

function pauseReasonLabel(reason: NonNullable<Goal["pauseReason"]>): string {
	switch (reason) {
		case "interrupted":
			return "Interrupted";
		case "user":
			return "User";
	}
}

function wrapPlain(input: string, width: number): string[] {
	const words = input.split(/\s+/).filter(Boolean);
	const lines: string[] = [];
	let line = "";
	for (const word of words) {
		const candidate = line ? `${line} ${word}` : word;
		if (candidate.length > width && line) {
			lines.push(line);
			line = word;
		} else {
			line = candidate;
		}
	}
	if (line) lines.push(line);
	return lines.length > 0 ? lines : [""];
}

function truncateSummary(input: string, fallback: string): string {
	const normalized = input.replace(/\s+/g, " ").trim();
	if (!normalized) return fallback;
	return normalized.length > 48 ? `${normalized.slice(0, 45)}...` : normalized;
}
