import { normalizeContext } from "@earendil-works/pi-ai";
import { convertToLlm, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { TopicPanel, preview, showPreview, topicText, type PanelAction } from "./panel.ts";
import {
	answer,
	appendQuestion,
	BTW_PROMPT,
	OBSERVER_PROMPT,
	responseText,
	SideRequestError,
	type Snapshot,
	type Topic,
} from "./requests.ts";

const CHECK_TURNS = 6;
const COOLDOWN_MS = 120_000;

export default function youShouldKnow(pi: ExtensionAPI): void {
	let snapshot: Snapshot | undefined;
	let topic: Topic | undefined;
	let observation: Topic | undefined;
	let active: { topic: Topic; controller: AbortController; promise: Promise<void> } | undefined;
	let ui: ExtensionContext | undefined;
	let refreshPanel: (() => void) | undefined;
	let closePanel: (() => void) | undefined;
	let panelTopic: Topic | undefined;
	let enabled = false;
	let turns = 0;
	let checkedTurn = 0;
	let checkedAt = 0;
	let offeredTurn = 0;
	let backoff = 1;
	let observerError: string | undefined;
	let intent = 0;
	const seen: string[] = [];

	function render(): void {
		if (ui?.mode === "tui") {
			const finding = !panelTopic && observation?.unread ? observation : undefined;
			showPreview(ui, finding);
			const checking = active?.topic.kind === "observer";
			ui.ui.setStatus(
				"ysk",
				enabled && !finding ? ui.ui.theme.fg("dim", checking ? "◌ ysk · checking" : "ysk") : undefined,
			);
			const status =
				topic?.status === "working"
					? "answering"
					: topic?.unread
						? topic.status === "cancelled"
							? "stopped"
							: topic.status
						: undefined;
			ui.ui.setStatus("btw", !panelTopic && status ? ui.ui.theme.fg("muted", `btw · ${status}`) : undefined);
		}
		refreshPanel?.();
	}
	function cancel(): Promise<void> {
		if (!active) return Promise.resolve();
		active.topic.status = "cancelled";
		active.controller.abort();
		render();
		return active.promise;
	}
	function reset(): void {
		intent++;
		void cancel();
		snapshot = undefined;
		topic = undefined;
		observation = undefined;
		closePanel?.();
		render();
	}
	function remember(value: Topic): void {
		seen.push(preview(value.exchanges.at(-1)?.answer ?? "").slice(0, 600));
		if (seen.length > 8) seen.shift();
	}

	function run(ctx: ExtensionContext, target: Topic, text: string, question: string): void {
		const controller = new AbortController();
		const request = appendQuestion(target.context, text);
		const operation = { topic: target, controller, promise: Promise.resolve() };
		target.status = "working";
		target.partial = "";
		target.pendingQuestion = question;
		target.error = undefined;
		target.unread = false;
		active = operation;
		operation.promise = (async () => {
			try {
				const response = await answer(ctx, target, request, controller.signal, (text) => {
					if (active !== operation || controller.signal.aborted) return;
					target.partial = text;
					if (target.kind === "btw") render();
				});
				if (active !== operation || controller.signal.aborted) return;
				const text = responseText(response);
				target.partial = "";
				target.status = "ready";
				target.usage = response.usage;
				if (
					target.kind === "observer" &&
					(/^none[.!]?$/i.test(text) ||
						seen.some((old) => old.toLowerCase() === preview(text).slice(0, 600).toLowerCase()))
				)
					return;
				target.context = normalizeContext({
					messages: [...request.messages, response],
				});
				target.exchanges.push({ question, answer: text });
				target.pendingQuestion = undefined;
				if (target.kind === "observer") {
					target.title = preview(text).slice(0, 100);
					observation = target;
					offeredTurn = turns;
					remember(target);
				}
			} catch (error) {
				controller.abort();
				target.status = target.status === "cancelled" ? "cancelled" : "error";
				// Provider failures are deliberately generic; never echo request bodies or credentials.
				if (target.status === "error")
					target.error =
						error instanceof SideRequestError ? error.message : "Side request failed. The main task is unchanged.";
				if (target.kind === "observer") observerError = target.error;
			} finally {
				if (target.exchanges.length || target.status === "error" || target.status === "cancelled")
					target.unread = target !== panelTopic;
				if (active === operation) active = undefined;
				render();
			}
		})();
		render();
	}

	async function start(ctx: ExtensionContext, question: string, existing?: Topic): Promise<Topic | undefined> {
		const requestIntent = ++intent;
		await cancel();
		if (requestIntent !== intent) return;
		const source = existing ?? snapshot;
		if (!source) {
			ctx.ui.notify(
				"btw needs fresh context after opening or reloading a session. Send one message to the main agent first.",
				"info",
			);
			return;
		}
		if (source.model.api === "pi-virtual") {
			ctx.ui.notify("Wait for the routed model to finish this turn before asking a side question.", "info");
			return;
		}
		observation = undefined;
		topic = existing ?? {
			...source,
			title: question,
			kind: "btw",
			exchanges: [],
			partial: "",
			status: "ready",
		};
		topic.kind = "btw";
		run(ctx, topic, existing?.exchanges.length ? question : `${BTW_PROMPT}\n\n${question}`, question);
		return topic;
	}

	async function open(ctx: ExtensionContext, target: Topic): Promise<void> {
		if (closePanel) return;
		panelTopic = target;
		target.unread = false;
		backoff = 1;
		observerError = undefined;
		if (target === observation) offeredTurn = turns;
		let action: PanelAction;
		try {
			action = await ctx.ui.custom<PanelAction>((tui, theme, keys, done) => {
				refreshPanel = () => tui.requestRender();
				closePanel = () => done("close");
				render();
				return new TopicPanel(
					tui,
					theme,
					keys,
					target,
					() => {
						void cancel();
					},
					async (question) => {
						await start(ctx, question, target);
					},
					done,
				);
			});
		} finally {
			refreshPanel = undefined;
			closePanel = undefined;
			panelTopic = undefined;
			render();
		}
		if (target !== topic && target !== observation) return;
		if (action === "dismiss") {
			if (active?.topic === target) {
				intent++;
				await cancel();
			}
			if (observation === target) observation = undefined;
			if (topic === target) topic = undefined;
		} else if (action === "forward" && target.exchanges.length > 0) {
			const draft = ctx.ui.getEditorText();
			ctx.ui.setEditorText(`${draft}${draft ? "\n\n" : ""}Side conversation:\n\n${topicText(target)}`);
		}
		render();
	}

	pi.on("session_start", (_event, ctx) => {
		ui = ctx;
		enabled = false;
		reset();
		turns = checkedTurn = checkedAt = 0;
		backoff = 1;
		observerError = undefined;
		seen.length = 0;
	});
	// Observe without modifying main context. Payload validation also detects later transforms.
	pi.on("context_with_system", (event, ctx) => {
		if (ctx.mode !== "tui" || !ctx.model) return;
		ui = ctx;
		snapshot = {
			context: normalizeContext({ messages: convertToLlm(event.messages) }),
			model: ctx.model,
			reasoning: ctx.thinkingLevel,
			at: Date.now(),
		};
	});
	pi.on("before_provider_request", (event) => {
		if (snapshot) snapshot = { ...snapshot, payload: event.payload };
	});

	pi.on("turn_end", (event, ctx) => {
		if (!snapshot || event.outcome !== "completed" || event.message.role !== "assistant") return;
		const model = ctx.modelRegistry.find(event.message.provider, event.message.model);
		snapshot = {
			...snapshot,
			model: model ?? snapshot.model,
			context: normalizeContext({
				messages: [...snapshot.context.messages, event.message, ...event.toolResults],
			}),
		};
		turns++;
		if (observation && !closePanel && turns - offeredTurn >= CHECK_TURNS) {
			if (observation.unread) backoff = Math.min(4, backoff * 2);
			observation = undefined;
			render();
		}
		if (
			!enabled ||
			active ||
			observation ||
			ctx.mode !== "tui" ||
			turns - checkedTurn < CHECK_TURNS ||
			Date.now() - checkedAt < COOLDOWN_MS * backoff
		)
			return;
		checkedTurn = turns;
		checkedAt = Date.now();
		observerError = undefined;
		const target: Topic = {
			...snapshot,
			title: "An observation about this session",
			kind: "observer",
			exchanges: [],
			partial: "",
			status: "ready",
		};
		const previous = seen.length
			? `\n\nTopics already offered; avoid repeating them:\n${seen.map((line) => `- ${line}`).join("\n")}`
			: "";
		run(ctx, target, `${OBSERVER_PROMPT}${previous}`, "");
	});

	pi.registerCommand("btw", {
		description: "Ask a side question, or reopen the current topic. /btw cancel stops its answer.",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("btw is available in the terminal UI.", "info");
				return;
			}
			ui = ctx;
			const text = args.trim();
			if (text === "cancel") {
				intent++;
				await cancel();
				return;
			}
			const target = text ? await start(ctx, text) : topic;
			if (target) await open(ctx, target);
			else if (!text) ctx.ui.notify("Ask a side question with /btw <question>.", "info");
		},
	});
	pi.registerCommand("ysk", {
		description: "Enable You Should Know or open its finding. /ysk off disables it.",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("You Should Know is available in the terminal UI.", "info");
				return;
			}
			ui = ctx;
			switch (args.trim()) {
				case "off":
					enabled = false;
					if (active?.topic.kind === "observer") await cancel();
					observation = undefined;
					break;
				case "dismiss":
					observation = undefined;
					break;
				case "show":
					if (observation) await open(ctx, observation);
					else ctx.ui.notify("No observation to show.", "info");
					break;
				case "":
					if (!enabled) {
						enabled = true;
						checkedTurn = turns;
						checkedAt = Date.now();
						ctx.ui.notify(
							"You Should Know enabled for this session. Checks at turn end after 6 model turns and 2 minutes.",
							"info",
						);
					} else if (observation) await open(ctx, observation);
					else
						ctx.ui.notify(
							`You Should Know is on. ${active?.topic.kind === "observer" ? "Checking now." : "Checks at turn end after 6 model turns and 2 minutes; no idle timer."} /ysk off${observerError ? `\nLast check: ${observerError}` : ""}`,
							"info",
						);
					break;
				default:
					ctx.ui.notify("Usage: /ysk [off | show | dismiss]", "info");
			}
			render();
		},
	});

	pi.on("session_compact", reset);
	pi.on("session_tree", reset);
	pi.on("model_select", reset);
	pi.on("thinking_level_select", reset);
	pi.on("session_before_switch", reset);
	pi.on("session_before_fork", reset);
	pi.on("session_shutdown", async () => {
		enabled = false;
		reset();
		await cancel();
		ui = undefined;
	});
}
