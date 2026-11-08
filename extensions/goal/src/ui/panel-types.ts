import type { Goal, GoalLoopStatus } from "../types.js";

export interface GoalDraft {
	objective: string;
	tokenBudget?: number;
}

export type GoalPanelMode =
	| { type: "goal" }
	| { type: "setup"; title: string; draft: GoalDraft; submitLabel: string };

export interface GoalPanelModel {
	mode: GoalPanelMode;
	goal: Goal | null;
	loop: GoalLoopStatus;
}

export type GoalPanelAction =
	| { type: "new" }
	| { type: "replace" }
	| { type: "save-draft" }
	| { type: "pause" }
	| { type: "resume" }
	| { type: "clear-budget" }
	| { type: "clear" }
	| { type: "close" };

export interface GoalPanelCallbacks {
	onAction(action: GoalPanelAction): void;
	onDraftChange(draft: GoalDraft): void;
	onBudgetChange(tokenBudget: number | undefined): void;
}
