import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { GoalAccounting, type GoalUsageDelta } from "./accounting.js";
import {
	accountGoalUsage,
	blockGoal,
	clearGoalProviderError,
	completeGoal,
	createGoal,
	markGoalProviderError,
	markBudgetNoticeSent,
	pauseGoal,
	resumeGoal,
	setGoalBudget,
} from "./domain.js";
import { completionBudgetReport, loopStatus, remainingTokens } from "./format.js";
import { budgetLimitPrompt, continuationPrompt } from "./prompts.js";
import { GoalStore } from "./store.js";
import {
	GOAL_BUDGET_MESSAGE,
	GOAL_CONTINUATION_MESSAGE,
	type Goal,
	type GoalLoopStatus,
	type GoalMutationResult,
	type GoalStateReason,
	type GoalToolResponse,
} from "./types.js";
import { goalStatusLine } from "./ui/status.js";

const GOAL_STATUS_KEY = "goal";
type GoalChangeReason = "pause" | "resume" | "budget" | "complete" | "blocked";

export class GoalRuntime {
	private readonly store: GoalStore;
	private readonly accounting = new GoalAccounting();
	private continuationQueued = false;
	private statusTimer: ReturnType<typeof setInterval> | undefined;
	private statusContext: ExtensionContext | undefined;
	private settledOutcome: "error" | "success" | undefined;

	constructor(private readonly pi: ExtensionAPI) {
		this.store = new GoalStore(pi);
	}

	restore(ctx: ExtensionContext): void {
		this.stopStatusTimer();
		this.accounting.clear();
		this.resetContinuation();
		this.store.restore(ctx);
		this.updateStatus(ctx);
	}

	goal(): Goal | null {
		return this.store.goal();
	}

	displayGoal(): Goal | null {
		const goal = this.goal();
		if (!goal) return null;
		return { ...goal, timeUsedMs: goal.timeUsedMs + this.accounting.liveElapsedMs(goal) };
	}

	response(includeCompletionReport = false): GoalToolResponse {
		const goal = this.displayGoal();
		return {
			goal,
			remainingTokens: goal ? remainingTokens(goal) : undefined,
			loop: this.loopStatus(),
			completionBudgetReport: includeCompletionReport && goal ? completionBudgetReport(goal) : undefined,
		};
	}

	loopStatus(): GoalLoopStatus {
		return loopStatus(this.goal(), this.continuationQueued);
	}

	createFromTool(objective: string, tokenBudget: number | undefined, ctx: ExtensionContext): GoalMutationResult {
		const current = this.goal();
		if (current && current.status !== "complete") {
			throw new Error("cannot create a new goal because this session has an unfinished goal; complete the existing goal first");
		}
		const next = createGoal(objective, tokenBudget);
		this.resetContinuation();
		this.commit(next, current ? "replace" : "create", ctx);
		this.accounting.activateGoal(next);
		return { goal: this.displayGoal(), message: `Goal active: ${next.objective}` };
	}

	setFromUser(objective: string, tokenBudget: number | undefined, reason: "create" | "replace", ctx: ExtensionContext): GoalMutationResult {
		this.flush(ctx);
		const next = createGoal(objective, tokenBudget);
		this.resetContinuation();
		this.commit(next, reason, ctx);
		this.maybeContinue(ctx);
		return { goal: this.displayGoal(), message: `Goal active: ${next.objective}` };
	}

	pause(ctx: ExtensionContext): GoalMutationResult {
		this.changeGoal(ctx, "pause", (goal) => pauseGoal(goal, "user"));
		return { goal: this.displayGoal(), message: "Goal paused" };
	}

	pauseAfterInterrupt(ctx: ExtensionContext): GoalMutationResult | undefined {
		const goal = this.goal();
		if (!goal || goal.status !== "active") return undefined;
		this.changeGoal(ctx, "pause", (current) => pauseGoal(current, "interrupted"));
		return { goal: this.displayGoal(), message: "Goal paused after interrupt" };
	}

	resume(ctx: ExtensionContext): GoalMutationResult {
		this.changeGoal(ctx, "resume", resumeGoal);
		this.maybeContinue(ctx);
		return { goal: this.displayGoal(), message: "Goal resumed" };
	}

	togglePause(ctx: ExtensionContext): GoalMutationResult {
		const goal = this.goal();
		if (goal?.status === "active" && goal.continuationErrorAt === undefined) return this.pause(ctx);
		return this.resume(ctx);
	}

	clear(ctx: ExtensionContext): GoalMutationResult {
		this.flush(ctx);
		this.resetContinuation();
		this.store.commit(null, "clear");
		this.stopStatusTimer();
		this.updateStatus(ctx);
		return { goal: null, message: "Goal cleared" };
	}

	setBudget(tokenBudget: number | undefined, ctx: ExtensionContext): GoalMutationResult {
		this.changeGoal(ctx, "budget", (goal) => setGoalBudget(goal, tokenBudget));
		this.maybeContinue(ctx);
		return {
			goal: this.displayGoal(),
			message: tokenBudget === undefined ? "Goal budget cleared" : `Goal budget set: ${tokenBudget} tokens`,
		};
	}

	completeFromTool(ctx: ExtensionContext): GoalMutationResult {
		this.changeGoal(ctx, "complete", completeGoal);
		return { goal: this.displayGoal(), message: "Goal complete" };
	}

	blockFromTool(ctx: ExtensionContext): GoalMutationResult {
		this.changeGoal(ctx, "blocked", blockGoal);
		return { goal: this.displayGoal(), message: "Goal blocked" };
	}

	onTurnStart(ctx: ExtensionContext): void {
		this.continuationQueued = false;
		this.accounting.startTurn(this.goal());
		if (this.goal()?.status === "active") this.startStatusTimer(ctx);
		this.updateStatus(ctx);
	}

	onMessageEnd(message: AgentMessage, ctx: ExtensionContext): void {
		if (message.role !== "assistant") return;
		this.applyUsage(this.accounting.accountAssistantMessage(message, this.goal()), ctx);
	}

	onTurnEnd(ctx: ExtensionContext): void {
		this.applyUsage(this.accounting.finish(this.goal()), ctx);
		this.stopStatusTimer();
		this.updateStatus(ctx);
	}

	onAgentEnd(messages: AgentMessage[], ctx: ExtensionContext): void {
		const assistant = lastAssistantMessage(messages);
		if (assistant?.stopReason === "aborted") {
			this.pauseAfterInterrupt(ctx);
			return;
		}
		if (!assistant) return;
		this.settledOutcome = assistant.stopReason === "error" ? "error" : "success";
	}

	onAgentSettled(ctx: ExtensionContext): void {
		switch (this.settledOutcome) {
			case "error":
				this.settledOutcome = undefined;
				this.markProviderError(ctx);
				return;
			case "success":
				this.settledOutcome = undefined;
				this.clearProviderError(ctx);
				break;
		}
		this.maybeContinue(ctx);
	}

	onSessionShutdown(ctx: ExtensionContext): void {
		this.applyUsage(this.accounting.finish(this.goal()), ctx);
		this.resetContinuation();
		this.stopStatusTimer();
		ctx.ui.setStatus(GOAL_STATUS_KEY, undefined);
	}

	maybeContinue(ctx: ExtensionContext): void {
		if (this.continuationQueued || !ctx.isIdle() || ctx.hasPendingMessages()) return;
		const goal = this.goal();
		if (!goal) return;
		if (goal.continuationErrorAt !== undefined) return;
		if (goal.status === "budget_limited") {
			if (goal.budgetNoticeSentAt !== undefined) return;
			const noticed = markBudgetNoticeSent(goal);
			this.commit(noticed, "budget-notice", ctx);
			this.launch(ctx, GOAL_BUDGET_MESSAGE, budgetLimitPrompt(noticed));
			return;
		}
		if (goal.status !== "active") return;
		if (goal.tokenBudget !== undefined && goal.tokensUsed >= goal.tokenBudget) return;
		this.launch(ctx, GOAL_CONTINUATION_MESSAGE, continuationPrompt(goal));
	}

	private launch(ctx: ExtensionContext, customType: string, content: string): void {
		this.continuationQueued = true;
		this.updateStatus(ctx);
		this.pi.sendMessage({
			customType,
			content,
			display: false,
		}, { triggerTurn: true });
	}

	private flush(ctx: ExtensionContext): void {
		this.applyUsage(this.accounting.flush(this.goal()), ctx);
	}

	private changeGoal(
		ctx: ExtensionContext,
		reason: GoalChangeReason,
		change: (goal: Goal) => Goal,
	): Goal {
		this.flush(ctx);
		this.resetContinuation();
		const next = change(this.requireGoal());
		this.commit(next, reason, ctx);
		return next;
	}

	private applyUsage(delta: GoalUsageDelta | undefined, ctx: ExtensionContext): void {
		if (!delta) return;
		const goal = this.goal();
		if (!goal) return;
		const next = accountGoalUsage(goal, delta.timeMs, delta.tokens);
		if (next === goal) return;
		this.commit(next, "account", ctx);
	}

	private commit(goal: Goal, reason: Exclude<GoalStateReason, "clear">, ctx: ExtensionContext): void {
		this.store.commit(goal, reason);
		if (goal.status !== "active") this.stopStatusTimer();
		this.updateStatus(ctx);
	}

	private resetContinuation(): void {
		this.continuationQueued = false;
		this.settledOutcome = undefined;
	}

	private markProviderError(ctx: ExtensionContext): void {
		const goal = this.goal();
		if (!goal) return;
		const next = markGoalProviderError(goal);
		if (next !== goal) this.commit(next, "provider-error", ctx);
	}

	private clearProviderError(ctx: ExtensionContext): void {
		const goal = this.goal();
		if (!goal) return;
		const next = clearGoalProviderError(goal);
		if (next !== goal) this.commit(next, "recovered", ctx);
	}

	private requireGoal(): Goal {
		const goal = this.goal();
		if (!goal) throw new Error("No goal is currently set.");
		return goal;
	}

	private updateStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(GOAL_STATUS_KEY, goalStatusLine(this.displayGoal(), ctx.ui.theme));
	}

	private startStatusTimer(ctx: ExtensionContext): void {
		this.statusContext = ctx;
		if (this.statusTimer) return;
		this.statusTimer = setInterval(() => {
			const activeContext = this.statusContext;
			if (activeContext) this.updateStatus(activeContext);
		}, 1000);
	}

	private stopStatusTimer(): void {
		if (this.statusTimer) clearInterval(this.statusTimer);
		this.statusTimer = undefined;
		this.statusContext = undefined;
	}
}

function lastAssistantMessage(messages: AgentMessage[]): Extract<AgentMessage, { role: "assistant" }> | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role === "assistant") return message;
	}
	return undefined;
}
