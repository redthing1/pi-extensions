import { ExtensionEditorComponent, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import {
	Input,
	truncateToWidth,
	type Component,
	type TUI,
} from "@earendil-works/pi-tui";
import { parseTokenBudget } from "../format.js";

const MAX_DETAIL_LINES = 12;

export class DetailView implements Component {
	private selectedIndex = 0;

	constructor(
		private readonly theme: Theme,
		private readonly keybindings: KeybindingsManager,
		private readonly title: string,
		private readonly lines: string[],
		private readonly done: () => void,
	) {}

	invalidate(): void {}

	render(width: number): string[] {
		const output = [this.theme.bold(this.theme.fg("accent", this.title)), ""];
		for (const line of this.visibleLines()) {
			if (line.value.length === 0) {
				output.push("");
				continue;
			}
			const selected = this.lines.length > MAX_DETAIL_LINES && line.index === this.selectedIndex;
			const prefix = selected ? this.theme.fg("accent", "> ") : "  ";
			const text = selected ? this.theme.bold(line.value) : line.value;
			output.push(truncateToWidth(`${prefix}${text}`, width, ""));
		}
		if (this.lines.length > MAX_DETAIL_LINES) {
			output.push(this.theme.fg("dim", `  (${this.selectedIndex + 1}/${this.lines.length})`));
		}
		output.push("");
		output.push(this.theme.fg("dim", this.lines.length > MAX_DETAIL_LINES ? "  Up/Down scrolls, Enter/Esc goes back" : "  Enter/Esc to go back"));
		return output;
	}

	handleInput(data: string): void {
		if (this.lines.length > MAX_DETAIL_LINES) {
			if (this.keybindings.matches(data, "tui.select.up")) {
				this.selectedIndex = wrapIndex(this.selectedIndex - 1, this.lines.length);
				return;
			}
			if (this.keybindings.matches(data, "tui.select.down")) {
				this.selectedIndex = wrapIndex(this.selectedIndex + 1, this.lines.length);
				return;
			}
			if (this.keybindings.matches(data, "tui.select.pageUp")) {
				this.selectedIndex = wrapIndex(this.selectedIndex - MAX_DETAIL_LINES, this.lines.length);
				return;
			}
			if (this.keybindings.matches(data, "tui.select.pageDown")) {
				this.selectedIndex = wrapIndex(this.selectedIndex + MAX_DETAIL_LINES, this.lines.length);
				return;
			}
		}
		if (this.keybindings.matches(data, "tui.select.confirm") || this.keybindings.matches(data, "tui.select.cancel")) this.done();
	}

	private visibleLines(): Array<{ index: number; value: string }> {
		if (this.lines.length <= MAX_DETAIL_LINES) {
			return this.lines.map((value, index) => ({ index, value }));
		}
		const half = Math.floor(MAX_DETAIL_LINES / 2);
		const start = this.selectedIndex - half;
		return Array.from({ length: MAX_DETAIL_LINES }, (_value, offset) => {
			const index = wrapIndex(start + offset, this.lines.length);
			return { index, value: this.lines[index] ?? "" };
		});
	}
}

export class ObjectiveEditView implements Component {
	private readonly editor: ExtensionEditorComponent;

	constructor(
		tui: TUI,
		keybindings: KeybindingsManager,
		title: string,
		initialValue: string,
		done: (selectedValue?: string) => void,
	) {
		this.editor = new ExtensionEditorComponent(
			tui,
			keybindings,
			title,
			initialValue,
			(value) => done(value),
			() => done(),
		);
		this.editor.focused = true;
	}

	invalidate(): void {
		this.editor.invalidate();
	}

	render(width: number): string[] {
		return this.editor.render(width);
	}

	handleInput(data: string): void {
		this.editor.handleInput(data);
	}
}

export class BudgetEditView implements Component {
	private readonly input = new Input();
	private error: string | undefined;

	constructor(
		private readonly theme: Theme,
		private readonly keybindings: KeybindingsManager,
		private readonly currentBudget: number | undefined,
		private readonly done: (selectedValue?: string) => void,
	) {
		this.input.setValue(currentBudget === undefined ? "" : String(currentBudget));
		this.input.focused = true;
		this.input.onSubmit = () => this.submit();
		this.input.onEscape = () => this.done();
	}

	invalidate(): void {
		this.input.invalidate();
	}

	render(width: number): string[] {
		const output = [
			this.theme.bold(this.theme.fg("accent", "Token Budget")),
			"",
			this.theme.fg("dim", "  Empty, none, off, or clear removes the budget."),
			...this.input.render(width),
		];
		if (this.error) {
			output.push("", this.theme.fg("error", `  ${this.error}`));
		}
		output.push("", this.theme.fg("dim", "  Enter to save, Esc to go back"));
		return output;
	}

	handleInput(data: string): void {
		if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.done();
			return;
		}
		this.error = undefined;
		this.input.handleInput(data);
	}

	private submit(): void {
		const value = this.input.getValue().trim();
		if (!value || ["clear", "none", "off"].includes(value.toLowerCase())) {
			this.done("clear");
			return;
		}
		try {
			this.done(String(parseTokenBudget(value)));
		} catch (error) {
			this.error = error instanceof Error ? error.message : String(error);
		}
	}
}

function wrapIndex(index: number, length: number): number {
	return ((index % length) + length) % length;
}
