import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import { DetailView } from "../src/ui/panel-views.ts";

test("detail views preserve their scroll position through container invalidation", () => {
	const theme = { bold: (text: string) => text, fg: (_color: string, text: string) => text } as Theme;
	const keys = { matches: (data: string, action: string) => data === action } as KeybindingsManager;
	let closed = 0;
	const view = new DetailView(theme, keys, "Details", Array.from({ length: 16 }, (_, i) => `line ${i}`), () => closed++);
	const parent = new Container();
	parent.addChild(view);
	view.handleInput("tui.select.down");
	const before = parent.render(80);
	expect(before.join("\n")).toContain("(2/16)");
	parent.invalidate();
	expect(parent.render(80)).toEqual(before);
	view.handleInput("tui.select.cancel");
	expect(closed).toBe(1);
});
