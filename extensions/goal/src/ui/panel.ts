import { DynamicBorder, getSettingsListTheme, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, SettingsList, Spacer, Text, type Component, type TUI } from "@earendil-works/pi-tui";
import { panelSummary } from "./panel-format.js";
import { goalPanelItems, updateGoalPanelValues } from "./panel-items.js";
import type { GoalPanelAction, GoalPanelCallbacks, GoalPanelModel } from "./panel-types.js";
import { BudgetEditView, DetailView, ObjectiveEditView } from "./panel-views.js";

export class GoalPanel extends Container {
	private readonly settingsList: SettingsList;
	private readonly summaryText: Text;

	constructor(
		private readonly tui: TUI,
		private readonly panelTheme: Theme,
		private readonly keybindings: KeybindingsManager,
		private readonly getModel: () => GoalPanelModel,
		private readonly callbacks: GoalPanelCallbacks,
	) {
		super();

		this.addChild(new DynamicBorder((text) => panelTheme.fg("border", text)));
		this.addChild(new Text(panelTheme.bold(panelTheme.fg("accent", this.title())), 0, 0));
		this.summaryText = new Text(panelTheme.fg("dim", panelSummary(this.getModel())), 0, 0);
		this.addChild(this.summaryText);
		this.addChild(new Spacer(1));

		this.settingsList = new SettingsList(
			goalPanelItems(this.getModel(), this.views()),
			12,
			getSettingsListTheme(),
			(id) => this.handleAction(id),
			() => callbacks.onAction({ type: "close" }),
		);
		this.addChild(this.settingsList);
		this.addChild(new DynamicBorder((text) => panelTheme.fg("border", text)));
	}

	handleInput(data: string): void {
		this.settingsList.handleInput(data);
	}

	private handleAction(id: string): void {
		const action = actionForId(id);
		if (action) this.callbacks.onAction(action);
	}

	private refresh(): void {
		this.summaryText.setText(this.panelTheme.fg("dim", panelSummary(this.getModel())));
		updateGoalPanelValues(this.settingsList, this.getModel());
	}

	private views(): {
		detail: (title: string, lines: string[], done: () => void) => Component;
		budget: (done: (selectedValue?: string) => void) => Component;
		objective: (title: string, done: (selectedValue?: string) => void) => Component;
	} {
		return {
			detail: (title, lines, done) => new DetailView(this.panelTheme, this.keybindings, title, lines, done),
			budget: (done) =>
				new BudgetEditView(this.panelTheme, this.keybindings, this.currentBudget(), (selectedValue) => {
					if (selectedValue !== undefined) {
						this.updateBudget(selectedValue === "clear" ? undefined : Number(selectedValue));
						this.refresh();
					}
					done();
				}),
			objective: (title, done) =>
				new ObjectiveEditView(this.tui, this.keybindings, title, this.currentObjective(), (selectedValue) => {
					if (selectedValue !== undefined) {
						this.updateObjective(selectedValue);
						this.refresh();
					}
					done();
				}),
		};
	}

	private title(): string {
		const mode = this.getModel().mode;
		return mode.type === "setup" ? mode.title : "Goal";
	}

	private currentObjective(): string {
		const model = this.getModel();
		if (model.mode.type === "setup") return model.mode.draft.objective;
		return model.goal?.objective ?? "";
	}

	private currentBudget(): number | undefined {
		const model = this.getModel();
		if (model.mode.type === "setup") return model.mode.draft.tokenBudget;
		return model.goal?.tokenBudget;
	}

	private updateObjective(objective: string): void {
		const model = this.getModel();
		if (model.mode.type !== "setup") return;
		this.callbacks.onDraftChange({ ...model.mode.draft, objective });
	}

	private updateBudget(tokenBudget: number | undefined): void {
		const model = this.getModel();
		if (model.mode.type === "setup") {
			this.callbacks.onDraftChange({ ...model.mode.draft, tokenBudget });
			return;
		}
		this.callbacks.onBudgetChange(tokenBudget);
	}
}

function actionForId(id: string): GoalPanelAction | undefined {
	switch (id) {
		case "new":
			return { type: "new" };
		case "replace":
			return { type: "replace" };
		case "save-draft":
			return { type: "save-draft" };
		case "pause":
			return { type: "pause" };
		case "resume":
			return { type: "resume" };
		case "clear-budget":
			return { type: "clear-budget" };
		case "clear":
			return { type: "clear" };
		case "close":
			return { type: "close" };
		default:
			return undefined;
	}
}
