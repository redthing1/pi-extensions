import { DynamicBorder, getSettingsListTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, SettingsList, Spacer, Text, type TUI } from "@earendil-works/pi-tui";
import { formatDueTime, formatDuration } from "../time.js";
import type { ScheduleItem, SchedulePanelAction } from "../types.js";

export class SchedulePanel extends Container {
	private readonly list: SettingsList;

	constructor(
		private readonly tui: TUI,
		private readonly panelTheme: Theme,
		private readonly items: ScheduleItem[],
		private readonly onAction: (action: SchedulePanelAction) => void,
	) {
		super();
		this.addChild(new DynamicBorder((text) => panelTheme.fg("border", text)));
		this.addChild(new Text(panelTheme.bold(panelTheme.fg("accent", "Schedule")), 0, 0));
		this.addChild(new Text(panelTheme.fg("dim", summary(items)), 0, 0));
		this.addChild(new Spacer(1));

		this.list = new SettingsList(
			panelItems(items),
			12,
			getSettingsListTheme(),
			(id) => this.handleItem(id),
			() => onAction({ type: "close" }),
		);
		this.addChild(this.list);
		this.addChild(new DynamicBorder((text) => panelTheme.fg("border", text)));
	}

	handleInput(data: string): void {
		this.list.handleInput(data);
		this.tui.requestRender();
	}

	private handleItem(id: string): void {
		if (id === "new") {
			this.onAction({ type: "new" });
			return;
		}
		this.onAction({ type: "manage", id });
	}
}

function panelItems(items: ScheduleItem[]) {
	const rows = [
		{
			id: "new",
			label: "New schedule",
			currentValue: "",
			values: ["open"],
			description: "Create a one-shot or recurring scheduled prompt.",
		},
	];

	for (const item of items) {
		rows.push({
			id: item.id,
			label: itemLabel(item),
			currentValue: itemValue(item),
			values: ["open"],
			description: item.prompt,
		});
	}

	return rows;
}

function summary(items: ScheduleItem[]): string {
	const enabled = items.filter((item) => item.enabled);
	if (enabled.length === 0) return "No active schedules";
	const next = Math.min(...enabled.map((item) => item.nextRunAt));
	return `${enabled.length} active, next ${formatDueTime(next)}`;
}

function itemLabel(item: ScheduleItem): string {
	const prefix = item.enabled ? "" : "paused ";
	const text = item.prompt.replace(/\s+/g, " ").trim();
	return `${prefix}${text || "(empty prompt)"}`;
}

function itemValue(item: ScheduleItem): string {
	const due = item.enabled ? formatDueTime(item.nextRunAt) : "paused";
	if (item.kind === "interval" && item.intervalMs !== undefined) return `${due} / ${formatDuration(item.intervalMs)}`;
	return due;
}
