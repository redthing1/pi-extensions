export const SCHEDULE_STATE_ENTRY = "schedule.state";

export type ScheduleKind = "once" | "interval";
export type ScheduleDelivery = "idle" | "followUp";

export interface ScheduleItem {
	id: string;
	kind: ScheduleKind;
	enabled: boolean;
	prompt: string;
	nextRunAt: number;
	createdAt: number;
	delivery: ScheduleDelivery;
	intervalMs?: number;
	lastRunAt?: number;
}

export interface ScheduleState {
	items: ScheduleItem[];
	nextId: number;
}

export interface ScheduleStateEntry {
	version: 1;
	state: ScheduleState;
	reason: string;
	writtenAt: number;
}

export interface ScheduleEntryWriter {
	appendEntry<T = unknown>(customType: string, data?: T): void;
}

export type SchedulePanelAction =
	| { type: "new" }
	| { type: "close" }
	| { type: "manage"; id: string };
