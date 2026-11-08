import { DynamicBorder, getSettingsListTheme, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Container,
	Spacer,
	SettingsList,
	Text,
} from "@earendil-works/pi-tui";
import type { ContainmentMode, EnvironmentMode, NetworkMode, ReinsMode, SafetyProfileName } from "../config/types.js";
import type { ChoiceOption, SafetyPanelCallbacks, SafetyPanelModel } from "./panel-types.js";
import { ChoiceView, DetailView } from "./panel-views.js";
import { panelSummary } from "./panel-format.js";
import { safetyPanelItems, updateSafetyPanelValues } from "./panel-items.js";

export class SafetyPanel extends Container {
	private readonly settingsList: SettingsList;
	private readonly summaryText: Text;

	constructor(
		private readonly panelTheme: Theme,
		private readonly keybindings: KeybindingsManager,
		private readonly getModel: () => SafetyPanelModel,
		private readonly callbacks: SafetyPanelCallbacks,
	) {
		super();

		this.addChild(new DynamicBorder((text) => panelTheme.fg("border", text)));
		this.addChild(new Text(panelTheme.bold(panelTheme.fg("accent", "Safety")), 0, 0));
		this.summaryText = new Text(panelTheme.fg("dim", this.summaryLine()), 0, 0);
		this.addChild(this.summaryText);
		this.addChild(new Spacer(1));

		this.settingsList = new SettingsList(
			safetyPanelItems(this.getModel(), this.views()),
			14,
			getSettingsListTheme(),
			(id, newValue) => this.handleChange(id, newValue),
			callbacks.onCancel,
		);
		this.addChild(this.settingsList);
		this.addChild(new DynamicBorder((text) => panelTheme.fg("border", text)));
	}

	handleInput(data: string): void {
		this.settingsList.handleInput(data);
	}

	private handleChange(id: string, newValue: string): void {
		switch (id) {
			case "enabled":
				this.callbacks.onEnabledChange(newValue === "true");
				break;
			case "profile":
				this.callbacks.onProfileChange(newValue as SafetyProfileName);
				break;
			case "reins":
				this.callbacks.onReinsModeChange(newValue as ReinsMode);
				break;
			case "containment":
				this.callbacks.onContainmentModeChange(newValue as ContainmentMode);
				break;
			case "network":
				this.callbacks.onNetworkChange(newValue as NetworkMode);
				break;
			case "environment":
				this.callbacks.onEnvironmentChange(newValue as EnvironmentMode);
				break;
			case "approvals":
				this.callbacks.onForgetApproval(newValue);
				break;
			case "save-approvals":
				this.callbacks.onSaveSessionApprovals();
				break;
			case "close":
				this.callbacks.onCancel();
				break;
		}
		this.refreshValues();
	}

	private refreshValues(): void {
		this.summaryText.setText(this.panelTheme.fg("dim", this.summaryLine()));
		updateSafetyPanelValues(this.settingsList, this.getModel());
	}

	private views(): {
		detail: (title: string, lines: string[], done: () => void) => Component;
		choice: (title: string, choices: ChoiceOption[], done: (selectedValue?: string) => void, initialValue?: string) => Component;
	} {
		return {
			detail: (title, lines, done) => new DetailView(this.panelTheme, this.keybindings, title, lines, done),
			choice: (title, choices, done, initialValue) =>
				new ChoiceView(this.panelTheme, this.keybindings, title, choices, done, initialValue),
		};
	}

	private summaryLine(): string {
		return panelSummary(this.getModel());
	}
}
