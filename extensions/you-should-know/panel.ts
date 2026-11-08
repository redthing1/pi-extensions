import { stripVTControlCharacters } from "node:util";
import {
	getMarkdownTheme,
	type ExtensionContext,
	type KeybindingsManager as AppKeys,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	Editor,
	KeybindingsManager,
	Markdown,
	Text,
	TUI_KEYBINDINGS,
	truncateToWidth,
	wrapTextWithAnsi,
	type Component,
	type Focusable,
	type Keybinding,
	type TUI,
} from "@earendil-works/pi-tui";
import type { Topic } from "./requests.ts";

declare module "@earendil-works/pi-tui" {
	interface Keybindings {
		"extension.btw.actions": true;
		"extension.btw.stop": true;
	}
}
const PANEL_KEYS = {
	"extension.btw.actions": { defaultKeys: "ctrl+o" as const },
	"extension.btw.stop": { defaultKeys: "ctrl+x" as const },
};

export function cleanText(text: string): string {
	return stripVTControlCharacters(text).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}
export function preview(text: string): string {
	return cleanText(text).replace(/\s+/g, " ").trim();
}
export function topicText(topic: Topic): string {
	return (
		topic.exchanges
			.map(({ question, answer }) => (question ? `You: ${question}\n\n${answer}` : answer))
			.join("\n\n---\n\n") + (topic.pendingQuestion ? `\n\nYou: ${topic.pendingQuestion}\n\n${topic.partial}` : "")
	);
}
export type PanelAction = "forward" | "dismiss" | "close";

export class TopicPanel implements Component, Focusable {
	private readonly editor: Editor;
	private readonly keys: KeybindingsManager;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly topic: Topic;
	private readonly cancel: () => void;
	private readonly reply: (text: string) => Promise<void>;
	private readonly done: (action: PanelAction) => void;
	private mode: "read" | "edit" | "actions" = "read";
	private isFocused = false;
	private offset = 0;
	private maxOffset = 0;
	private pageSize = 10;
	private followTail: boolean;
	private selected = 0;
	private submitting = false;

	constructor(
		tui: TUI,
		theme: Theme,
		keys: AppKeys,
		topic: Topic,
		cancel: () => void,
		reply: (text: string) => Promise<void>,
		done: (action: PanelAction) => void,
	) {
		this.tui = tui;
		this.theme = theme;
		this.keys = new KeybindingsManager({ ...TUI_KEYBINDINGS, ...PANEL_KEYS }, keys.getUserBindings());
		this.topic = topic;
		this.cancel = cancel;
		this.reply = reply;
		this.done = done;
		this.followTail = topic.status === "working";
		this.editor = new Editor(
			tui,
			{
				borderColor: (text) => theme.fg("borderMuted", text),
				selectList: {
					selectedPrefix: (text) => theme.fg("accent", text),
					selectedText: (text) => theme.fg("text", text),
					description: (text) => theme.fg("muted", text),
					scrollInfo: (text) => theme.fg("dim", text),
					noMatch: (text) => theme.fg("muted", text),
				},
			},
			{ paddingX: 1 },
		);
		this.editor.setText(topic.draft ?? "");
		this.editor.onChange = () => {
			topic.draft = this.editor.getExpandedText();
		};
		this.editor.onSubmit = (text) => {
			void this.submit(text);
		};
	}
	get focused(): boolean {
		return this.isFocused;
	}
	set focused(value: boolean) {
		this.isFocused = value;
		this.editor.focused = value && this.mode === "edit";
	}
	invalidate(): void {
		this.editor.invalidate();
	}
	private setMode(mode: typeof this.mode): void {
		this.mode = mode;
		this.focused = this.isFocused;
	}
	private async submit(text: string): Promise<void> {
		if (!text.trim() || this.submitting || this.topic.status === "working") return;
		this.submitting = true;
		try {
			await this.reply(text.trim());
			this.editor.setText("");
			this.topic.draft = "";
			this.followTail = true;
			this.setMode("read");
		} finally {
			this.submitting = false;
			this.tui.requestRender();
		}
	}
	private actions(): { label: string; action: PanelAction }[] {
		return [
			...(this.topic.exchanges.length ? [{ label: "place in main composer", action: "forward" as const }] : []),
			{ label: "discard topic", action: "dismiss" },
		];
	}
	handleInput(data: string): void {
		if (this.keys.matches(data, "tui.select.cancel")) {
			if (this.mode === "read") this.done("close");
			else this.setMode("read");
		} else if (this.mode === "edit") {
			this.editor.handleInput(data);
		} else if (this.keys.matches(data, "extension.btw.stop") && this.topic.status === "working") {
			this.cancel();
		} else if (this.keys.matches(data, "extension.btw.actions") && this.topic.status !== "working") {
			this.selected = 0;
			this.setMode(this.mode === "actions" ? "read" : "actions");
		} else if (this.mode === "actions") {
			if (this.keys.matches(data, "tui.select.up")) this.selected = Math.max(0, this.selected - 1);
			else if (this.keys.matches(data, "tui.select.down"))
				this.selected = Math.min(this.actions().length - 1, this.selected + 1);
			else if (this.keys.matches(data, "tui.select.confirm")) this.done(this.actions()[this.selected].action);
		} else if (this.keys.matches(data, "tui.select.confirm") && this.topic.status !== "working") {
			this.followTail = this.offset === this.maxOffset;
			this.setMode("edit");
		} else {
			const delta = this.keys.matches(data, "tui.select.pageUp")
				? -this.pageSize
				: this.keys.matches(data, "tui.select.pageDown")
					? this.pageSize
					: this.keys.matches(data, "tui.select.up")
						? -1
						: this.keys.matches(data, "tui.select.down")
							? 1
							: 0;
			if (delta) {
				this.offset = Math.max(0, Math.min(this.maxOffset, this.offset + delta));
				this.followTail = delta > 0 && this.offset === this.maxOffset;
			}
		}
		this.tui.requestRender();
	}
	private key(action: Keybinding): string {
		const key = this.keys.getKeys(action)[0] ?? "unbound";
		return (
			(
				{
					escape: "esc",
					up: "↑",
					down: "↓",
					pageUp: "pgup",
					pageDown: "pgdn",
				} as Record<string, string>
			)[key] ?? key
		);
	}
	render(width: number): string[] {
		const inner = Math.max(1, width - 2);
		const { theme, topic } = this;
		const body: string[] = [];
		const exchange = (question: string, answer: string) => {
			if (body.length) body.push("");
			if (question) body.push(...new Text(theme.fg("muted", cleanText(question)), 0, 0).render(inner), "");
			if (answer) body.push(...new Markdown(cleanText(answer), 0, 0, getMarkdownTheme()).render(inner));
		};
		for (const item of topic.exchanges) exchange(item.question, item.answer);
		if (topic.pendingQuestion) exchange(topic.pendingQuestion, topic.partial);
		if (topic.error) body.push("", ...new Text(theme.fg("warning", topic.error), 0, 0).render(inner));
		const working = topic.status === "working";
		const state = working ? " · answering…" : topic.status === "cancelled" ? " · stopped" : "";
		const at = new Date(topic.at).toLocaleTimeString([], {
			hour: "2-digit",
			minute: "2-digit",
		});
		const heading =
			theme.fg("accent", theme.bold(topic.kind === "observer" ? "you should know" : "btw")) +
			theme.fg("dim", `${state} · context at ${at}`);
		const footer: string[] = [];
		let hint: string;
		if (this.mode === "edit") {
			footer.push(...this.editor.render(inner));
			hint = `${this.key("tui.input.submit")} send · ${this.key("tui.input.newLine")} newline · ${this.key("tui.select.cancel")} back`;
		} else if (this.mode === "actions") {
			footer.push(theme.fg("borderMuted", "─".repeat(inner)));
			const actions = this.actions();
			this.selected = Math.min(this.selected, actions.length - 1);
			footer.push(
				...actions.map((item, index) =>
					index === this.selected ? theme.fg("accent", `› ${item.label}`) : `  ${item.label}`,
				),
			);
			hint = `${this.key("tui.select.confirm")} choose · ${this.key("tui.select.cancel")} back`;
		} else {
			footer.push(theme.fg("borderMuted", "─".repeat(inner)));
			hint = working
				? `${this.key("extension.btw.stop")} stop`
				: `${this.key("tui.select.confirm")} ${topic.kind === "observer" ? "discuss" : topic.draft ? "resume draft" : "reply"}`;
			if (!working) hint += ` · ${this.key("extension.btw.actions")} actions`;
			hint += ` · ${this.key("tui.select.cancel")} close`;
		}
		footer.push(...wrapTextWithAnsi(theme.fg("dim", hint), inner));
		this.pageSize = Math.max(1, this.tui.terminal.rows - footer.length - 9);
		this.maxOffset = Math.max(0, body.length - this.pageSize);
		this.offset = this.followTail ? this.maxOffset : Math.min(this.offset, this.maxOffset);
		const scroll = this.maxOffset
			? theme.fg("dim", ` · ${this.offset ? "↑" : ""}${this.offset < this.maxOffset ? "↓" : ""}`)
			: "";
		return [
			theme.fg("borderMuted", "─".repeat(inner)),
			heading + scroll,
			"",
			...body.slice(this.offset, this.offset + this.pageSize),
			"",
			...footer,
		].map((line) => ` ${truncateToWidth(line, inner)} `);
	}
}

export function showPreview(ctx: ExtensionContext, topic: Topic | undefined): void {
	ctx.ui.setWidget(
		"btw",
		topic
			? (_tui, theme) => ({
					invalidate() {},
					render(width: number) {
						const inner = Math.max(1, width - 2);
						const text = topic.exchanges.at(-1)?.answer ?? "";
						const lines = new Markdown(cleanText(text), 0, 0, getMarkdownTheme())
							.render(inner)
							.filter((line) => preview(line));
						return [
							theme.fg("accent", "you should know"),
							...lines
								.slice(0, 2)
								.map((line, index) =>
									index === 1 && lines.length > 2 ? truncateToWidth(line, Math.max(1, inner - 2), "") + " …" : line,
								),
							theme.fg("dim", "/ysk to open · /ysk dismiss"),
						].map((line) => ` ${truncateToWidth(line, inner)} `);
					},
				})
			: undefined,
	);
}
