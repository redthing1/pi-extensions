import { expect, test } from "vitest";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { initTheme } from "@earendil-works/pi-coding-agent";
import {
	TuiMainScreen,
	visibleWidth,
	setKeybindings,
	stripTerminalSequences,
} from "@earendil-works/pi-tui";
import {
	displayText,
	QuestionForm,
	type FormResult,
	type Question,
} from "../form.ts";

const load = (path: string) =>
	import(pathToFileURL(join(process.env.PI_ASK_CHECKOUT!, path)).href);
const { VirtualTerminal } = await load("packages/tui/test/virtual-terminal.ts");
const themes = await load(
	"packages/coding-agent/src/modes/interactive/theme/theme.ts",
);
const { KeybindingsManager } = await load(
	"packages/coding-agent/src/core/keybindings.ts",
);
const choices: Question[] = [
	{
		question: "Where should this setting apply?",
		options: [
			{
				label: "Per project",
				description: "Each project chooses independently.",
			},
			{ label: "Globally", description: "One default across projects." },
		],
	},
	{
		question: "How should we roll it out?",
		options: [{ label: "Gradually" }, { label: "Immediately" }],
	},
];
const keys = {
	enter: "\r",
	down: "\x1b[B",
	up: "\x1b[A",
	left: "\x1b[D",
	right: "\x1b[C",
	escape: "\x1b",
	tab: "\t",
	previous: "\x1b[Z",
	edit: "\x05",
	pageDown: "\x1b[6~",
};

function fixture(
	questions = choices,
	bindings = new KeybindingsManager(),
	rows = 35,
) {
	initTheme("dark", false);
	setKeybindings(bindings);
	let result: FormResult | undefined;
	let submissions = 0;
	const terminal = new VirtualTerminal(80, rows);
	const form = new QuestionForm(
		new TuiMainScreen(terminal),
		themes.theme,
		bindings,
		questions,
		(value) => {
			result = value;
			submissions++;
		},
	);
	form.focused = true;
	const send = (...inputs: string[]) =>
		inputs.forEach((input) =>
			form.handleInput(keys[input as keyof typeof keys] ?? input),
		);
	const render = (width = 80) => {
		const lines = form.render(width);
		expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
		expect(lines.length).toBeLessThanOrEqual(rows);
		return stripTerminalSequences(lines.join("\n"));
	};
	return {
		form,
		send,
		render,
		result: () => (result?.status === "answered" ? result.answers : undefined),
		outcome: () => result,
		submissions: () => submissions,
	};
}

test("choices require confirmation and a batch requires explicit review submission", () => {
	const f = fixture();
	f.send("down", "right", "enter");
	expect(f.render()).toContain("Unanswered");
	expect(f.submissions()).toBe(0);
	f.send("enter"); // returns to missing first question
	f.send("enter", "enter");
	expect(f.render()).toContain("Review");
	expect(f.submissions()).toBe(0);
	f.send("enter");
	expect(f.result()).toEqual([
		{ question: choices[0].question, answer: "Globally" },
		{ question: choices[1].question, answer: "Gradually" },
	]);
	f.send("enter");
	expect(f.submissions()).toBe(1);
});

test("custom answers cannot submit blank and are preserved when revisiting", () => {
	const f = fixture();
	f.send("down", "down", "enter", "enter");
	expect(f.render()).toContain("Your answer");
	expect(f.submissions()).toBe(0);
	f.send("Keep the current behavior", "enter", "left");
	expect(f.render()).toContain("Keep the current behavior");
	f.send("right", "enter", "enter");
	expect(f.result()?.[0].answer).toBe("Keep the current behavior");
});

test("editing a choice preserves the user's qualification as one answer", () => {
	const f = fixture([choices[0]]);
	f.send("edit", ", but inherit the global default", "enter", "enter");
	expect(f.result()?.[0].answer).toBe(
		"Per project, but inherit the global default",
	);
});

test("a text-only question supports pasted multiline Unicode", () => {
	const f = fixture([{ question: "What should we call it?" }]);
	f.send("\x1b[200~設定 🌱\nA small garden\x1b[201~", "enter", "enter");
	expect(f.result()?.[0].answer).toBe("設定 🌱\nA small garden");
});

test("Escape backs out of editing, then cancels without returning partial answers", () => {
	const f = fixture();
	f.send("enter", "edit", " unfinished", "escape");
	expect(f.submissions()).toBe(0);
	f.send("escape");
	expect(f.submissions()).toBe(1);
	expect(f.result()).toBeUndefined();
});

test("cancellation is idempotent and closes text-only input", () => {
	const f = fixture([{ question: "Your preference?" }]);
	f.form.cancel();
	f.form.cancel();
	f.send("text", "enter");
	expect(f.submissions()).toBe(1);
	expect(f.result()).toBeUndefined();
});

test.each([28, 48, 100])(
	"wraps, scrolls, and resizes without overflowing width %s",
	(width) => {
		const f = fixture(
			[
				{
					question: "Choose the scope for our fictional project",
					options: Array.from({ length: 8 }, (_, i) => ({
						label: `Choice ${i + 1} 設定`,
						description:
							"A longer explanation of this choice and its practical tradeoffs for the fictional project.",
					})),
				},
			],
			undefined,
			24,
		);
		expect(f.render(width)).toContain("Choose the scope");
		f.send("pageDown");
		expect(f.render(width)).toContain("scroll");
		for (let i = 0; i < 8; i++) f.send("down");
		expect(f.render(width)).toContain("Type something.");
		f.render(100);
		f.render(28);
	},
);

test("navigation and help honor configured bindings", () => {
	const f = fixture(
		[choices[0]],
		new KeybindingsManager({
			"tui.select.confirm": "ctrl+s",
			"tui.select.down": "ctrl+n",
		}),
	);
	expect(f.render()).toContain("ctrl+s choose");
	f.send("enter");
	expect(f.submissions()).toBe(0);
	f.send("\x0e", "\x13", "\x13");
	expect(f.result()?.[0].answer).toBe("Globally");
});

test("untrusted text cannot emit terminal controls", () => {
	expect(displayText("hello\x1b[2Jworld\x07")).not.toMatch(/[\x1b\x07]/);
});

test("a long question starts at its beginning and remains readable by scrolling", () => {
	const question =
		"Important context. " + "Read this before choosing a scope. ".repeat(30);
	const f = fixture(
		[{ question, options: [{ label: "Project" }] }],
		undefined,
		24,
	);
	expect(f.render(48)).toContain("Important context.");
	f.send("pageDown");
	expect(f.render(48)).toContain("Read this before choosing");
});

test("tabs preserve unfinished text without turning it into a submitted answer", () => {
	const f = fixture();
	f.send("edit", ", with an override", "tab");
	expect(f.render()).toContain(choices[1].question);
	f.send("previous");
	expect(f.render()).toContain("Draft: Per project, with an override");
	f.send("tab", "enter", "enter"); // review returns to the unconfirmed draft
	expect(f.submissions()).toBe(0);
	f.send("enter", "enter", "tab", "enter");
	expect(f.result()?.[0].answer).toBe("Per project, with an override");
});

test("text questions support backward and forward tab navigation while editing", () => {
	const f = fixture([
		{ label: "Name", question: "Name?" },
		{ label: "Notes", question: "Notes?" },
	]);
	f.send("Garden", "enter", "draft notes", "previous");
	expect(f.render()).toContain("Garden");
	f.send("tab");
	expect(f.render()).toContain("draft notes");
	f.send("enter");
	expect(f.render()).toContain("Review your answers");
	f.send("enter");
	expect(f.result()?.map((a) => a.answer)).toEqual(["Garden", "draft notes"]);
});

test("Chat about this requests discussion without submitting any drafts", () => {
	const f = fixture();
	f.send("enter", "down", "down", "down", "enter");
	expect(f.outcome()).toEqual({
		status: "discuss",
		question: choices[1].question,
	});
	expect(f.result()).toBeUndefined();
});

test("scoped tab navigation can be remapped without changing text editing", () => {
	const f = fixture(
		choices,
		new KeybindingsManager({
			"extension.askUser.next": "ctrl+n",
			"extension.askUser.previous": "ctrl+p",
		}),
	);
	f.send("edit", " draft", "\x0e");
	expect(f.render()).toContain(choices[1].question);
	f.send("\x10");
	expect(f.render()).toContain("Draft: Per project draft");
});
