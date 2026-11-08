import type { Component } from "@earendil-works/pi-tui";
import { Input, truncateToWidth } from "@earendil-works/pi-tui";
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { ChoiceOption } from "./panel-types.js";
import type { ApprovalDecision, ApprovalResult } from "./approval.js";
import { choiceIndexForNumberKey } from "./number-shortcuts.js";

type ApprovalMode = "choice" | "deny-note";

export class ApprovalPromptView implements Component {
	private selectedIndex = 0;
	private mode: ApprovalMode = "choice";
	private readonly noteInput = new Input();

	constructor(
		private readonly theme: Theme,
		private readonly keybindings: KeybindingsManager,
		private readonly title: string,
		private readonly choices: ChoiceOption[],
		private readonly detailLines: string[],
		private readonly done: (result?: ApprovalResult) => void,
	) {
		this.noteInput.focused = true;
	}

	render(width: number): string[] {
		if (this.mode === "deny-note") return this.renderDenyNote(width);
		return this.renderChoices(width);
	}

	invalidate(): void {
		this.noteInput.invalidate();
	}

	handleInput(data: string): void {
		if (this.mode === "deny-note") {
			if (this.keybindings.matches(data, "tui.select.cancel")) {
				this.mode = "choice";
				return;
			}
			if (this.keybindings.matches(data, "tui.select.confirm")) {
				this.done({ choice: "deny", note: noteValue(this.noteInput.getValue()) });
				return;
			}
			this.noteInput.handleInput(data);
			return;
		}

		if (this.keybindings.matches(data, "tui.select.up")) {
			this.selectedIndex = this.selectedIndex === 0 ? this.choices.length - 1 : this.selectedIndex - 1;
			return;
		}
		if (this.keybindings.matches(data, "tui.select.down")) {
			this.selectedIndex = this.selectedIndex === this.choices.length - 1 ? 0 : this.selectedIndex + 1;
			return;
		}
		const numberChoice = choiceIndexForNumberKey(data, this.choices.length);
		if (numberChoice !== undefined) {
			this.selectedIndex = numberChoice;
			const choice = this.selectedChoice()?.value;
			this.done(isApprovalChoice(choice) ? { choice } : undefined);
			return;
		}
		if (this.keybindings.matches(data, "tui.input.tab") && this.selectedChoice()?.value === "deny") {
			this.mode = "deny-note";
			return;
		}
		if (this.keybindings.matches(data, "tui.select.confirm")) {
			const choice = this.selectedChoice()?.value;
			this.done(isApprovalChoice(choice) ? { choice } : undefined);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.done({ choice: "interrupt" });
		}
	}

	private renderChoices(width: number): string[] {
		const output = [this.theme.bold(this.theme.fg("accent", this.title)), ""];
		for (const line of this.detailLines) {
			output.push(truncateToWidth(this.theme.fg("dim", `  ${line}`), width, ""));
		}
		if (this.detailLines.length > 0) output.push("");

		for (let index = 0; index < this.choices.length; index += 1) {
			const choice = this.choices[index];
			if (!choice) continue;
			const selected = index === this.selectedIndex;
			const number = index < 9 ? `${index + 1}. ` : "   ";
			const prefix = selected ? this.theme.fg("accent", `› ${number}`) : `  ${number}`;
			const text = selected ? this.theme.bold(choice.label) : choice.label;
			output.push(truncateToWidth(`${prefix}${text}`, width, ""));
			if (selected && choice.description) {
				output.push(truncateToWidth(this.theme.fg("dim", `  ${choice.description}`), width, ""));
			}
		}

		output.push("");
		const canAddNote = this.selectedChoice()?.value === "deny";
		output.push(this.theme.fg("dim", canAddNote ? "  Enter to select, Tab to add deny note, Esc to interrupt" : "  Enter to select, Esc to interrupt"));
		return output;
	}

	private renderDenyNote(width: number): string[] {
		const output = [this.theme.bold(this.theme.fg("accent", "Deny with note")), ""];
		output.push(this.theme.fg("dim", "  Optional note for the agent:"));
		output.push(...this.noteInput.render(width).map((line) => truncateToWidth(`  ${line}`, width, "")));
		output.push("");
		output.push(this.theme.fg("dim", "  Enter to deny, Esc to go back"));
		return output;
	}

	private selectedChoice(): ChoiceOption | undefined {
		return this.choices[this.selectedIndex];
	}
}

function isApprovalChoice(value: string | undefined): value is ApprovalDecision {
	return value === "allow_once" || value === "allow_session" || value === "allow_workspace" || value === "deny";
}

function noteValue(value: string): string | undefined {
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}
