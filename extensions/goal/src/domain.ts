import { randomUUID } from "node:crypto";
import type { Goal, GoalPauseReason, GoalStatus } from "./types.js";

export function createGoal(objective: string, tokenBudget: number | undefined, now = Date.now()): Goal {
	return {
		id: randomUUID(),
		objective: normalizeObjective(objective),
		status: "active",
		tokenBudget: validateBudget(tokenBudget),
		tokensUsed: 0,
		timeUsedMs: 0,
		revision: 1,
		createdAt: now,
		updatedAt: now,
	};
}

export function pauseGoal(goal: Goal, reason: GoalPauseReason, now = Date.now()): Goal {
	if (goal.status === "complete") throw new Error("Cannot pause a complete goal.");
	return transition(goal, { status: "paused", pauseReason: reason }, now);
}

export function resumeGoal(goal: Goal, now = Date.now()): Goal {
	if (goal.status === "complete") throw new Error("Cannot resume a complete goal. Replace it with a new goal instead.");
	if (goal.tokenBudget !== undefined && goal.tokensUsed >= goal.tokenBudget) {
		throw new Error("Cannot resume: token budget is already exhausted. Raise or clear the budget first.");
	}
	return transition(goal, { status: "active", pauseReason: undefined, continuationErrorAt: undefined }, now);
}

export function setGoalBudget(goal: Goal, tokenBudget: number | undefined, now = Date.now()): Goal {
	const budget = validateBudget(tokenBudget);
	if (goal.status === "active" && budget !== undefined && goal.tokensUsed >= budget) {
		return transition(goal, { tokenBudget: budget, status: "budget_limited", budgetLimitedAt: now }, now);
	}
	if (goal.status === "budget_limited" && (budget === undefined || goal.tokensUsed < budget)) {
		return transition(
			goal,
			{ tokenBudget: budget, status: "paused", pauseReason: "user", budgetLimitedAt: undefined, budgetNoticeSentAt: undefined },
			now,
		);
	}
	return transition(goal, { tokenBudget: budget }, now);
}

export function completeGoal(goal: Goal, now = Date.now()): Goal {
	return transition(goal, { status: "complete", completedAt: now, pauseReason: undefined, continuationErrorAt: undefined }, now);
}

export function blockGoal(goal: Goal, now = Date.now()): Goal {
	return transition(goal, { status: "blocked", blockedAt: now, pauseReason: undefined, continuationErrorAt: undefined }, now);
}

export function markGoalProviderError(goal: Goal, now = Date.now()): Goal {
	if (goal.status !== "active" || goal.continuationErrorAt !== undefined) return goal;
	return transition(goal, { continuationErrorAt: now }, now);
}

export function clearGoalProviderError(goal: Goal, now = Date.now()): Goal {
	if (goal.continuationErrorAt === undefined) return goal;
	return transition(goal, { continuationErrorAt: undefined }, now);
}

export function accountGoalUsage(goal: Goal, timeDeltaMs: number, tokenDelta: number, now = Date.now()): Goal {
	if (goal.status !== "active") return goal;
	const next = {
		...goal,
		timeUsedMs: goal.timeUsedMs + Math.max(0, Math.floor(timeDeltaMs)),
		tokensUsed: goal.tokensUsed + Math.max(0, Math.floor(tokenDelta)),
		updatedAt: now,
	};
	if (next.tokenBudget !== undefined && next.tokensUsed >= next.tokenBudget) {
		return { ...next, status: "budget_limited", budgetLimitedAt: now };
	}
	return next;
}

export function markBudgetNoticeSent(goal: Goal, now = Date.now()): Goal {
	if (goal.status !== "budget_limited" || goal.budgetNoticeSentAt !== undefined) return goal;
	return { ...goal, budgetNoticeSentAt: now, updatedAt: now };
}

export function isGoalStatus(value: unknown): value is GoalStatus {
	return value === "active" || value === "paused" || value === "blocked" || value === "budget_limited" || value === "complete";
}

export function normalizeObjective(objective: string): string {
	const trimmed = objective.trim();
	if (trimmed.length === 0) throw new Error("Goal objective must not be empty.");
	if (trimmed.length > 4000) throw new Error("Goal objective must be 4000 characters or fewer.");
	return trimmed;
}

export function validateBudget(value: number | undefined): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isSafeInteger(value) || value <= 0) throw new Error("token_budget must be a positive integer.");
	return value;
}

function transition(goal: Goal, changes: Partial<Goal>, now: number): Goal {
	return { ...goal, ...changes, revision: goal.revision + 1, updatedAt: now };
}
