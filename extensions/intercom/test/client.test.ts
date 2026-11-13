import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { IntercomClient } from "../client.ts";

const processes = vi.hoisted(() => ({ spawn: vi.fn(), execFile: vi.fn() }));
vi.mock("node:child_process", () => processes);

const peer = { id: "a".repeat(32), name: "api" };
const message = { id: "b".repeat(32), from: peer, text: "Ready 🦀" };

function childProcess(ignoreShutdown = false) {
	const child = Object.assign(new EventEmitter(), {
		stdin: new PassThrough(),
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		exitCode: null as number | null,
		signalCode: null as NodeJS.Signals | null,
		kill: vi.fn((signal: NodeJS.Signals) => {
			if (ignoreShutdown) return true;
			child.signalCode = signal;
			queueMicrotask(() => child.emit("close", null, signal));
			return true;
		}),
	});
	child.stdin.on("finish", () => {
		if (ignoreShutdown) return;
		child.exitCode = 0;
		queueMicrotask(() => child.emit("close", 0, null));
	});
	processes.spawn.mockReturnValue(child);
	return child;
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.useRealTimers());

test.each(["Ready 🦀", "\uFEFF"])("readiness validates protocol and complete UTF-8 events: %j", async (text) => {
	const child = childProcess();
	const receive = vi.fn(() => true);
	const opened = IntercomClient.start("intercom", "api", receive, vi.fn());
	child.stdout.write(JSON.stringify({ event: "ready", protocol: 1, peer }) + "\n");
	const client = await opened;
	expect(client.peer).toEqual(peer);
	const incoming = { ...message, text };
	const frame = Buffer.from(JSON.stringify({ event: "message", message: incoming }) + "\n");
	child.stdout.write(frame.subarray(0, frame.length - 5));
	await new Promise((resolve) => setImmediate(resolve));
	expect(receive).not.toHaveBeenCalled();
	child.stdout.write(frame.subarray(frame.length - 5));
	await new Promise((resolve) => setImmediate(resolve));
	expect(receive).toHaveBeenCalledWith(incoming);
	await client.stop();
	expect(child.stdin.writableEnded).toBe(true);
});

test("receive backpressure leaves later events unread until resumed", async () => {
	const child = childProcess();
	const receive = vi.fn(() => false);
	const opened = IntercomClient.start("intercom", "api", receive, vi.fn());
	child.stdout.write(JSON.stringify({ event: "ready", protocol: 1, peer }) + "\n");
	const client = await opened;
	const frame = JSON.stringify({ event: "message", message }) + "\n";
	child.stdout.write(frame + frame);
	await new Promise((resolve) => setImmediate(resolve));
	expect(receive).toHaveBeenCalledTimes(1);
	client.resume();
	await new Promise((resolve) => setImmediate(resolve));
	expect(receive).toHaveBeenCalledTimes(2);
	await client.stop();
});

test("incompatible startup closes the owned process without exposing a peer", async () => {
	const child = childProcess();
	const exited = vi.fn();
	const opened = IntercomClient.start("intercom", "api", vi.fn(), exited);
	child.stdout.write(JSON.stringify({ event: "ready", protocol: 2, peer }) + "\n");
	await expect(opened).rejects.toThrow("Protocol 1");
	expect(child.stdin.writableEnded).toBe(true);
	expect(exited).not.toHaveBeenCalled();
});

test("startup can be cancelled before readiness", async () => {
	const child = childProcess();
	const controller = new AbortController();
	const opened = IntercomClient.start("intercom", "api", vi.fn(), vi.fn(), controller.signal);
	controller.abort();
	await expect(opened).rejects.toThrow("cancelled");
	expect(child.stdin.writableEnded).toBe(true);
});

test("startup without readiness expires and closes its owned process", async () => {
	vi.useFakeTimers();
	const child = childProcess();
	const opened = IntercomClient.start("intercom", "api", vi.fn(), vi.fn());
	const result = expect(opened).rejects.toThrow("did not become ready");
	await vi.advanceTimersByTimeAsync(3000);
	await result;
	expect(child.stdin.writableEnded).toBe(true);
});

test("shutdown escalates only its owned process within one second", async () => {
	vi.useFakeTimers();
	const child = childProcess(true);
	const opened = IntercomClient.start("intercom", "api", vi.fn(), vi.fn());
	child.stdout.write(JSON.stringify({ event: "ready", protocol: 1, peer }) + "\n");
	await vi.advanceTimersByTimeAsync(0);
	const client = await opened;
	const stopped = client.stop();
	await vi.advanceTimersByTimeAsync(1000);
	await stopped;
	expect(child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
});

test("commands use literal local arguments, current identity and bounded execution", async () => {
	const child = childProcess();
	const opened = IntercomClient.start("/reviewed/intercom", "api", vi.fn(), vi.fn());
	child.stdout.write(JSON.stringify({ event: "ready", protocol: 1, peer }) + "\n");
	const client = await opened;
	const controller = new AbortController();
	processes.execFile.mockImplementation((_binary, _args, _options, callback) =>
		callback(null, JSON.stringify({ status: "accepted", id: message.id })),
	);
	expect(await client.send("c".repeat(32), "--json", controller.signal)).toBe(message.id);
	expect(processes.execFile).toHaveBeenCalledWith(
		"/reviewed/intercom",
		["--json", "send", "c".repeat(32), "--json", "--from", peer.id],
		expect.objectContaining({ timeout: 3000, killSignal: "SIGKILL", signal: expect.any(AbortSignal) }),
		expect.any(Function),
	);
	const signal = processes.execFile.mock.calls[0][2].signal as AbortSignal;
	expect(signal.aborted).toBe(false);
	controller.abort();
	expect(signal.aborted).toBe(true);
	processes.execFile.mockImplementation((_binary, _args, _options, callback) =>
		callback(new Error("exit 1"), JSON.stringify({ error: { code: "busy", message: "Receiver queue is full" } })),
	);
	await expect(client.send("c".repeat(32), "hello")).rejects.toThrow("queue is full");
	await client.stop();
});

test("malformed or oversized events withdraw an established receiver", async () => {
	const child = childProcess();
	const exited = vi.fn();
	const opened = IntercomClient.start("intercom", "api", vi.fn(), exited);
	child.stdout.write(JSON.stringify({ event: "ready", protocol: 1, peer }) + "\n");
	const client = await opened;
	child.stdout.write("x".repeat(128 * 1024 + 1));
	await new Promise((resolve) => setImmediate(resolve));
	expect(exited).toHaveBeenCalledTimes(1);
	expect(exited.mock.calls[0][0].message).toContain("128 KiB");
	await client.stop();
});

test("receiver death is observed while output is backpressured", async () => {
	const child = childProcess();
	const exited = vi.fn();
	const receive = vi.fn(() => false);
	const opened = IntercomClient.start("intercom", "api", receive, exited);
	child.stdout.write(JSON.stringify({ event: "ready", protocol: 1, peer }) + "\n");
	const client = await opened;
	const frame = JSON.stringify({ event: "message", message }) + "\n";
	child.stdout.write(frame + frame);
	await new Promise((resolve) => setImmediate(resolve));
	expect(receive).toHaveBeenCalledTimes(1);
	child.exitCode = 1;
	child.emit("exit", 1, null);
	expect(exited).toHaveBeenCalledTimes(1);
	expect(child.stdout.destroyed).toBe(true);
	await client.stop();
});

test("stopping a receiver cancels its outstanding CLI commands", async () => {
	const child = childProcess();
	const opened = IntercomClient.start("intercom", "api", vi.fn(), vi.fn());
	child.stdout.write(JSON.stringify({ event: "ready", protocol: 1, peer }) + "\n");
	const client = await opened;
	processes.execFile.mockImplementation((_binary, _args, options, callback) => {
		options.signal.addEventListener("abort", () =>
			callback(Object.assign(new Error("cancelled"), { name: "AbortError" }), ""),
		);
	});
	const request = expect(client.list()).rejects.toMatchObject({ name: "AbortError" });
	await client.stop();
	await request;
});
