import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isGoalStatus } from "./domain.js";
import { GOAL_STATE_ENTRY, GOAL_STATE_REASONS, type Goal, type GoalStateEntry, type GoalStateReason } from "./types.js";

export interface GoalEntryWriter {
	appendEntry<T = unknown>(customType: string, data?: T): void;
}

export class GoalStore {
	private current: Goal | null = null;

	constructor(private readonly writer: GoalEntryWriter) {}

	restore(ctx: ExtensionContext): void {
		let restored: Goal | null = null;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== GOAL_STATE_ENTRY) continue;
			const state = parseGoalStateEntry(entry.data);
			if (state) restored = state.goal;
		}
		this.current = restored;
	}

	goal(): Goal | null {
		return this.current ? cloneGoal(this.current) : null;
	}

	commit(goal: Goal | null, reason: GoalStateReason, now = Date.now()): void {
		this.current = goal ? cloneGoal(goal) : null;
		const entry: GoalStateEntry = { goal: this.goal(), reason, writtenAt: now };
		this.writer.appendEntry(GOAL_STATE_ENTRY, entry);
	}
}

function parseGoalStateEntry(value: unknown): GoalStateEntry | undefined {
	if (!value || typeof value !== "object") return undefined;
	const entry = value as Partial<GoalStateEntry>;
	if (!isGoalStateReason(entry.reason)) return undefined;
	if (entry.goal !== null && !isGoal(entry.goal)) return undefined;
	if (!isNonNegativeInteger(entry.writtenAt)) return undefined;
	return { goal: entry.goal ? cloneGoal(entry.goal) : null, reason: entry.reason, writtenAt: entry.writtenAt };
}

function isGoal(value: unknown): value is Goal {
	if (!value || typeof value !== "object") return false;
	const goal = value as Partial<Goal>;
	return (
		typeof goal.id === "string" &&
		typeof goal.objective === "string" &&
		isGoalStatus(goal.status) &&
		isNonNegativeInteger(goal.tokensUsed) &&
		isNonNegativeInteger(goal.timeUsedMs) &&
		isPositiveInteger(goal.revision) &&
		isNonNegativeInteger(goal.createdAt) &&
		isNonNegativeInteger(goal.updatedAt) &&
		optionalTimestamp(goal.continuationErrorAt) &&
		(goal.tokenBudget === undefined || isPositiveInteger(goal.tokenBudget)) &&
		(goal.pauseReason === undefined || goal.pauseReason === "user" || goal.pauseReason === "interrupted") &&
		optionalTimestamp(goal.completedAt) &&
		optionalTimestamp(goal.blockedAt) &&
		optionalTimestamp(goal.budgetLimitedAt) &&
		optionalTimestamp(goal.budgetNoticeSentAt)
	);
}

function isGoalStateReason(value: unknown): value is GoalStateReason {
	return typeof value === "string" && GOAL_STATE_REASONS.some((reason) => reason === value);
}

function cloneGoal(goal: Goal): Goal {
	return { ...goal };
}

function optionalTimestamp(value: unknown): boolean {
	return value === undefined || isNonNegativeInteger(value);
}

function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
