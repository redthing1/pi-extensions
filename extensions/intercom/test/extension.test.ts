import { EventEmitter } from "node:events";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeEach, expect, test, vi } from "vitest";
import intercom from "../index.ts";
import type { PeerMessage } from "../client.ts";
import { isTeleportClientTool } from "../../teleport/tools.ts";

const transport = vi.hoisted(() => ({ start: vi.fn() }));
vi.mock("../client.ts", () => ({ IntercomClient: transport }));

function setup() {
	const handlers = new Map<string, (...args: any[]) => any>();
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const receivers: { receive: (message: PeerMessage) => boolean; exit: (error: Error) => void; client: any }[] = [];
	let active: string[] = ["bash"];
	let idle = true;
	let loading = true;
	const ctx = {
		cwd: "/workspace/api",
		isIdle: () => idle,
		hasPendingMessages: () => false,
		ui: { notify: vi.fn(), setStatus: vi.fn() },
	};
	const pi = {
		events: new EventEmitter(),
		on: (event: string, handler: (...args: any[]) => any) => handlers.set(event, handler),
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerCommand: (name: string, command: any) => commands.set(name, command),
		getActiveTools: () => {
			if (loading) throw new Error("Runtime actions are unavailable during loading");
			return active;
		},
		setActiveTools: (names: string[]) => {
			if (loading) throw new Error("Runtime actions are unavailable during loading");
			active = names;
		},
		getSessionName: () => "api",
		sendMessage: vi.fn(() => {
			idle = false;
		}),
	};
	transport.start.mockImplementation(async (_binary, _name, receive, exit) => {
		const client = {
			peer: { id: (receivers.length + 1).toString(16).padStart(32, "0"), name: "api" },
			stop: vi.fn(async () => {}),
			resume: vi.fn(),
			list: vi.fn(async () => []),
			send: vi.fn(async () => "b".repeat(32)),
		};
		receivers.push({ receive, exit, client });
		return client;
	});
	intercom(pi as unknown as ExtensionAPI);
	loading = false;
	return {
		pi,
		ctx,
		tools,
		receivers,
		active: () => active,
		emit: (event: string, payload: unknown = {}) => {
			if (event === "agent_start" || event === "before_agent_start") idle = false;
			if (event === "agent_settled") idle = true;
			return handlers.get(event)?.(payload, ctx);
		},
		command: (args: string) => commands.get("intercom").handler(args, ctx),
	};
}

const message: PeerMessage = { id: "a".repeat(32), from: { id: "c".repeat(32), name: "review" }, text: "Ready" };
const completed = { outcome: "completed", context: { pendingMessages: [] } };
beforeEach(() => vi.clearAllMocks());

test("an installed receiver enables local tools and idle custom input", async () => {
	const app = setup();
	expect(app.tools.get("intercom_send").exposure).toBe("hidden");
	await app.emit("session_start");
	expect(app.active()).toEqual(["bash", "intercom_list", "intercom_send"]);
	app.receivers[0].receive(message);
	await Promise.resolve();
	expect(app.pi.sendMessage).toHaveBeenCalledWith(
		expect.objectContaining({ customType: "intercom", details: { messages: [message] } }),
		{ triggerTurn: true, deliverAs: "followUp" },
	);
	app.receivers[0].receive(message);
	await Promise.resolve();
	expect(app.pi.sendMessage).toHaveBeenCalledTimes(1);
	expect(app.emit("turn_end", completed)).toMatchObject({
		continue: true,
		entries: [{ type: "custom_message", details: { messages: [message] } }],
	});
	await app.emit("session_shutdown");
});

test("busy delivery is bounded and respects pending user input", async () => {
	const app = setup();
	await app.emit("session_start");
	app.emit("agent_start");
	for (let i = 0; i < 64; i++) expect(app.receivers[0].receive(message)).toBe(i < 63);
	expect(app.emit("turn_end", { outcome: "completed", context: { pendingMessages: [{}] } })).toBeUndefined();
	const result = app.emit("turn_end", completed);
	expect(result.entries[0].details.messages).toHaveLength(4);
	expect(app.receivers[0].client.resume).toHaveBeenCalledTimes(1);
	expect(app.pi.sendMessage).not.toHaveBeenCalled();
	await app.emit("session_shutdown");
});

test("Escape pauses delivery until a user prompt or explicit resume", async () => {
	const app = setup();
	await app.emit("session_start");
	app.emit("ui_interrupt");
	app.receivers[0].receive(message);
	await Promise.resolve();
	expect(app.pi.sendMessage).not.toHaveBeenCalled();
	expect(app.emit("turn_end", completed)).toBeUndefined();
	await app.command("on");
	expect(app.pi.sendMessage).toHaveBeenCalledTimes(1);
	app.emit("agent_settled", { aborted: true });
	app.receivers[0].receive(message);
	await Promise.resolve();
	expect(app.pi.sendMessage).toHaveBeenCalledTimes(1);
	app.emit("before_agent_start", { messageType: "user" });
	expect(app.emit("turn_end", completed)).toMatchObject({ continue: true });
	await app.emit("session_shutdown");
});

test("replacement closes the old receiver and rejects its late events", async () => {
	const app = setup();
	await app.emit("session_start");
	const old = app.receivers[0];
	await app.emit("session_shutdown");
	await app.emit("session_start");
	expect(old.client.stop).toHaveBeenCalledTimes(1);
	expect(app.receivers[1].client.peer.id).not.toBe(old.client.peer.id);
	expect(old.receive(message)).toBe(false);
	old.exit(new Error("old exit"));
	expect(app.active()).toContain("intercom_send");
	await app.emit("session_shutdown");
});

test("messaging remains a client operation when a remote workspace disconnects", async () => {
	const app = setup();
	await app.emit("session_start");
	app.pi.events.emit("rt1.active-workspace.v1", { phase: "failed", label: "fixture", reason: "disconnected" });
	for (const name of ["intercom_list", "intercom_send"]) expect(isTeleportClientTool(name)).toBe(true);
	expect(isTeleportClientTool("bash")).toBe(false);
	const signal = new AbortController().signal;
	await app.tools.get("intercom_send").execute("call", { peer: message.from!.id, text: message.text }, signal);
	expect(app.receivers[0].client.send).toHaveBeenCalledWith(message.from!.id, "Ready", signal);
	await app.emit("session_shutdown");
});

test("missing binaries stay quiet and receiver failure withdraws tools", async () => {
	const app = setup();
	transport.start.mockRejectedValueOnce(Object.assign(new Error("missing"), { code: "ENOENT" }));
	await app.emit("session_start");
	expect(app.active()).toEqual(["bash"]);
	expect(app.ctx.ui.notify).not.toHaveBeenCalled();
	await app.command("");
	expect(app.ctx.ui.notify.mock.calls[0][0]).toContain("PATH");
	await app.command("on");
	app.receivers[0].exit(new Error("lost receiver"));
	expect(app.active()).toEqual(["bash"]);
	expect(app.tools.get("intercom_send").exposure).toBe("hidden");
	await app.emit("session_shutdown");
});

test("session shutdown cancels and waits for a pending receiver startup", async () => {
	const app = setup();
	let finishCleanup!: () => void;
	let aborted = false;
	let began!: () => void;
	const started = new Promise<void>((resolve) => {
		began = resolve;
	});
	transport.start.mockImplementationOnce(
		(_binary, _name, _receive, _exit, signal) =>
			new Promise((_resolve, reject) => {
				signal.addEventListener("abort", () => {
					aborted = true;
					finishCleanup = () => reject(new Error("cancelled"));
				});
				began();
			}),
	);
	const opening = app.emit("session_start");
	await started;
	const closing = app.emit("session_shutdown");
	expect(aborted).toBe(true);
	let closed = false;
	void closing.then(() => {
		closed = true;
	});
	await Promise.resolve();
	expect(closed).toBe(false);
	finishCleanup();
	await Promise.all([opening, closing]);
	expect(app.active()).toEqual(["bash"]);
});

test("shutdown prevents a queued session start from opening a receiver", async () => {
	const app = setup();
	const opening = app.emit("session_start");
	const closing = app.emit("session_shutdown");
	await Promise.all([opening, closing]);
	expect(transport.start).not.toHaveBeenCalled();
	expect(app.active()).toEqual(["bash"]);
});

test("peer input waits for an open user dialog", async () => {
	const app = setup();
	await app.emit("session_start");
	app.emit("ui_prompt_start");
	app.receivers[0].receive(message);
	await Promise.resolve();
	expect(app.pi.sendMessage).not.toHaveBeenCalled();
	expect(app.emit("turn_end", completed)).toBeUndefined();
	app.emit("ui_prompt_end");
	await Promise.resolve();
	expect(app.pi.sendMessage).toHaveBeenCalledTimes(1);
	await app.emit("session_shutdown");
});

test("a failed run pauses automatic delivery until explicit resume", async () => {
	const app = setup();
	await app.emit("session_start");
	app.emit("agent_start");
	app.receivers[0].receive(message);
	app.emit("agent_end", { messages: [{ role: "assistant", stopReason: "error" }] });
	app.emit("agent_settled", { aborted: false });
	await Promise.resolve();
	expect(app.pi.sendMessage).not.toHaveBeenCalled();
	await app.command("on");
	expect(app.pi.sendMessage).toHaveBeenCalledTimes(1);
	await app.emit("session_shutdown");
});

test("later input remains deliverable when a model run never starts", async () => {
	const app = setup();
	await app.emit("session_start");
	app.pi.sendMessage.mockImplementationOnce(() => {});
	app.receivers[0].receive(message);
	await Promise.resolve();
	app.receivers[0].receive(message);
	await Promise.resolve();
	expect(app.pi.sendMessage).toHaveBeenCalledTimes(2);
	await app.emit("session_shutdown");
});
