import { afterEach, expect, test } from "vitest";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import {
	initTheme,
	type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { TuiMainScreen } from "@earendil-works/pi-tui";
import askUser from "../index.ts";
import type { QuestionForm } from "../form.ts";

const load = (path: string) =>
	import(pathToFileURL(join(process.env.PI_ASK_CHECKOUT!, path)).href);
const { createHarness, createTestUiContext, getToolResult, getMessageText } =
	await load("packages/coding-agent/test/suite/harness.ts");
const { VirtualTerminal } = await load("packages/tui/test/virtual-terminal.ts");
const themes = await load(
	"packages/coding-agent/src/modes/interactive/theme/theme.ts",
);
const { KeybindingsManager } = await load(
	"packages/coding-agent/src/core/keybindings.ts",
);
type TestHarness = Awaited<ReturnType<typeof createHarness>>;
const harnesses: TestHarness[] = [];
afterEach(async () => {
	for (const h of harnesses.splice(0)) {
		await h.session.extensionRunner.emit({
			type: "session_shutdown",
			reason: "exit",
		});
		h.cleanup();
	}
});
const parameters = {
	questions: [
		{
			question: "Which scope?",
			options: [{ label: "Project" }, { label: "Global" }],
		},
	],
};
async function setup(
	action: (form: QuestionForm, h: TestHarness) => void,
	mode: "tui" | "print" = "tui",
	params = parameters,
) {
	initTheme("dark", false);
	const h = await createHarness({ extensionFactories: [askUser] });
	harnesses.push(h);
	const custom: ExtensionUIContext["custom"] = (factory) =>
		new Promise((done, reject) => {
			Promise.resolve(
				factory(
					new TuiMainScreen(new VirtualTerminal()),
					themes.theme,
					new KeybindingsManager(),
					done,
				),
			).then((form) => action(form as QuestionForm, h), reject);
		});
	await h.session.bindExtensions({
		mode,
		uiContext: createTestUiContext({ custom }),
	});
	h.setResponses([
		fauxAssistantMessage(fauxToolCall("ask_user", params), {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("Acknowledged."),
	]);
	return h;
}

test("the ordinary agent loop receives the exact submitted answer", async () => {
	const h = await setup((form) => {
		form.handleInput("\x1b[B");
		form.handleInput("\r");
		form.handleInput("\r");
	});
	await h.session.prompt("Ask about scope.");
	expect(JSON.parse(getMessageText(getToolResult(h, "ask_user")))).toEqual({
		answers: [{ question: "Which scope?", answer: "Global" }],
	});
});

test("cancelled forms return no implied default", async () => {
	const h = await setup((form) => form.cancel());
	await h.session.prompt("Ask about scope.");
	expect(getToolResult(h, "ask_user").details).toEqual({ status: "cancelled" });
	expect(getMessageText(getToolResult(h, "ask_user"))).not.toContain("Project");
});

test("discussion returns the current question as user intent, with no answers", async () => {
	const h = await setup((form) => form.handleInput("4"));
	await h.session.prompt("Ask about scope.");
	expect(getToolResult(h, "ask_user").details).toEqual({
		status: "discuss",
		question: "Which scope?",
	});
	expect(getMessageText(getToolResult(h, "ask_user"))).toContain(
		"No answers were submitted",
	);
});

test("aborting a tool closes its form and does not submit a draft", async () => {
	let form: QuestionForm | undefined;
	const h = await setup((current, harness) => {
		form = current;
		current.handleInput("\x05");
		current.handleInput(" unfinished");
		queueMicrotask(() => {
			void harness.session.abort();
		});
	});
	await h.session.prompt("Ask about scope.");
	expect(getToolResult(h, "ask_user").details).toEqual({ status: "cancelled" });
	form?.handleInput("\r");
	expect(getMessageText(getToolResult(h, "ask_user"))).not.toContain(
		"unfinished",
	);
});

test("session teardown closes an open form", async () => {
	const h = await setup((_form, harness) =>
		queueMicrotask(() =>
			harness.session.extensionRunner.emit({
				type: "session_shutdown",
				reason: "exit",
			}),
		),
	);
	await h.session.prompt("Ask about scope.");
	expect(getToolResult(h, "ask_user").details).toEqual({ status: "cancelled" });
});

test("noninteractive calls fail clearly without opening UI", async () => {
	const h = await setup(() => {
		throw Error("must not show UI");
	}, "print");
	await h.session.prompt("Ask about scope.");
	expect(getToolResult(h, "ask_user").isError).toBe(true);
	expect(getMessageText(getToolResult(h, "ask_user"))).toContain(
		"interactive TUI",
	);
});

test("schema limits reject excess questions instead of silently discarding them", async () => {
	const h = await setup(
		() => {
			throw Error("must not show UI");
		},
		"tui",
		{ questions: Array.from({ length: 7 }, () => parameters.questions[0]) },
	);
	await h.session.prompt("Ask about scope.");
	expect(getToolResult(h, "ask_user").isError).toBe(true);
});
