import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SchedulePanel } from "./ui/panel.js";
import type { ScheduleController, ScheduleTiming } from "./controller.js";
import { formatDueTime, formatDuration, parseDurationMs, parseLocalTime } from "./time.js";
import type { ScheduleDelivery, ScheduleItem, ScheduleKind, SchedulePanelAction } from "./types.js";

const WHEN_IN = "In a relative duration";
const WHEN_AT = "At a local time";
const WHEN_EVERY = "Every interval";

const BUSY_IDLE = "Run when idle";
const BUSY_FOLLOW_UP = "Queue follow-up";

const EDIT_TIMING = "Timing";
const EDIT_PROMPT = "Prompt";
const EDIT_BUSY = "Busy behavior";
const EDIT_DONE = "Done";

export function scheduleDelayedPrompt(
	args: string,
	ctx: ExtensionContext,
	controller: ScheduleController,
): void {
	const match = /^(\S+)\s+([\s\S]+)$/.exec(args.trim());
	if (!match) {
		ctx.ui.notify("Usage: /delay <duration> <message>", "error");
		return;
	}

	const duration = parseDurationMs(match[1] ?? "");
	if (!duration) {
		ctx.ui.notify("Use a compact duration like 30s, 10m, 1h30m, or 2d.", "error");
		return;
	}

	const prompt = match[2]?.trim();
	if (!prompt) {
		ctx.ui.notify("Delayed message must not be empty.", "error");
		return;
	}

	controller.add(ctx, {
		kind: "once",
		prompt,
		nextRunAt: Date.now() + duration,
		delivery: "followUp",
	});
	ctx.ui.notify(`Follow-up scheduled in ${formatDuration(duration)}`, "info");
}

export async function openSchedulePanel(ctx: ExtensionContext, controller: ScheduleController): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify(scheduleSummary(controller.items()), "info");
		return;
	}

	for (;;) {
		const action = await ctx.ui.custom<SchedulePanelAction>((tui, theme, _keybindings, done) => {
			return new SchedulePanel(tui, theme, controller.items(), done);
		});

		const keepOpen = await handlePanelAction(ctx, controller, action);
		if (!keepOpen) return;
	}
}

async function handlePanelAction(
	ctx: ExtensionContext,
	controller: ScheduleController,
	action: SchedulePanelAction | undefined,
): Promise<boolean> {
	if (!action || action.type === "close") return false;
	if (action.type === "new") {
		await createSchedule(ctx, controller);
		return true;
	}
	return manageSchedule(ctx, controller, action.id);
}

async function createSchedule(ctx: ExtensionContext, controller: ScheduleController): Promise<void> {
	const when = await ctx.ui.select("Schedule", [WHEN_IN, WHEN_AT, WHEN_EVERY]);
	if (!when) return;

	const draft = await buildScheduleTiming(ctx, when);
	if (!draft) return;

	const prompt = await ctx.ui.input("Prompt to run", "Ask Pi to...");
	if (!prompt?.trim()) {
		ctx.ui.notify("Schedule prompt must not be empty.", "error");
		return;
	}

	const busy = await ctx.ui.select("When the agent is busy", [BUSY_IDLE, BUSY_FOLLOW_UP]);
	if (!busy) return;

	controller.add(ctx, {
		...draft,
		prompt: prompt.trim(),
		delivery: deliveryForChoice(busy),
	});
	ctx.ui.notify("Schedule created", "info");
}

async function buildScheduleTiming(
	ctx: ExtensionContext,
	when: string,
): Promise<ScheduleTiming | undefined> {
	switch (when) {
		case WHEN_IN:
			return buildRelativeDraft(ctx, "Run in", "10m or 1h30m", "once");
		case WHEN_AT: {
			const value = await ctx.ui.input("Run at local time", "9am, tomorrow 9:30, fri 17:00");
			if (!value) return undefined;
			const nextRunAt = parseLocalTime(value);
			if (!nextRunAt) {
				ctx.ui.notify("Use a time like 14:30, 9am, tomorrow 9:30, or fri 17:00.", "error");
				return undefined;
			}
			return { kind: "once", nextRunAt };
		}
		case WHEN_EVERY:
			return buildRelativeDraft(ctx, "Run every", "30m or 1h30m", "interval");
		default:
			return undefined;
	}
}

async function buildRelativeDraft(
	ctx: ExtensionContext,
	title: string,
	placeholder: string,
	kind: ScheduleKind,
): Promise<ScheduleTiming | undefined> {
	const value = await ctx.ui.input(title, placeholder);
	if (!value) return undefined;
	const duration = parseDurationMs(value);
	if (!duration) {
		ctx.ui.notify("Use a duration like 10m, 1h30m, 2 hours, or 1d.", "error");
		return undefined;
	}
	const nextRunAt = Date.now() + duration;
	if (kind === "interval") return { kind, nextRunAt, intervalMs: duration };
	return { kind, nextRunAt };
}

async function manageSchedule(ctx: ExtensionContext, controller: ScheduleController, id: string): Promise<boolean> {
	const item = controller.get(id);
	if (!item) {
		ctx.ui.notify("Schedule no longer exists.", "warning");
		return true;
	}

	const toggle = item.enabled ? "Pause" : "Resume";
	const action = await ctx.ui.select(scheduleTitle(item), ["Edit", "Run now", toggle, "Delete"]);
	if (!action) return true;

	switch (action) {
		case "Edit":
			await editSchedule(ctx, controller, id);
			return true;
		case "Pause":
		case "Resume":
			controller.toggle(ctx, id);
			ctx.ui.notify(item.enabled ? "Schedule paused" : "Schedule resumed", "info");
			return true;
		case "Run now":
			controller.runNow(ctx, id);
			return false;
		case "Delete":
			controller.delete(ctx, id);
			ctx.ui.notify("Schedule deleted", "info");
			return true;
	}
	return false;
}

async function editSchedule(ctx: ExtensionContext, controller: ScheduleController, id: string): Promise<void> {
	for (;;) {
		const item = controller.get(id);
		if (!item) {
			ctx.ui.notify("Schedule no longer exists.", "warning");
			return;
		}

		const action = await ctx.ui.select(`Edit ${scheduleTitle(item)}`, editOptions(item));
		if (!action || action === EDIT_DONE) return;

		if (action.startsWith(EDIT_TIMING)) {
			await editTiming(ctx, controller, item);
		} else if (action.startsWith(EDIT_PROMPT)) {
			await editPrompt(ctx, controller, item);
		} else if (action.startsWith(EDIT_BUSY)) {
			await editDelivery(ctx, controller, item);
		}
	}
}

async function editTiming(ctx: ExtensionContext, controller: ScheduleController, item: ScheduleItem): Promise<void> {
	const when = await ctx.ui.select("Timing", [WHEN_IN, WHEN_AT, WHEN_EVERY]);
	if (!when) return;
	const timing = await buildScheduleTiming(ctx, when);
	if (!timing) return;
	controller.updateTiming(ctx, item.id, timing);
	ctx.ui.notify("Schedule timing updated", "info");
}

async function editPrompt(ctx: ExtensionContext, controller: ScheduleController, item: ScheduleItem): Promise<void> {
	const prompt = await ctx.ui.input("Prompt", item.prompt);
	if (!prompt?.trim()) return;
	controller.updatePrompt(ctx, item.id, prompt.trim());
	ctx.ui.notify("Schedule prompt updated", "info");
}

async function editDelivery(ctx: ExtensionContext, controller: ScheduleController, item: ScheduleItem): Promise<void> {
	const selected = await ctx.ui.select("When the agent is busy", deliveryOptions(item.delivery));
	if (!selected) return;
	controller.updateDelivery(item.id, deliveryForChoice(selected));
	ctx.ui.notify("Schedule busy behavior updated", "info");
}

function deliveryForChoice(choice: string): ScheduleDelivery {
	return choice === BUSY_FOLLOW_UP ? "followUp" : "idle";
}

function scheduleTitle(item: ScheduleItem): string {
	const prompt = item.prompt.replace(/\s+/g, " ").trim();
	return prompt.length > 80 ? `${prompt.slice(0, 77)}...` : prompt;
}

function scheduleSummary(items: ScheduleItem[]): string {
	const active = items.filter((item) => item.enabled).length;
	return `${active} active schedule${active === 1 ? "" : "s"}`;
}

function editOptions(item: ScheduleItem): string[] {
	return [
		`${EDIT_TIMING}: ${timingDescription(item)}`,
		`${EDIT_PROMPT}: ${promptSummary(item.prompt)}`,
		`${EDIT_BUSY}: ${deliveryDescription(item.delivery)}`,
		EDIT_DONE,
	];
}

function timingDescription(item: ScheduleItem): string {
	const next = formatDueTime(item.nextRunAt);
	if (item.kind === "interval" && item.intervalMs !== undefined) return `every ${formatDuration(item.intervalMs)}, next ${next}`;
	return `next ${next}`;
}

function promptSummary(prompt: string): string {
	const text = prompt.replace(/\s+/g, " ").trim();
	if (text.length <= 40) return text || "(empty)";
	return `${text.slice(0, 37)}...`;
}

function deliveryDescription(delivery: ScheduleDelivery): string {
	return delivery === "followUp" ? BUSY_FOLLOW_UP : BUSY_IDLE;
}

function deliveryOptions(current: ScheduleDelivery): string[] {
	const options = [BUSY_IDLE, BUSY_FOLLOW_UP];
	const currentLabel = deliveryDescription(current);
	return [currentLabel, ...options.filter((option) => option !== currentLabel)];
}
