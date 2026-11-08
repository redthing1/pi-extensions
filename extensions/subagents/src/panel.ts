import {
	DynamicBorder,
	getSelectListTheme,
	keyHint,
	keyText,
	type KeybindingsManager,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { Container, SelectList, Text, type Component, type SelectItem, type TUI } from "@earendil-works/pi-tui";
import { completeOutput } from "./artifacts.ts";
import { renderExpandedChild, stateGlyph } from "./render.ts";
import { inspectionPresentations } from "./results.ts";
import type { SubagentScheduler } from "./scheduler.ts";

export class SubagentPanel implements Component {
	private readonly scheduler: SubagentScheduler;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly done: () => void;
	private readonly unsubscribe: () => void;
	private list!: SelectList;
	private items: SelectItem[] = [];
	private body: Component = new Text("");
	private childId?: string;
	private history = false;
	private confirming = false;
	private cancelling = false;
	private error?: string;
	private scroll = 0;
	private maxScroll = 0;
	private disposed = false;
	private active = false;

	constructor(scheduler: SubagentScheduler, tui: TUI, theme: Theme, keybindings: KeybindingsManager, done: () => void) {
		this.scheduler = scheduler;
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.done = done;
		this.refresh();
		this.unsubscribe = scheduler.subscribe(() => {
			if (this.disposed) return;
			this.refresh();
			tui.requestRender();
		});
	}

	dispose(): void {
		this.disposed = true;
		this.unsubscribe();
	}

	invalidate(): void {
		this.refresh();
	}

	private refresh(): void {
		if (this.disposed) return;
		const all = this.scheduler.runs({ includeCollected: true });
		const child = all.find((run) => run.id === this.childId);
		if (this.childId && !child) {
			this.childId = undefined;
			this.scroll = 0;
			this.error = undefined;
		}
		if (!all.length) this.history = false;
		this.active = child?.state === "running" || child?.state === "queued";
		if (!this.active) this.confirming = false;
		const selected = this.list?.getSelectedItem()?.value;
		if (this.confirming) {
			this.items = [
				{ value: "no", label: "Keep running" },
				{ value: "yes", label: "Cancel child" },
			];
		} else {
			this.items = (this.history ? all : this.scheduler.runs()).map((run) => {
				const state = run.collected
					? `${run.state} · collected`
					: run.finishedAt !== undefined
						? `${run.state} · result ready`
						: run.state;
				const seconds = Math.floor(
					Math.max(0, (run.finishedAt ?? Date.now()) - (run.startedAt ?? run.createdAt)) / 1000,
				);
				const tool = run.toolCalls?.at(-1);
				const activity =
					run.state === "running"
						? run.activity || (tool?.status === "running" ? `${tool.name} ${tool.preview}` : "waiting for model output")
						: undefined;
				return {
					value: run.id,
					label: `${stateGlyph(run.state, this.theme)} ${run.label.replace(/\s+/gu, " ")}`,
					description: `${state} · ${seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m`}${activity ? ` · ${activity}` : ""}`,
				};
			});
			const collected = all.filter((run) => run.collected).length;
			if (collected || this.history)
				this.items.push({
					value: "history",
					label: this.history ? "Hide collected history" : "Show collected history",
					description: `${collected} collected`,
				});
		}
		this.list = new SelectList(
			this.items,
			Math.max(1, Math.min(8, this.tui.terminal.rows - 12)),
			getSelectListTheme(),
			{ minPrimaryColumnWidth: 20, maxPrimaryColumnWidth: 36 },
		);
		this.list.setSelectedIndex(
			Math.max(
				0,
				this.items.findIndex((item) => item.value === selected),
			),
		);
		this.list.onCancel = () => {
			if (this.confirming) {
				this.confirming = false;
				this.refresh();
			} else this.done();
		};
		this.list.onSelect = (item) => {
			if (this.confirming) {
				this.confirming = false;
				if (item.value === "yes" && this.childId) void this.cancel(this.childId);
				else this.refresh();
			} else if (item.value === "history") {
				this.history = !this.history;
				this.refresh();
			} else {
				this.childId = item.value;
				this.scroll = 0;
				this.error = undefined;
				this.refresh();
			}
		};
		if (child) {
			const detail = this.scheduler.targets([child.id])[0];
			const presentation = inspectionPresentations([detail])[0];
			const body = new Container();
			renderExpandedChild(
				body,
				detail,
				{
					...presentation,
					messages: detail.messages,
					messageOffset: 0,
					totalMessages: detail.messages?.length,
					latestText: detail.result ? undefined : detail.latestText,
					preview: detail.result ? completeOutput(detail.result) : undefined,
					previewTruncated: false,
					error: undefined,
				},
				this.theme,
			);
			this.body = body;
		} else this.body = this.items.length ? this.list : new Text("No subagents in this session.", 0, 0);
	}

	private async cancel(id: string): Promise<void> {
		this.cancelling = true;
		this.tui.requestRender();
		try {
			await this.scheduler.cancel([id]);
		} catch (error) {
			this.error = error instanceof Error ? error.message : String(error);
		} finally {
			this.cancelling = false;
			if (!this.disposed) {
				this.refresh();
				this.tui.requestRender();
			}
		}
	}

	render(width: number): string[] {
		const border = new DynamicBorder((text) => this.theme.fg("border", text));
		const content = this.confirming
			? new Text(`Cancel ${this.scheduler.label(this.childId!)}?`, 0, 0).render(width).concat(this.list.render(width))
			: this.body.render(width);
		const height = Math.max(3, Math.min(18, this.tui.terminal.rows - 10));
		this.maxScroll = Math.max(0, content.length - height);
		this.scroll = Math.min(this.scroll, this.maxScroll);
		const hints = this.cancelling
			? "Cancelling… awaiting cleanup"
			: this.confirming
				? `${keyHint("tui.select.confirm", "choose")} · ${keyHint("tui.select.cancel", "back")}`
				: this.childId
					? `${this.theme.fg("dim", `${keyText("tui.select.up")}/${keyText("tui.select.down")} scroll`)} · ${keyHint("tui.select.cancel", "back")}${this.active ? ` · ${keyHint("tui.select.confirm", "cancel child")}` : ""}`
					: `${this.items.length ? `${keyHint("tui.select.confirm", "inspect")} · ` : ""}${keyHint("tui.select.cancel", "close")}`;
		const count = this.scheduler.runs().length;
		return [
			...border.render(width),
			...new Text(
				this.theme.bold(this.theme.fg("accent", this.history ? "Subagents · history" : "Subagents")),
				0,
				0,
			).render(width),
			...(!this.childId && !this.history && (count || this.items.length)
				? new Text(this.theme.fg("dim", count ? `${count} outstanding` : "No outstanding subagents"), 0, 0).render(
						width,
					)
				: []),
			...content.slice(this.scroll, this.scroll + height),
			...(this.maxScroll
				? new Text(
						this.theme.fg(
							"dim",
							`${this.scroll + 1}–${Math.min(content.length, this.scroll + height)} of ${content.length}`,
						),
						0,
						0,
					).render(width)
				: []),
			...(this.error ? new Text(this.theme.fg("error", this.error), 0, 0).render(width) : []),
			...new Text(hints, 0, 0).render(width),
			...border.render(width),
		];
	}

	handleInput(data: string): void {
		if (this.cancelling) return;
		if (this.confirming || !this.childId) {
			const pageUp = this.keybindings.matches(data, "tui.select.pageUp");
			const pageDown = this.keybindings.matches(data, "tui.select.pageDown");
			if ((pageUp || pageDown) && !this.confirming) {
				const index = this.items.findIndex((item) => item.value === this.list.getSelectedItem()?.value);
				this.list.setSelectedIndex(index + (pageUp ? -8 : 8));
			} else this.list.handleInput(data);
		} else if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.childId = undefined;
			this.scroll = 0;
			this.refresh();
		} else if (this.keybindings.matches(data, "tui.select.confirm") && this.active) {
			this.confirming = true;
			this.refresh();
		} else if (this.keybindings.matches(data, "tui.select.up")) this.scroll = Math.max(0, this.scroll - 1);
		else if (this.keybindings.matches(data, "tui.select.down")) this.scroll = Math.min(this.maxScroll, this.scroll + 1);
		else if (this.keybindings.matches(data, "tui.select.pageUp")) this.scroll = Math.max(0, this.scroll - 10);
		else if (this.keybindings.matches(data, "tui.select.pageDown"))
			this.scroll = Math.min(this.maxScroll, this.scroll + 10);
		this.tui.requestRender();
	}
}
