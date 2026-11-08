import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { cloneItem, cloneState, emptyScheduleState, persistScheduleState, restoreScheduleState } from "./state.js";
import { nextDueDisplayRefreshMs } from "./time.js";
import type { ScheduleDelivery, ScheduleItem, ScheduleKind, ScheduleState } from "./types.js";

const MAX_TIMER_MS = 2_147_483_647;
const IDLE_RETRY_MS = 15_000;

interface RescheduleOptions {
	runOverdueOnce?: boolean;
}

export interface NewScheduleItem {
	kind: ScheduleKind;
	prompt: string;
	nextRunAt: number;
	delivery: ScheduleDelivery;
	intervalMs?: number;
}

export type ScheduleTiming = Omit<NewScheduleItem, "prompt" | "delivery">;

export class ScheduleController {
	private state: ScheduleState = emptyScheduleState();
	private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
	private statusTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(
		private readonly pi: ExtensionAPI,
		private readonly updateStatus: (ctx: ExtensionContext) => void,
	) {}

	restore(ctx: ExtensionContext): void {
		this.state = restoreScheduleState(ctx);
		this.reschedule(ctx, { runOverdueOnce: true });
	}

	clear(ctx?: ExtensionContext): void {
		this.clearScheduleTimers();
		this.clearStatusTimer();
		if (ctx) this.updateStatus(ctx);
	}

	items(): ScheduleItem[] {
		return cloneState(this.state).items;
	}

	get(id: string): ScheduleItem | undefined {
		const item = this.state.items.find((candidate) => candidate.id === id);
		return item ? cloneItem(item) : undefined;
	}

	add(ctx: ExtensionContext, item: NewScheduleItem): ScheduleItem {
		const created: ScheduleItem = {
			id: String(this.state.nextId),
			kind: item.kind,
			enabled: true,
			prompt: item.prompt,
			nextRunAt: item.nextRunAt,
			createdAt: Date.now(),
			delivery: item.delivery,
			intervalMs: item.intervalMs,
		};
		this.state = {
			items: [...this.state.items, created],
			nextId: this.state.nextId + 1,
		};
		this.persist("add");
		this.reschedule(ctx);
		return cloneItem(created);
	}

	toggle(ctx: ExtensionContext, id: string): void {
		const item = this.find(id);
		if (!item) return;
		item.enabled = !item.enabled;
		this.persist("toggle");
		this.reschedule(ctx, { runOverdueOnce: item.enabled });
	}

	updatePrompt(ctx: ExtensionContext, id: string, prompt: string): void {
		const item = this.find(id);
		if (!item) return;
		item.prompt = prompt;
		this.persist("edit");
	}

	updateTiming(ctx: ExtensionContext, id: string, timing: ScheduleTiming): void {
		const item = this.find(id);
		if (!item) return;
		item.kind = timing.kind;
		item.nextRunAt = timing.nextRunAt;
		item.intervalMs = timing.intervalMs;
		this.persist("edit");
		this.reschedule(ctx);
	}

	updateDelivery(id: string, delivery: ScheduleDelivery): void {
		const item = this.find(id);
		if (!item) return;
		item.delivery = delivery;
		this.persist("edit");
	}

	delete(ctx: ExtensionContext, id: string): void {
		this.state = {
			...this.state,
			items: this.state.items.filter((item) => item.id !== id),
		};
		this.persist("delete");
		this.reschedule(ctx);
	}

	runNow(ctx: ExtensionContext, id: string): void {
		const item = this.find(id);
		if (!item) return;
		this.deliver(ctx, item);
	}

	reschedule(ctx: ExtensionContext, options: RescheduleOptions = {}): void {
		this.clearScheduleTimers();
		this.clearStatusTimer();
		const now = Date.now();
		for (const item of this.state.items) {
			// Restore/resume catches up once per schedule, never once per missed interval.
			if (options.runOverdueOnce && item.enabled && item.nextRunAt <= now) {
				this.fire(ctx, item.id);
				continue;
			}
			this.schedule(ctx, item);
		}
		this.refreshStatus(ctx);
	}

	private find(id: string): ScheduleItem | undefined {
		return this.state.items.find((item) => item.id === id);
	}

	private schedule(ctx: ExtensionContext, item: ScheduleItem, delayOverride?: number): void {
		const existing = this.timers.get(item.id);
		if (existing) clearTimeout(existing);
		this.timers.delete(item.id);

		if (!item.enabled) return;
		const delay = delayOverride ?? Math.max(0, item.nextRunAt - Date.now());
		const timer = setTimeout(() => this.fire(ctx, item.id), Math.min(delay, MAX_TIMER_MS));
		this.timers.set(item.id, timer);
	}

	private fire(ctx: ExtensionContext, id: string): void {
		this.timers.delete(id);
		const item = this.find(id);
		if (!item || !item.enabled) return;

		if (!ctx.isIdle() && item.delivery === "idle") {
			this.refreshStatus(ctx);
			this.schedule(ctx, item, IDLE_RETRY_MS);
			return;
		}

		const now = Date.now();
		if (item.kind === "interval" && item.intervalMs !== undefined) {
			item.lastRunAt = now;
			item.nextRunAt = now + item.intervalMs;
		} else {
			item.enabled = false;
			item.lastRunAt = now;
		}

		this.persist("run");
		this.schedule(ctx, item);
		this.refreshStatus(ctx);
		this.deliver(ctx, item);
	}

	private deliver(ctx: ExtensionContext, item: ScheduleItem): void {
		try {
			if (ctx.isIdle()) {
				this.pi.sendUserMessage(item.prompt);
			} else {
				this.pi.sendUserMessage(item.prompt, { deliverAs: "followUp" });
				ctx.ui.notify("Scheduled follow-up queued", "info");
			}
		} catch (error) {
			ctx.ui.notify(`Scheduled prompt failed: ${errorMessage(error)}`, "error");
		}
	}

	private persist(reason: string): void {
		persistScheduleState(this.pi, this.state, reason);
	}

	private refreshStatus(ctx: ExtensionContext): void {
		this.updateStatus(ctx);
		this.scheduleStatusRefresh(ctx);
	}

	private scheduleStatusRefresh(ctx: ExtensionContext): void {
		this.clearStatusTimer();
		const nextRunAt = this.nextEnabledRunAt();
		if (nextRunAt === undefined) return;
		const delay = nextDueDisplayRefreshMs(nextRunAt);
		if (delay === undefined) return;
		this.statusTimer = setTimeout(() => this.refreshStatus(ctx), delay);
	}

	private clearStatusTimer(): void {
		if (!this.statusTimer) return;
		clearTimeout(this.statusTimer);
		this.statusTimer = undefined;
	}

	private clearScheduleTimers(): void {
		for (const timer of this.timers.values()) clearTimeout(timer);
		this.timers.clear();
	}

	private nextEnabledRunAt(): number | undefined {
		let next: number | undefined;
		for (const item of this.state.items) {
			if (!item.enabled) continue;
			if (next === undefined || item.nextRunAt < next) next = item.nextRunAt;
		}
		return next;
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
