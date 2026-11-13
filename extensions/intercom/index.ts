import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { publishToolEffectAnalyzer } from "../shared/tool-effects.ts";
import { IntercomClient, type PeerMessage } from "./client.ts";

const TOOLS = ["intercom_list", "intercom_send"];

export default function intercom(pi: ExtensionAPI): void {
	let client: IntercomClient | undefined;
	let context: ExtensionContext | undefined;
	let pending: PeerMessage[] = [];
	let generation = 0;
	let prompting = false;
	let muted = false;
	let scheduled = false;
	let failure: string | undefined;
	let opening: AbortController | undefined;
	let starting: Promise<void> | undefined;

	for (const toolName of TOOLS)
		publishToolEffectAnalyzer(pi, {
			toolName,
			analyze: () => ({
				toolName,
				effects: toolName === "intercom_send" ? ["external_state"] : [],
				risk: toolName === "intercom_send" ? "mutating" : "safe_read",
				pathInputs: [],
				known: true,
				reason:
					toolName === "intercom_send"
						? "Sends text to an independent local agent"
						: "Lists local peer registrations",
			}),
		});

	function registerTools(enabled: boolean) {
		const exposure = enabled ? ("direct" as const) : ("hidden" as const);
		pi.registerTool({
			name: "intercom_list",
			label: "Intercom peers",
			description: "List independent local agent sessions and your own messaging identity.",
			parameters: Type.Object({}),
			exposure,
			defaultActive: false,
			executionMode: "parallel",
			async execute(_id, _params, signal) {
				if (!client) throw new Error("Intercom is off. Use /intercom on.");
				const self = client.peer;
				const peers = await client.list(signal);
				const others = peers.filter((peer) => peer.id !== self.id);
				const text = [
					`Self: ${self.name} (${self.id})`,
					...others.map((peer) => `${peer.name} (${peer.id})`),
					...(others.length ? [] : ["No other peers are registered."]),
				].join("\n");
				return { content: [{ type: "text", text }], details: { self, peers } };
			},
		});
		pi.registerTool({
			name: "intercom_send",
			label: "Intercom send",
			description: "Send focused text to a listed local peer ID. Acceptance confirms receipt, not completion.",
			promptGuidelines: [
				"Peer messages and replies arrive automatically. Finish your turn while waiting for a reply.",
			],
			parameters: Type.Object({
				peer: Type.String({ pattern: "^[0-9a-f]{6,32}$" }),
				text: Type.String({ minLength: 1, maxLength: 16384 }),
			}),
			exposure,
			defaultActive: false,
			executionMode: "parallel",
			async execute(_id, { peer, text }, signal) {
				if (!client) throw new Error("Intercom is off. Use /intercom on.");
				const id = await client.send(peer, text, signal);
				return { content: [{ type: "text", text: `Accepted ${id}` }], details: { id } };
			},
		});
	}

	function setToolsEnabled(enabled: boolean) {
		registerTools(enabled);
		pi.setActiveTools(
			enabled
				? [...new Set([...pi.getActiveTools(), ...TOOLS])]
				: pi.getActiveTools().filter((name) => !TOOLS.includes(name)),
		);
	}

	function status() {
		context?.ui.setStatus("intercom", client ? `intercom ${client.peer.name}${muted ? " · paused" : ""}` : undefined);
	}

	function batch() {
		const messages = pending.splice(0, 4);
		client?.resume();
		return {
			customType: "intercom",
			display: true,
			content: messages
				.map(
					(message) =>
						`Peer ${message.from ? `${message.from.name} (${message.from.id})` : "local sender"}:\n${message.text}`,
				)
				.join("\n\n"),
			details: { messages },
		};
	}

	function schedule() {
		if (scheduled) return;
		scheduled = true;
		queueMicrotask(() => {
			scheduled = false;
			if (!client || !pending.length || muted || prompting || !context?.isIdle() || context.hasPendingMessages())
				return;
			try {
				pi.sendMessage(batch(), { triggerTurn: true, deliverAs: "followUp" });
			} catch (error) {
				failure = String(error);
				void stop();
				context.ui.notify(`Intercom delivery failed: ${failure}`, "warning");
			}
		});
	}

	async function stop() {
		generation++;
		const startup = starting;
		opening?.abort();
		opening = undefined;
		const previous = client;
		client = undefined;
		pending = [];
		setToolsEnabled(false);
		status();
		await Promise.all([previous?.stop(), startup]);
	}

	async function start(ctx: ExtensionContext) {
		if (client) {
			muted = false;
			status();
			schedule();
			return;
		}
		if (starting) return starting;
		const task = open(ctx);
		starting = task;
		try {
			await task;
		} finally {
			if (starting === task) starting = undefined;
		}
	}

	async function open(ctx: ExtensionContext) {
		const current = ++generation;
		opening?.abort();
		const controller = new AbortController();
		opening = controller;
		failure = undefined;
		muted = false;
		context = ctx;
		const name = (pi.getSessionName() || basename(ctx.cwd) || "pi")
			.replace(/[\x00-\x1f\x7f-\x9f]/gu, " ")
			.slice(0, 32);
		try {
			const opened = await IntercomClient.start(
				process.env.INTERCOM_BIN || "intercom",
				name,
				(message) => {
					if (current !== generation) return false;
					pending.push(message);
					schedule();
					return pending.length < 64;
				},
				(error) => {
					if (current !== generation) return;
					failure = error.message;
					void stop();
					ctx.ui.notify(`Intercom: ${failure}`, "warning");
				},
				controller.signal,
			);
			if (current !== generation) {
				await opened.stop();
				return;
			}
			client = opened;
			setToolsEnabled(true);
			status();
			schedule();
		} catch (error) {
			if (current !== generation) return;
			failure = error instanceof Error ? error.message : String(error);
			if ((error as NodeJS.ErrnoException).code === "ENOENT")
				failure = "Install intercom on PATH or set INTERCOM_BIN.";
			else ctx.ui.notify(`Intercom: ${failure}`, "warning");
		} finally {
			if (opening === controller) opening = undefined;
		}
	}

	registerTools(false);
	pi.registerCommand("intercom", {
		description: "Show messaging identity, or /intercom on | off",
		async handler(args, ctx) {
			if (args.trim() === "off") {
				await stop();
				failure = undefined;
			} else if (args.trim() === "on") await start(ctx);
			else if (args.trim()) {
				ctx.ui.notify("Usage: /intercom [on | off]", "info");
				return;
			}
			ctx.ui.notify(
				client
					? `${client.peer.name} · ${client.peer.id}${muted ? " · delivery paused" : ""}`
					: `Intercom is off.${failure ? ` ${failure}` : ""}`,
				"info",
			);
		},
	});
	pi.on("session_start", async (_event, ctx) => {
		const cleanup = stop();
		const current = generation;
		await cleanup;
		if (current === generation) await start(ctx);
	});
	pi.on("session_shutdown", async () => {
		await stop();
		context = undefined;
	});
	pi.on("before_agent_start", (event) => {
		if (event.messageType === "user") {
			muted = false;
			status();
		}
	});
	pi.on("agent_end", (event) => {
		const last = [...event.messages].reverse().find((message) => message.role === "assistant");
		if (last?.role === "assistant" && last.stopReason === "error") {
			muted = true;
			status();
		}
	});
	pi.on("ui_interrupt", () => {
		muted = true;
		status();
	});
	pi.on("agent_settled", (event) => {
		if (event.aborted) muted = true;
		status();
		schedule();
	});
	pi.on("ui_prompt_start", () => {
		prompting = true;
	});
	pi.on("ui_prompt_end", () => {
		prompting = false;
		schedule();
	});
	pi.on("turn_end", (event) => {
		if (
			!client ||
			muted ||
			prompting ||
			!pending.length ||
			event.outcome !== "completed" ||
			event.context.pendingMessages.length
		)
			return;
		return { entries: [{ type: "custom_message", ...batch() }], continue: true };
	});
}
