export const GOAL_STATE_ENTRY = "goal.state";
export const GOAL_CONTINUATION_MESSAGE = "goal.continuation";
export const GOAL_BUDGET_MESSAGE = "goal.budget_limit";

export type GoalStatus = "active" | "paused" | "blocked" | "budget_limited" | "complete";
export type GoalPauseReason = "user" | "interrupted";
export const GOAL_STATE_REASONS = [
	"create",
	"replace",
	"pause",
	"resume",
	"budget",
	"complete",
	"blocked",
	"clear",
	"account",
	"budget-notice",
	"provider-error",
	"recovered",
] as const;
export type GoalStateReason = (typeof GOAL_STATE_REASONS)[number];

export interface Goal {
	id: string;
	objective: string;
	status: GoalStatus;
	tokenBudget?: number;
	tokensUsed: number;
	timeUsedMs: number;
	revision: number;
	pauseReason?: GoalPauseReason;
	createdAt: number;
	updatedAt: number;
	continuationErrorAt?: number;
	completedAt?: number;
	blockedAt?: number;
	budgetLimitedAt?: number;
	budgetNoticeSentAt?: number;
}

export interface GoalStateEntry {
	goal: Goal | null;
	reason: GoalStateReason;
	writtenAt: number;
}

export interface GoalMutationResult {
	goal: Goal | null;
	message: string;
}

export interface GoalLoopStatus {
	enabled: boolean;
	reason: string;
}

export interface GoalToolResponse {
	goal: Goal | null;
	remainingTokens?: number;
	loop: GoalLoopStatus;
	completionBudgetReport?: string;
}

export interface ParsedGoalCommand {
	kind: "panel" | "status" | "pause" | "resume" | "clear" | "set" | "replace" | "budget";
	objective?: string;
	tokenBudget?: number;
	clearBudget?: boolean;
}

export interface AssistantUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}
