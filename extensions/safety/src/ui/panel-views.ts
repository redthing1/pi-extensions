import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { ChoiceOption } from "./panel-types.js";

const MAX_DETAIL_LINES = 14;

export class DetailView implements Component {
	private selectedIndex = 0;

	constructor(
		private readonly theme: Theme,
		private readonly keybindings: KeybindingsManager,
		private readonly title: string,
		private readonly lines: string[],
		private readonly done: () => void,
	) {}

	render(width: number): string[] {
		const output = [this.theme.bold(this.theme.fg("accent", this.title)), ""];
		const visible = this.visibleLines();
		for (const line of visible) {
			if (line.value.length === 0) {
				output.push("");
				continue;
			}
			const isSelected = this.lines.length > MAX_DETAIL_LINES && line.index === this.selectedIndex;
			const prefix = isSelected ? this.theme.fg("accent", "› ") : "  ";
			const text = isSelected ? this.theme.bold(line.value) : line.value;
			output.push(truncateToWidth(`${prefix}${text}`, width, ""));
		}
		if (this.lines.length > MAX_DETAIL_LINES) {
			output.push(this.theme.fg("dim", `  (${this.selectedIndex + 1}/${this.lines.length})`));
		}
		output.push("");
		output.push(this.theme.fg("dim", this.lines.length > MAX_DETAIL_LINES ? "  Up/Down scrolls, Enter/Esc goes back" : "  Enter/Esc to go back"));
		return output;
	}

	invalidate(): void {}

	handleInput(data: string): void {
		if (this.lines.length > MAX_DETAIL_LINES) {
			if (this.keybindings.matches(data, "tui.select.up")) {
				this.selectedIndex = this.selectedIndex === 0 ? this.lines.length - 1 : this.selectedIndex - 1;
				return;
			}
			if (this.keybindings.matches(data, "tui.select.down")) {
				this.selectedIndex = this.selectedIndex === this.lines.length - 1 ? 0 : this.selectedIndex + 1;
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
		if (this.keybindings.matches(data, "tui.select.confirm") || this.keybindings.matches(data, "tui.select.cancel")) {
			this.done();
		}
	}

	private visibleLines(): Array<{ index: number; value: string }> {
		if (this.lines.length <= MAX_DETAIL_LINES) {
			return this.lines.map((value, index) => ({ index, value }));
		}
		const half = Math.floor(MAX_DETAIL_LINES / 2);
		const start = this.selectedIndex - half;
		return Array.from({ length: MAX_DETAIL_LINES }, (_, offset) => {
			const index = wrapIndex(start + offset, this.lines.length);
			return { index, value: this.lines[index] ?? "" };
		});
	}
}

export class ChoiceView implements Component {
	private selectedIndex = 0;

	constructor(
		private readonly theme: Theme,
		private readonly keybindings: KeybindingsManager,
		private readonly title: string,
		private readonly choices: ChoiceOption[],
		private readonly done: (choice?: string) => void,
		initialValue?: string,
		private readonly detailLines: string[] = [],
	) {
		const selected = initialValue ? choices.findIndex((choice) => choice.value === initialValue) : -1;
		if (selected >= 0) this.selectedIndex = selected;
	}

	render(width: number): string[] {
		if (this.choices.length === 0) {
			return new DetailView(this.theme, this.keybindings, this.title, ["none"], () => this.done()).render(width);
		}

		const output = [this.theme.bold(this.theme.fg("accent", this.title)), ""];
		for (const line of this.detailLines) {
			output.push(truncateToWidth(this.theme.fg("dim", `  ${line}`), width, ""));
		}
		if (this.detailLines.length > 0) output.push("");
		for (let index = 0; index < this.choices.length; index += 1) {
			const choice = this.choices[index];
			if (!choice) continue;
			const selected = index === this.selectedIndex;
			const prefix = selected ? this.theme.fg("accent", "› ") : "  ";
			const text = selected ? this.theme.bold(choice.label) : choice.label;
			output.push(truncateToWidth(`${prefix}${text}`, width, ""));
			if (selected && choice.description) {
				output.push(truncateToWidth(this.theme.fg("dim", `  ${choice.description}`), width, ""));
			}
		}
		output.push("");
		output.push(this.theme.fg("dim", "  Enter to select, Esc to go back"));
		return output;
	}

	invalidate(): void {}

	handleInput(data: string): void {
		if (this.choices.length === 0) {
			if (this.keybindings.matches(data, "tui.select.confirm") || this.keybindings.matches(data, "tui.select.cancel")) {
				this.done();
			}
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
		if (this.keybindings.matches(data, "tui.select.confirm")) {
			this.done(this.choices[this.selectedIndex]?.value);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.done();
		}
	}
}

function wrapIndex(index: number, length: number): number {
	return ((index % length) + length) % length;
}
