import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Goal } from "./types.js";

export interface GoalUsageDelta {
	timeMs: number;
	tokens: number;
}

export class GoalAccounting {
	private activeTurn: { goalId: string; startedAt: number } | undefined;
	private readonly accountedMessages = new WeakSet<object>();

	startTurn(goal: Goal | null): void {
		this.activeTurn = goal?.status === "active" ? { goalId: goal.id, startedAt: Date.now() } : undefined;
	}

	activateGoal(goal: Goal): void {
		this.activeTurn = { goalId: goal.id, startedAt: Date.now() };
	}

	flush(goal: Goal | null): GoalUsageDelta | undefined {
		if (!this.activeTurn || !goal || goal.status !== "active" || goal.id !== this.activeTurn.goalId) {
			this.activeTurn = undefined;
			return undefined;
		}
		const now = Date.now();
		const timeMs = Math.max(0, now - this.activeTurn.startedAt);
		this.activeTurn.startedAt = now;
		return timeMs > 0 ? { timeMs, tokens: 0 } : undefined;
	}

	accountAssistantMessage(message: AgentMessage, goal: Goal | null): GoalUsageDelta | undefined {
		if (message.role !== "assistant" || this.accountedMessages.has(message)) return undefined;
		this.accountedMessages.add(message);
		const elapsed = this.flush(goal) ?? { timeMs: 0, tokens: 0 };
		if (!goal || goal.status !== "active" || this.activeTurn?.goalId !== goal.id) return elapsed.timeMs > 0 ? elapsed : undefined;
		const usage = message.usage;
		const tokens = Math.max(0, usage.input) + Math.max(0, usage.cacheWrite) + Math.max(0, usage.output);
		return elapsed.timeMs > 0 || tokens > 0 ? { timeMs: elapsed.timeMs, tokens } : undefined;
	}

	liveElapsedMs(goal: Goal | null): number {
		if (!this.activeTurn || !goal || goal.status !== "active" || goal.id !== this.activeTurn.goalId) return 0;
		return Math.max(0, Date.now() - this.activeTurn.startedAt);
	}

	finish(goal: Goal | null): GoalUsageDelta | undefined {
		const delta = this.flush(goal);
		this.activeTurn = undefined;
		return delta;
	}

	clear(): void {
		this.activeTurn = undefined;
	}
}
