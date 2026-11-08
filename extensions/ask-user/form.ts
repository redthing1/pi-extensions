import type {
	KeybindingsManager as AppKeybindings,
	Theme,
} from "@earendil-works/pi-coding-agent";
import {
	CURSOR_MARKER,
	Editor,
	KeybindingsManager,
	TUI_KEYBINDINGS,
	safeTerminalText as displayText,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
	type Focusable,
	type Keybinding,
	type TUI,
} from "@earendil-works/pi-tui";
export { displayText };

declare module "@earendil-works/pi-tui" {
	interface Keybindings {
		"extension.askUser.previous": true;
		"extension.askUser.next": true;
		"extension.askUser.edit": true;
	}
}
const FORM_KEYS = {
	"extension.askUser.previous": { defaultKeys: "shift+tab" as const },
	"extension.askUser.next": { defaultKeys: "tab" as const },
	"extension.askUser.edit": { defaultKeys: "ctrl+e" as const },
};
export interface Question {
	label?: string;
	question: string;
	options?: { label: string; description?: string }[];
}
export interface Answer {
	question: string;
	answer: string;
}
export type FormResult =
	| { status: "answered"; answers: Answer[] }
	| { status: "cancelled" }
	| { status: "discuss"; question: string };
interface Draft {
	cursor: number;
	text: string;
	confirmed: boolean;
}

export class QuestionForm implements Component, Focusable {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keys: KeybindingsManager;
	private readonly questions: Question[];
	private readonly done: (result: FormResult) => void;
	private readonly editor: Editor;
	private readonly drafts: Draft[];
	private current = 0;
	private editing = false;
	private isFocused = false;
	private closed = false;
	private offset = 0;
	private maxOffset = 0;
	private reveal = false;

	constructor(
		tui: TUI,
		theme: Theme,
		keys: AppKeybindings,
		questions: Question[],
		done: (result: FormResult) => void,
	) {
		this.tui = tui;
		this.theme = theme;
		this.keys = new KeybindingsManager(
			{ ...TUI_KEYBINDINGS, ...FORM_KEYS },
			keys.getUserBindings(),
		);
		this.questions = questions;
		this.done = done;
		this.drafts = questions.map(() => ({
			cursor: 0,
			text: "",
			confirmed: false,
		}));
		this.editor = new Editor(tui, {
			borderColor: (s) => theme.fg("muted", s),
			selectList: {
				selectedPrefix: (s) => theme.fg("accent", s),
				selectedText: (s) => theme.fg("accent", s),
				description: (s) => theme.fg("muted", s),
				scrollInfo: (s) => theme.fg("dim", s),
				noMatch: (s) => theme.fg("muted", s),
			},
		});
		this.editor.onChange = () => {
			if (!this.editing) return;
			const draft = this.drafts[this.current];
			const text = this.editor.getExpandedText();
			if (draft.text !== text) {
				draft.text = text;
				draft.confirmed = false;
			}
		};
		this.editor.onSubmit = (text) => this.answer(text);
		this.openTextQuestion();
	}
	get focused(): boolean {
		return this.isFocused;
	}
	set focused(value: boolean) {
		this.isFocused = value;
		this.editor.focused = value && this.editing;
	}
	invalidate(): void {
		this.editor.invalidate();
	}
	cancel(): void {
		this.finish({ status: "cancelled" });
	}
	private finish(result: FormResult): void {
		if (this.closed) return;
		this.closed = true;
		this.done(result);
	}
	private openTextQuestion(): void {
		if (
			this.current < this.questions.length &&
			!this.questions[this.current].options?.length
		)
			this.edit(this.drafts[this.current].text);
	}
	private edit(text: string): void {
		this.drafts[this.current].cursor =
			this.questions[this.current].options?.length ?? 0;
		this.editing = true;
		this.editor.setText(displayText(text));
		this.editor.focused = this.isFocused;
		this.reveal = true;
		this.tui.requestRender();
	}
	private answer(text: string): void {
		if (!text.trim()) return;
		const draft = this.drafts[this.current];
		draft.text = text.trim();
		draft.confirmed = true;
		const options = this.questions[this.current].options ?? [];
		const selected = options.findIndex((option) => option.label === draft.text);
		draft.cursor = selected < 0 ? options.length : selected;
		this.navigate(1);
	}
	private submit(): void {
		const missing = this.drafts.findIndex((draft) => !draft.confirmed);
		if (missing >= 0) {
			this.navigate(missing - this.current);
			return;
		}
		this.finish({
			status: "answered",
			answers: this.questions.map((q, i) => ({
				question: q.question,
				answer: this.drafts[i].text,
			})),
		});
	}
	private navigate(delta: number): void {
		this.editing = false;
		this.editor.focused = false;
		this.current =
			(this.current + delta + this.questions.length + 1) %
			(this.questions.length + 1);
		this.offset = 0;
		this.reveal = false;
		this.openTextQuestion();
		this.tui.requestRender();
	}
	private choose(): void {
		const question = this.questions[this.current];
		const options = question.options ?? [];
		const draft = this.drafts[this.current];
		if (draft.cursor < options.length) this.answer(options[draft.cursor].label);
		else if (draft.cursor === options.length) this.edit(draft.text);
		else this.finish({ status: "discuss", question: question.question });
	}
	handleInput(data: string): void {
		if (this.closed) return;
		// Tab navigation remains available inside the editor; ordinary arrows edit text.
		if (this.keys.matches(data, "extension.askUser.previous")) {
			this.navigate(-1);
			return;
		}
		if (this.keys.matches(data, "extension.askUser.next")) {
			this.navigate(1);
			return;
		}
		if (this.editing) {
			if (this.keys.matches(data, "tui.select.cancel")) {
				this.editing = false;
				this.editor.focused = false;
				this.offset = 0;
			} else this.editor.handleInput(data);
			if (this.editing) this.reveal = true;
		} else if (this.keys.matches(data, "tui.select.cancel")) this.cancel();
		else if (
			this.keys.matches(data, "tui.select.pageUp") ||
			this.keys.matches(data, "tui.select.pageDown")
		) {
			this.offset = Math.max(
				0,
				Math.min(
					this.maxOffset,
					this.offset + (this.keys.matches(data, "tui.select.pageUp") ? -5 : 5),
				),
			);
			this.reveal = false;
		} else if (this.keys.matches(data, "tui.editor.cursorLeft"))
			this.navigate(-1);
		else if (this.keys.matches(data, "tui.editor.cursorRight"))
			this.navigate(1);
		else if (this.current === this.questions.length) {
			if (this.keys.matches(data, "tui.select.confirm")) this.submit();
		} else {
			const draft = this.drafts[this.current];
			const options = this.questions[this.current].options ?? [];
			if (this.keys.matches(data, "tui.select.up")) {
				draft.cursor = Math.max(0, draft.cursor - 1);
				this.reveal = true;
			} else if (this.keys.matches(data, "tui.select.down")) {
				draft.cursor = Math.min(options.length + 1, draft.cursor + 1);
				this.reveal = true;
			} else if (
				this.keys.matches(data, "extension.askUser.edit") &&
				draft.cursor <= options.length
			)
				this.edit(options[draft.cursor]?.label ?? draft.text);
			else if (this.keys.matches(data, "tui.select.confirm")) this.choose();
			else if (/^[1-9]$/.test(data) && Number(data) <= options.length + 2) {
				draft.cursor = Number(data) - 1;
				this.choose();
			}
		}
		this.tui.requestRender();
	}
	private key(action: Keybinding): string {
		const binding = this.keys.getKeys(action)[0] ?? "unbound";
		const labels: Record<string, string> = {
			up: "↑",
			down: "↓",
			left: "←",
			right: "→",
			enter: "Enter",
			escape: "Esc",
			tab: "Tab",
			"shift+tab": "Shift+Tab",
			"ctrl+e": "Ctrl+E",
			pageUp: "PgUp",
			pageDown: "PgDn",
		};
		return labels[binding] ?? binding;
	}
	private tabs(width: number): string {
		const tabs = [
			...this.questions.map(
				(q, i) =>
					`${this.drafts[i].confirmed ? "✓" : "□"} ${displayText(q.label ?? `Question ${i + 1}`)}`,
			),
			"✓ Submit",
		].map((label, i) => {
			const text = ` ${truncateToWidth(label, Math.max(1, Math.min(18, width - 8)))} `;
			return i === this.current
				? this.theme.bg("selectedBg", this.theme.fg("text", text))
				: this.theme.fg("muted", text);
		});
		let start = 0,
			end = tabs.length;
		while (
			end - start > 1 &&
			visibleWidth(tabs.slice(start, end).join(" ")) > width - 4
		) {
			if (this.current - start > end - 1 - this.current) start++;
			else end--;
		}
		return `${this.theme.fg("dim", "←")} ${tabs.slice(start, end).join(" ")} ${this.theme.fg("dim", "→")}`;
	}
	render(width: number): string[] {
		const inner = Math.max(1, width - 4);
		const body: string[] = [];
		const add = (text: string, indent = 0) =>
			body.push(
				...wrapTextWithAnsi(text, Math.max(1, inner - indent)).map(
					(line) => " ".repeat(indent) + line,
				),
			);
		const review = this.current === this.questions.length;
		let anchor = 0;
		if (review) {
			add(this.theme.bold("Review your answers"));
			body.push("");
			for (const [i, q] of this.questions.entries()) {
				const draft = this.drafts[i];
				add(this.theme.fg("muted", `${i + 1}. ${displayText(q.question)}`));
				add(
					draft.confirmed
						? this.theme.fg("text", displayText(draft.text))
						: this.theme.fg(
								"warning",
								draft.text ? `Draft: ${displayText(draft.text)}` : "Unanswered",
							),
					3,
				);
				body.push("");
			}
		} else {
			const q = this.questions[this.current],
				draft = this.drafts[this.current];
			add(this.theme.bold(displayText(q.question)));
			body.push("");
			if (this.editing) {
				add(this.theme.fg("muted", "Your answer"));
				const lines = this.editor.render(inner);
				const cursor = lines.findIndex((line) => line.includes(CURSOR_MARKER));
				anchor = body.length + (cursor < 0 ? lines.length - 1 : cursor);
				body.push(...lines);
			} else {
				const options = q.options ?? [];
				const choices = [
					...options,
					{ label: "Type something." },
					{ label: "Chat about this" },
				];
				for (const [i, option] of choices.entries()) {
					if (i === options.length + 1) {
						body.push("");
						add(this.theme.fg("dim", "─".repeat(inner)));
					}
					if (draft.cursor === i) anchor = body.length;
					const chosen =
						draft.confirmed &&
						(i < options.length
							? draft.text === option.label
							: i === options.length &&
								!options.some((o) => o.label === draft.text));
					const prefix = `${draft.cursor === i ? "❯" : " "} ${i + 1}. `;
					const color = chosen
						? "success"
						: draft.cursor === i
							? "accent"
							: "text";
					const lines = wrapTextWithAnsi(
						this.theme.fg(
							color,
							`${displayText(option.label)}${chosen ? " ✓" : ""}`,
						),
						Math.max(1, inner - prefix.length),
					);
					body.push(
						...lines.map(
							(line, n) =>
								(n === 0
									? this.theme.fg("accent", prefix)
									: " ".repeat(prefix.length)) + line,
						),
					);
					if (option.description)
						add(this.theme.fg("muted", displayText(option.description)), 5);
				}
				if (draft.text && draft.cursor === options.length) {
					body.push("");
					add(
						this.theme.fg(
							"muted",
							`${draft.confirmed ? "Answer" : "Draft"}: ${displayText(draft.text)}`,
						),
					);
				}
			}
		}
		const navigation = `${this.key("extension.askUser.previous")}/${this.key("extension.askUser.next")} tabs`;
		const help = this.editing
			? `${navigation} · ${this.key("tui.input.submit")} save · ${this.key("tui.select.cancel")} back`
			: review
				? `${navigation} · ${this.key("tui.select.confirm")} ${this.drafts.every((d) => d.confirmed) ? "submit" : "answer remaining"} · ${this.key("tui.select.cancel")} cancel`
				: `${this.key("tui.select.up")}/${this.key("tui.select.down")} select · ${this.key("tui.editor.cursorLeft")}/${this.key("tui.editor.cursorRight")} tabs · ${this.key("extension.askUser.edit")} edit · ${this.key("tui.select.confirm")} choose · ${this.key("tui.select.cancel")} cancel`;
		const footer = wrapTextWithAnsi(this.theme.fg("dim", help), inner);
		const available = Math.max(3, this.tui.terminal.rows - footer.length - 9);
		this.maxOffset = Math.max(0, body.length - available);
		if (this.reveal)
			this.offset = Math.max(0, Math.min(this.offset, anchor, this.maxOffset));
		if (this.reveal && anchor >= this.offset + available)
			this.offset = Math.min(this.maxOffset, anchor - available + 1);
		this.offset = Math.min(this.offset, this.maxOffset);
		this.reveal = false;
		return [
			this.theme.fg("dim", "─".repeat(inner)),
			this.tabs(inner),
			"",
			...body.slice(this.offset, this.offset + available),
			"",
			...(this.maxOffset
				? [
						this.theme.fg(
							"dim",
							`${this.offset ? "↑ " : ""}${this.offset < this.maxOffset ? "↓ " : ""}${this.key("tui.select.pageUp")}/${this.key("tui.select.pageDown")} scroll`,
						),
					]
				: []),
			...footer,
		].map((line) => `  ${line}`);
	}
}
