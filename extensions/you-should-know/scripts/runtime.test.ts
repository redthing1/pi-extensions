import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
	fauxAssistantMessage,
	fauxToolCall,
	getCurrentSystemPrompt,
	getCurrentTools,
	normalizeContext,
	type TranscriptContext,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../index.ts";
import horizon from "../../compact-horizon/index.ts";
import { answer, appendQuestion, outputBudget, preservesPrefix, type Topic } from "../requests.ts";
import { TopicPanel, cleanText } from "../panel.ts";

const checkout = process.env.PI_BTW_CHECKOUT!;
const { createHarness, createTestUiContext, getMessageText } = await import(
	pathToFileURL(join(checkout, "packages/coding-agent/test/suite/harness.ts")).href
);
const { initTheme } = await import(pathToFileURL(join(checkout, "packages/coding-agent/src/index.ts")).href);
const { KeybindingsManager } = await import(
	pathToFileURL(join(checkout, "packages/coding-agent/src/core/keybindings.ts")).href
);

const harnesses: Awaited<ReturnType<typeof createHarness>>[] = [];
const widgets = new Map<string, unknown>();
const notices: string[] = [];
const statuses = new Map<string, string>();
let lastPanel: TopicPanel;
let panelAction = "close";
let draft = "";
let followup = "";

beforeEach(() => {
	initTheme("dark", false);
	widgets.clear();
	statuses.clear();
	notices.length = 0;
	panelAction = "close";
	draft = "";
	followup = "";
});
afterEach(async () => {
	for (const h of harnesses.splice(0)) {
		await h.session.extensionRunner.emit({ type: "session_shutdown" });
		h.cleanup();
	}
	vi.restoreAllMocks();
});

async function setup(
	extra: ((pi: ExtensionAPI) => void)[] = [],
	models?: unknown[],
	after: ((pi: ExtensionAPI) => void)[] = [],
) {
	const h = await createHarness({
		extensionFactories: [...extra, extension, ...after],
		models,
		settings: { compaction: { enabled: false }, retry: { enabled: false } },
	});
	harnesses.push(h);
	await h.session.bindExtensions({
		mode: "tui",
		uiContext: createTestUiContext({
			setWidget: (key: string, value: unknown) => {
				if (value) widgets.set(key, value);
				else widgets.delete(key);
			},
			notify: (message: string) => notices.push(message),
			setStatus: (key: string, text: string | undefined) => {
				if (text) statuses.set(key, text);
				else statuses.delete(key);
			},
			custom: async (factory: Function) => {
				lastPanel = factory(
					{ terminal: { rows: 24 }, requestRender() {} },
					createTestUiContext().theme,
					new KeybindingsManager(),
					() => {},
				);
				if (panelAction === "followup") {
					lastPanel.handleInput("\r");
					lastPanel.handleInput(followup);
					lastPanel.handleInput("\r");
					await vi.waitFor(() => expect(lastPanel.render(100).join("\n")).not.toContain(" send ·"));
					return "close";
				}
				return panelAction;
			},
			getEditorText: () => draft,
			setEditorText: (text: string) => {
				draft = text;
			},
		}),
	});
	return h;
}

async function command(h: Awaited<ReturnType<typeof setup>>, name: string, args = "") {
	const runner = h.session.extensionRunner;
	await runner.getCommand(name)!.handler(args, runner.createCommandContext());
}

async function settled(h: Awaited<ReturnType<typeof setup>>) {
	await vi.waitFor(() => {
		expect(h.getPendingResponseCount()).toBe(0);
		expect(statuses.get("btw") ?? "").not.toContain("answering");
		expect(statuses.get("ysk") ?? "").not.toContain("checking");
	});
}

test("preserves transformed system/tools/history, freezes follow-ups, and leaves main context untouched", async () => {
	const h = await setup([
		(pi) => {
			pi.on("context", (event) => ({
				messages: event.messages.map((m) =>
					m.role === "user" ? { ...m, content: `${getMessageText(m)} HORIZON_MARKER` } : m,
				),
			}));
			pi.on("context_with_system", (event) => ({
				messages: event.messages.map((m) => (m.role === "system" ? { ...m, content: "TELEPORT_MARKER" } : m)),
			}));
		},
	]);
	let main!: TranscriptContext;
	let mainOptions!: SimpleStreamOptions;
	h.setResponses([
		(context: TranscriptContext, options: SimpleStreamOptions) => {
			main = context;
			mainOptions = options;
			return fauxAssistantMessage("MAIN_ONE");
		},
	]);
	await h.session.prompt("synthetic task");
	const mainBefore = structuredClone(h.session.messages);
	let first!: TranscriptContext;
	let sideOptions!: SimpleStreamOptions;
	h.setResponses([
		(context: TranscriptContext, options: SimpleStreamOptions) => {
			first = context;
			sideOptions = options;
			return fauxAssistantMessage("SIDE_ONE");
		},
	]);
	await command(h, "btw", "why?");
	await settled(h);
	expect(statuses.get("btw")).toContain("ready");
	await command(h, "btw");
	expect(statuses.has("btw")).toBe(false);
	expect(widgets.size).toBe(0);
	expect(first.messages.slice(0, main.messages.length)).toEqual(main.messages);
	expect(getCurrentSystemPrompt(first.messages)).toContain("TELEPORT_MARKER");
	expect(getCurrentTools(first.messages)).toEqual(getCurrentTools(main.messages));
	expect(JSON.stringify(first)).toContain("HORIZON_MARKER");
	expect(sideOptions.sessionId).toBe(mainOptions.sessionId);
	expect(sideOptions.transport).toBe("sse");
	expect(sideOptions.allowModelFallbacks).toBe(false);
	expect(h.session.messages).toEqual(mainBefore);
	h.setResponses([fauxAssistantMessage("MAIN_TWO")]);
	await h.session.prompt("new main progress");
	let second!: TranscriptContext;
	h.setResponses([
		(context: TranscriptContext) => {
			second = context;
			return fauxAssistantMessage("SIDE_TWO");
		},
	]);
	panelAction = "followup";
	followup = "explain further";
	await command(h, "btw");
	await settled(h);
	expect(second.messages.slice(0, first.messages.length)).toEqual(first.messages);
	expect(JSON.stringify(second)).toContain("SIDE_ONE");
	expect(JSON.stringify(second)).not.toContain("MAIN_TWO");
	panelAction = "forward";
	draft = "existing draft";
	await command(h, "btw");
	expect(draft).toContain("existing draft\n\nSide conversation:");
	expect(draft).toContain("SIDE_TWO");
	expect(JSON.stringify(h.session.messages)).not.toContain("SIDE_ONE");
});

test("refuses tools and context overflow without executing or compacting the main session", async () => {
	const h = await setup();
	h.setResponses([fauxAssistantMessage("main")]);
	await h.session.prompt("task");
	const before = structuredClone(h.session.messages);
	h.setResponses([fauxAssistantMessage(fauxToolCall("bash", { command: "NEVER_EXECUTE" }), { stopReason: "toolUse" })]);
	await command(h, "btw", "why");
	await settled(h);
	expect(h.session.messages).toEqual(before);
	const errorPanel = lastPanel;
	panelAction = "forward";
	await command(h, "btw");
	expect(draft).toBe("");
	expect(errorPanel.render(100).join("\n")).toContain("no tool was executed");
	expect(() =>
		outputBudget(appendQuestion({ messages: [] } as unknown as TranscriptContext, "x".repeat(40_000)), {
			...h.getModel(),
			contextWindow: 100,
		}),
	).toThrow("Not enough context");
});

test("cancellation and lifecycle changes discard stale work without touching the primary", async () => {
	const h = await setup();
	h.setResponses([fauxAssistantMessage("main")]);
	await h.session.prompt("task");
	let release!: () => void;
	let entered = false;
	h.setResponses([
		async () => {
			entered = true;
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			return fauxAssistantMessage("STALE");
		},
	]);
	await command(h, "btw", "slow question");
	await vi.waitFor(() => expect(entered).toBe(true));
	const stop = command(h, "btw", "cancel");
	release();
	await stop;
	await settled(h);
	expect(JSON.stringify(h.session.messages)).not.toContain("STALE");
	await h.session.extensionRunner.emit({ type: "session_compact", compactionEntry: {} });
	expect(widgets.size).toBe(0);
	await command(h, "btw");
	expect(notices.at(-1)).toContain("/btw <question>");
});

test("observer is opt-in, sparse, silent on none, and forwards an observation into a frozen BTW topic", async () => {
	let now = 1_000_000;
	vi.spyOn(Date, "now").mockImplementation(() => now);
	const h = await setup();
	for (let i = 0; i < 7; i++) {
		h.setResponses([fauxAssistantMessage("main")]);
		await h.session.prompt("task");
	}
	expect(widgets.size).toBe(0);
	await command(h, "ysk");
	expect(notices.at(-1)).toContain("enabled for this session");
	now += 120_001;
	for (let i = 0; i < 5; i++) {
		h.setResponses([fauxAssistantMessage("main")]);
		await h.session.prompt("task");
	}
	await command(h, "ysk");
	expect(notices.at(-1)).toContain("is on");
	const check = Promise.withResolvers<void>();
	h.setResponses([
		fauxAssistantMessage("main"),
		async () => {
			await check.promise;
			return fauxAssistantMessage("none");
		},
	]);
	await h.session.prompt("task");
	expect(statuses.get("ysk")).toContain("ysk · checking");
	check.resolve();
	await settled(h);
	expect(cleanText(statuses.get("ysk")!)).toBe("ysk");
	expect(widgets.size).toBe(0);
	now += 120_001;
	for (let i = 0; i < 5; i++) {
		h.setResponses([fauxAssistantMessage("main")]);
		await h.session.prompt("task");
	}
	h.setResponses([fauxAssistantMessage("main"), fauxAssistantMessage("This changes the meaning of the comparison.")]);
	await h.session.prompt("task");
	await settled(h);
	const beforeCount = h.faux.state.callCount;
	await command(h, "ysk");
	expect(h.faux.state.callCount).toBe(beforeCount);
	panelAction = "followup";
	followup = "how does it change?";
	let context!: TranscriptContext;
	h.setResponses([
		(c: TranscriptContext) => {
			context = c;
			return fauxAssistantMessage("Here is why.");
		},
	]);
	await command(h, "ysk");
	await settled(h);
	expect(JSON.stringify(context)).toContain("This changes the meaning");
	expect(JSON.stringify(h.session.messages)).not.toContain("This changes the meaning");
	await command(h, "ysk", "off");
	await command(h, "ysk");
	expect(notices.at(-1)).toContain("enabled for this session");
});

test("real Horizon compaction releases the old topic and new side questions preserve the resumed prefix", async () => {
	const h = await setup([horizon]);
	h.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 64 } });
	h.setResponses([fauxAssistantMessage("main before checkpoint")]);
	await h.session.prompt("synthetic task before compaction");
	h.setResponses([fauxAssistantMessage("second closed main turn")]);
	await h.session.prompt("Synthetic retained facts. ".repeat(100));
	h.setResponses([fauxAssistantMessage("old side answer")]);
	await command(h, "btw", "old side question");
	await settled(h);
	h.setResponses([fauxAssistantMessage("The synthetic task remains active. Continue from the retained facts.")]);
	await h.session.compact();
	expect(widgets.size).toBe(0);
	let main!: TranscriptContext;
	h.setResponses([
		(context: TranscriptContext) => {
			main = context;
			return fauxAssistantMessage("resumed main");
		},
	]);
	await h.session.prompt("continue after checkpoint");
	let side!: TranscriptContext;
	h.setResponses([
		(context: TranscriptContext) => {
			side = context;
			return fauxAssistantMessage("new side answer");
		},
	]);
	await command(h, "btw", "new side question");
	await settled(h);
	expect(side.messages.slice(0, main.messages.length)).toEqual(main.messages);
	expect(JSON.stringify(side)).not.toContain("old side answer");
	expect(JSON.stringify(side)).toContain("The synthetic task remains active");
});

test("payload guard rejects changed prompt/tools while accepting append-only side questions", () => {
	const main = {
		messages: [
			{ role: "system", content: "prefix" },
			{ role: "user", content: "task" },
		],
		tools: [{ name: "read" }],
		max_tokens: 20000,
	};
	const side = { ...main, messages: [...main.messages, { role: "user", content: "side" }], max_tokens: 8192 };
	expect(preservesPrefix(main, side)).toBe(true);
	expect(preservesPrefix(main, { ...side, tools: [] })).toBe(false);
	expect(
		preservesPrefix(main, { ...side, messages: [{ role: "system", content: "changed" }, ...side.messages.slice(1)] }),
	).toBe(false);
	expect(preservesPrefix({}, {})).toBe(false);
});

test("panel renders narrow/long replies safely and uses configurable selection bindings", async () => {
	const h = await setup();
	const topic: Topic = {
		context: { messages: [] } as unknown as TranscriptContext,
		model: h.getModel(),
		at: Date.now(),
		title: "Long question",
		kind: "btw",
		status: "ready",
		exchanges: [{ question: "why?", answer: "Long paragraph. ".repeat(500) }],
		partial: "",
	};
	let action = "";
	const keys = new KeybindingsManager({ "tui.select.down": "ctrl+n", "tui.select.confirm": "ctrl+j" });
	const ui = createTestUiContext();
	const panel = new TopicPanel(
		{ terminal: { rows: 24 }, requestRender() {} } as never,
		ui.theme,
		keys,
		topic,
		() => {},
		async () => {},
		(value) => {
			action = value;
		},
	);
	expect(panel.render(38).length).toBeLessThanOrEqual(24);
	panel.handleInput("\x0f");
	panel.handleInput("\x0a");
	expect(action).toBe("forward");
	expect(cleanText("safe\x1b]52;c;BAD\x07\x00text")).toBe("safetext");
});

function mockCompletions() {
	const requests: Record<string, unknown>[] = [];
	vi.stubEnv("PI_OFFLINE", undefined);
	vi.spyOn(globalThis, "fetch").mockImplementation(async (url, options) => {
		expect(String(url)).toBe("http://fixture.invalid/v1/chat/completions");
		const body = JSON.parse(String(options?.body));
		requests.push(body);
		const chunk = {
			id: `fixture-${requests.length}`,
			object: "chat.completion.chunk",
			created: 1,
			model: "fixture",
			choices: [
				{ index: 0, delta: { role: "assistant", content: `ANSWER_${requests.length}` }, finish_reason: "stop" },
			],
			usage: { prompt_tokens: 100, completion_tokens: 4, total_tokens: 104 },
		};
		return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
			headers: { "content-type": "text/event-stream" },
		});
	});
	return requests;
}

async function useCompletions(h: Awaited<ReturnType<typeof setup>>) {
	h.session.modelRuntime.registerProvider("prefix-fixture", {
		api: "openai-completions",
		baseUrl: "http://fixture.invalid/v1",
		apiKey: "synthetic-fixture-key",
		models: [
			{ id: "fixture", name: "Fixture", contextWindow: 32768, maxTokens: 8192, reasoning: false, input: ["text"] },
		],
	});
	await h.session.setModel(h.session.modelRuntime.getModel("prefix-fixture", "fixture"));
}

test("real OpenAI serialization preserves main prefix and the next main request excludes side dialogue", async () => {
	const requests = mockCompletions();
	const h = await setup();
	await useCompletions(h);
	await h.session.prompt("synthetic main task");
	await command(h, "btw", "side question");
	await settled(h);
	expect(requests).toHaveLength(2);
	expect(preservesPrefix(requests[0], requests[1])).toBe(true);
	expect(requests[1].tools).toEqual(requests[0].tools);
	await h.session.prompt("continue the main task");
	expect(requests).toHaveLength(3);
	expect(JSON.stringify(requests[2])).not.toContain("side question");
	expect(JSON.stringify(requests[2])).not.toContain("ANSWER_2");
});

test("a later context transform cannot accidentally send a cold side request", async () => {
	const requests = mockCompletions();
	const h = await setup([], undefined, [
		(pi) => {
			pi.on("context_with_system", (event) => ({
				messages: event.messages.map((message) =>
					message.role === "system" ? { ...message, content: "LATE_TRANSFORM" } : message,
				),
			}));
		},
	]);
	await useCompletions(h);
	await h.session.prompt("synthetic main task");
	await command(h, "btw", "side question");
	await settled(h);
	expect(requests).toHaveLength(1);
	expect(lastPanel.render(150).join("\n")).toContain("cached prefix");
});

test("policy-bound side inference fails closed for remote ZDR and retains runtime-only cache identity", async () => {
	const h = await setup();
	const { ModelRegistry } = await import(
		pathToFileURL(join(checkout, "packages/coding-agent/src/core/model-registry.ts")).href
	);
	const ctx = h.session.extensionRunner.createContext();
	const runtimeId = "synthetic-runtime-only-id";
	const guarded = {
		...ctx,
		modelRegistry: new ModelRegistry(h.session.modelRuntime, { remoteZdr: true, sessionId: runtimeId }),
	};
	const context = normalizeContext({ messages: [{ role: "user", content: "synthetic", timestamp: 0 }] });
	const source = { context, model: h.getModel(), at: Date.now() };
	await expect(answer(guarded, source, context, new AbortController().signal, () => {})).rejects.toThrow(
		"Side request failed",
	);
	expect(h.faux.state.callCount).toBe(0);
	let received!: SimpleStreamOptions;
	h.setResponses([
		(_context: TranscriptContext, options: SimpleStreamOptions) => {
			received = options;
			return fauxAssistantMessage("approved");
		},
	]);
	await answer(
		guarded,
		{ ...source, model: { ...source.model, zdr: true } },
		context,
		new AbortController().signal,
		() => {},
	);
	expect(received.sessionId).toBe(runtimeId);
	expect(received.sessionId).not.toBe(h.sessionManager.getSessionId());
	expect(received.allowModelFallbacks).toBe(false);
});
