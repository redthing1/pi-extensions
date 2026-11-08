import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import { expect, test, vi } from "vitest";
import { TopicPanel, cleanText } from "../panel.ts";
import type { Topic } from "../requests.ts";

const { KeybindingsManager } = await import(
	pathToFileURL(join(process.env.PI_BTW_CHECKOUT!, "packages/coding-agent/src/core/keybindings.ts")).href
);
const { createTestUiContext } = await import(
	pathToFileURL(join(process.env.PI_BTW_CHECKOUT!, "packages/coding-agent/test/suite/harness.ts")).href
);

function fixture(status: Topic["status"] = "ready") {
	initTheme("dark", false);
	const topic = {
		kind: "btw",
		title: "Question",
		at: Date.now(),
		status,
		exchanges: [{ question: "Question", answer: "An answer." }],
		partial: "",
	} as Topic;
	const done = vi.fn();
	const cancel = vi.fn();
	const reply = vi.fn(async (text: string) => {
		topic.status = "working";
		topic.pendingQuestion = text;
	});
	const create = () =>
		new TopicPanel(
			{ terminal: { rows: 24 }, requestRender() {} } as never,
			createTestUiContext().theme,
			new KeybindingsManager(),
			topic,
			cancel,
			reply,
			done,
		);
	return { topic, done, cancel, reply, create, panel: create() };
}

test("reply stays in the reader, preserves drafts on back/close, and shows activity", async () => {
	const { panel, topic, done, reply, create } = fixture();
	panel.focused = true;
	panel.handleInput("\r");
	panel.handleInput("A follow-up");
	expect(panel.render(48).join("\n")).toContain(CURSOR_MARKER);
	panel.handleInput("\x1b");
	expect(topic.draft).toBe("A follow-up");
	expect(panel.render(48).join("\n")).not.toContain(CURSOR_MARKER);
	panel.handleInput("\x1b");
	expect(done).toHaveBeenCalledWith("close");
	const reopened = create();
	reopened.focused = true;
	reopened.handleInput("\r");
	expect(cleanText(reopened.render(48).join("\n"))).toContain("A follow-up");
	reopened.handleInput("\r");
	await vi.waitFor(() => expect(reply).toHaveBeenCalledWith("A follow-up"));
	expect(topic.draft).toBe("");
	expect(cleanText(reopened.render(48).join("\n"))).toContain("answering…");
	expect(done).toHaveBeenCalledTimes(1);
});

test("closing a running answer does not stop it; stopping is explicit", () => {
	const { panel, done, cancel } = fixture("working");
	panel.handleInput("\x1b");
	expect(done).toHaveBeenCalledWith("close");
	expect(cancel).not.toHaveBeenCalled();
	const next = fixture("working");
	next.panel.handleInput("\x18");
	expect(next.cancel).toHaveBeenCalledOnce();
	expect(next.done).not.toHaveBeenCalled();
});

test("scrolling up keeps the reading position as output grows and layouts fit narrow terminals", () => {
	const { panel, topic } = fixture("working");
	topic.exchanges = [];
	topic.pendingQuestion = "Question";
	topic.partial = Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n\n");
	panel.render(48);
	panel.handleInput("\x1b[5~");
	const before = cleanText(panel.render(48).join("\n"));
	topic.partial += "\n\nnew output";
	const after = cleanText(panel.render(48).join("\n"));
	expect(after.split("\n").slice(2, 10)).toEqual(before.split("\n").slice(2, 10));
	for (const width of [38, 48, 80]) {
		const lines = panel.render(width);
		expect(lines.length).toBeLessThanOrEqual(24);
		expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
		expect(cleanText(lines.at(-1)!)).toContain("esc close");
	}
});
