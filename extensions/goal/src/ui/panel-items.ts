import type { Component, SettingItem, SettingsList } from "@earendil-works/pi-tui";
import {
	budgetValue,
	draftBudgetValue,
	goalDetails,
	objectiveDetails,
	objectiveDraftSummary,
	objectiveSummary,
	statusValue,
	usageValue,
} from "./panel-format.js";
import type { GoalDraft } from "./panel-types.js";
import type { GoalPanelModel } from "./panel-types.js";

export interface GoalPanelViews {
	detail(title: string, lines: string[], done: () => void): Component;
	budget(done: (selectedValue?: string) => void): Component;
	objective(title: string, done: (selectedValue?: string) => void): Component;
}

export function goalPanelItems(model: GoalPanelModel, views: GoalPanelViews): SettingItem[] {
	if (model.mode.type === "setup") {
		return setupPanelItems(model.mode.submitLabel, model.mode.draft, views);
	}

	const goal = model.goal;
	if (!goal) {
		return [
			{
				id: "new",
				label: "New goal",
				description: "Set an objective and start looping.",
				currentValue: "",
				values: ["open"],
			},
			{ id: "close", label: "Close", description: "Close the Goal panel.", currentValue: "", values: ["close"] },
		];
	}

	const items: SettingItem[] = [
		{
			id: "status",
			label: "Status",
			description: "Current goal status and loop state.",
			currentValue: statusValue(goal),
			submenu: (_currentValue, done) => views.detail("Goal", goalDetails(goal), done),
		},
		{
			id: "objective",
			label: "Objective",
			description: "The user-provided goal objective.",
			currentValue: objectiveSummary(goal),
			submenu: (_currentValue, done) => views.detail("Objective", objectiveDetails(goal), done),
		},
		{
			id: "usage",
			label: "Usage",
			description: "Elapsed time and non-cached token usage accounted to the goal.",
			currentValue: usageValue(goal),
			submenu: (_currentValue, done) => views.detail("Usage", goalDetails(goal), done),
		},
		{
			id: "budget",
			label: "Budget",
			description: "Set or raise a token budget.",
			currentValue: budgetValue(goal),
			submenu: (_currentValue, done) => views.budget(done),
		},
	];

	if (goal.tokenBudget !== undefined) {
		items.push({
			id: "clear-budget",
			label: "Clear budget",
			description: "Remove the token budget. Budget-limited goals become paused.",
			currentValue: "",
			values: ["open"],
		});
	}

	if (goal.status === "active" && goal.continuationErrorAt !== undefined) {
		items.push({ id: "resume", label: "Resume", description: "Clear the provider error and resume automatic continuation.", currentValue: "", values: ["open"] });
	} else if (goal.status === "active") {
		items.push({ id: "pause", label: "Pause", description: "Stop automatic continuation.", currentValue: "", values: ["open"] });
	} else if (goal.status === "paused" || goal.status === "blocked" || goal.status === "budget_limited") {
		items.push({ id: "resume", label: "Resume", description: "Resume automatic continuation if the budget allows it.", currentValue: "", values: ["open"] });
	}

	items.push(
		{
			id: "replace",
			label: "Replace",
			description: "Set a new objective and reset usage accounting.",
			currentValue: "",
			values: ["open"],
		},
		{
			id: "clear",
			label: "Clear",
			description: "Remove this goal from the session.",
			currentValue: "",
			values: ["open"],
		},
		{ id: "close", label: "Close", description: "Close the Goal panel.", currentValue: "", values: ["close"] },
	);

	return items;
}

function setupPanelItems(
	submitLabel: string,
	draft: GoalDraft,
	views: GoalPanelViews,
): SettingItem[] {
	return [
		{
			id: "draft-objective",
			label: "Objective",
			description: "Edit the objective to pursue.",
			currentValue: objectiveDraftSummary(draft),
			submenu: (_currentValue, done) => views.objective("Objective", done),
		},
		{
			id: "draft-budget",
			label: "Budget",
			description: "Optional token budget. Empty, none, off, or clear removes it.",
			currentValue: draftBudgetValue(draft),
			submenu: (_currentValue, done) => views.budget(done),
		},
		{
			id: "save-draft",
			label: submitLabel,
			description: "Save this goal and start looping.",
			currentValue: "",
			values: ["open"],
		},
		{ id: "close", label: "Cancel", description: "Close without saving.", currentValue: "", values: ["close"] },
	];
}

export function updateGoalPanelValues(settingsList: SettingsList, model: GoalPanelModel): void {
	if (model.mode.type === "setup") {
		settingsList.updateValue("draft-objective", objectiveDraftSummary(model.mode.draft));
		settingsList.updateValue("draft-budget", draftBudgetValue(model.mode.draft));
		return;
	}
	const goal = model.goal;
	if (!goal) return;
	settingsList.updateValue("status", statusValue(goal));
	settingsList.updateValue("objective", objectiveSummary(goal));
	settingsList.updateValue("usage", usageValue(goal));
	settingsList.updateValue("budget", budgetValue(goal));
}
