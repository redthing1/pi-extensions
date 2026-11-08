import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	SCHEDULE_STATE_ENTRY,
	type ScheduleEntryWriter,
	type ScheduleItem,
	type ScheduleState,
	type ScheduleStateEntry,
} from "./types.js";

export function emptyScheduleState(): ScheduleState {
	return {
		items: [],
		nextId: 1,
	};
}

export function restoreScheduleState(ctx: ExtensionContext): ScheduleState {
	let restored = emptyScheduleState();

	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== SCHEDULE_STATE_ENTRY) continue;
		const parsed = parseScheduleStateEntry(entry.data);
		if (parsed) restored = cloneState(parsed.state);
	}

	return restored;
}

export function persistScheduleState(
	writer: ScheduleEntryWriter,
	state: ScheduleState,
	reason: string,
	now = Date.now(),
): void {
	const entry: ScheduleStateEntry = {
		version: 1,
		state: cloneState(state),
		reason,
		writtenAt: now,
	};
	writer.appendEntry(SCHEDULE_STATE_ENTRY, entry);
}

export function cloneState(state: ScheduleState): ScheduleState {
	return {
		items: state.items.map(cloneItem),
		nextId: state.nextId,
	};
}

export function cloneItem(item: ScheduleItem): ScheduleItem {
	return { ...item };
}

function parseScheduleStateEntry(value: unknown): ScheduleStateEntry | undefined {
	if (!value || typeof value !== "object") return undefined;
	const entry = value as Partial<ScheduleStateEntry>;
	if (entry.version !== 1 || !isScheduleState(entry.state)) return undefined;
	return {
		version: 1,
		state: cloneState(entry.state),
		reason: typeof entry.reason === "string" ? entry.reason : "",
		writtenAt: typeof entry.writtenAt === "number" ? entry.writtenAt : 0,
	};
}

function isScheduleState(value: unknown): value is ScheduleState {
	if (!value || typeof value !== "object") return false;
	const state = value as Partial<ScheduleState>;
	return (
		Array.isArray(state.items) &&
		state.items.every(isScheduleItem) &&
		typeof state.nextId === "number" &&
		Number.isSafeInteger(state.nextId) &&
		state.nextId > 0
	);
}

function isScheduleItem(value: unknown): value is ScheduleItem {
	if (!value || typeof value !== "object") return false;
	const item = value as Partial<ScheduleItem>;
	return (
		typeof item.id === "string" &&
		(item.kind === "once" || item.kind === "interval") &&
		typeof item.enabled === "boolean" &&
		typeof item.prompt === "string" &&
		typeof item.nextRunAt === "number" &&
		typeof item.createdAt === "number" &&
		(item.delivery === "idle" || item.delivery === "followUp") &&
		(item.intervalMs === undefined || typeof item.intervalMs === "number") &&
		(item.lastRunAt === undefined || typeof item.lastRunAt === "number")
	);
}
