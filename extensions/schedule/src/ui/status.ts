import type { Theme } from "@earendil-works/pi-coding-agent";
import { formatDueTime } from "../time.js";
import type { ScheduleItem } from "../types.js";

export function scheduleStatusLine(items: ScheduleItem[], theme?: Theme): string | undefined {
	const enabled = items.filter((item) => item.enabled);
	if (enabled.length === 0) return undefined;

	const next = Math.min(...enabled.map((item) => item.nextRunAt));
	const text = `sched ${enabled.length} next ${formatDueTime(next)}`;
	return theme ? theme.fg("accent", text) : text;
}
