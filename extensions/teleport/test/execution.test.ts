import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createRemoteBashOperations } from "../tools.ts";
import { WorkspaceClient } from "../workspace/client.ts";
import type { WorkerClient, WorkerResponse } from "../transport/worker-client.ts";
import { createProcessOperations } from "../worker/processes.mjs";

const directories: string[] = [];
const processes: ReturnType<typeof createProcessOperations>[] = [];
afterEach(async () => {
	vi.useRealTimers();
	for (const operations of processes.splice(0)) await operations.stopActiveCommands();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test.skipIf(process.platform === "win32")(
	"the worker enforces a deadline without a controller cancellation",
	async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-worker-deadline-"));
		directories.push(directory);
		const frames: Array<{ id: string; result: { timedOut: boolean; cancelled: boolean } }> = [];
		let output = "";
		const operations = createProcessOperations({
			cwd: directory,
			shellPath: "/bin/sh",
			cleanupDirectory: directory,
			resolveRemotePath: (path: string) => join(directory, path),
			writeFrame: (_type: number, frame: (typeof frames)[number]) => {
				frames.push(frame);
			},
			writeStreamingFrame: async (_type: number, _header: unknown, chunk: Buffer) => {
				output += chunk.toString();
			},
		});
		processes.push(operations);
		await operations.executeCommand("deadline", {
			command: "trap '' TERM; printf '%s' $$ > pid; printf ready; sleep 30; printf unexpected",
			timeout: 0.1,
		});
		expect(frames).toEqual([
			expect.objectContaining({ id: "deadline", result: expect.objectContaining({ timedOut: true, cancelled: true }) }),
		]);
		expect(output).toBe("ready");
		expect(() => process.kill(Number(readFileSync(join(directory, "pid"), "utf8")), 0)).toThrow();
		for (const timeout of [0, -1, Infinity, null, "1"]) {
			await expect(operations.executeCommand("invalid", { command: "printf forbidden", timeout })).rejects.toThrow(
				"timeout",
			);
		}
	},
);

test.each(["timeout", "abort"] as const)(
	"an unresponsive worker cannot hold %s settlement indefinitely",
	async (reason) => {
		vi.useFakeTimers();
		let rejectExecution!: (error: Error) => void;
		const execution = new Promise<WorkerResponse>((_resolve, reject) => {
			rejectExecution = reject;
		});
		const request = vi.fn<WorkerClient["request"]>((op) => ({
			id: op === "exec" ? "execution" : "cancel",
			promise: op === "exec" ? execution : Promise.resolve({ result: { accepted: true }, payload: Buffer.alloc(0) }),
		}));
		const invalidate = vi.fn((error: Error) => {
			rejectExecution(error);
		});
		const workspace = new WorkspaceClient({ request, invalidate });
		const operations = createRemoteBashOperations(
			workspace,
			{ cwd: "/workspace", home: "/home/fixture" },
			{
				async registerRemote(path) {
					return path;
				},
				invalidate() {},
			},
		);
		const controller = new AbortController();
		const result = operations.exec("controlled", "/workspace", { onData() {}, timeout: 1, signal: controller.signal });
		const outcome = result.catch((error: Error) => error);
		if (reason === "abort") controller.abort();
		else await vi.advanceTimersByTimeAsync(1000);
		expect(request).toHaveBeenCalledWith("exec", expect.objectContaining({ timeout: 1 }), expect.any(Function));
		expect(request).toHaveBeenCalledWith("cancel", { targetId: "execution" });
		await vi.advanceTimersByTimeAsync(4999);
		expect(invalidate).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(await outcome).toMatchObject({ message: "Teleport command termination could not be confirmed" });
		expect(invalidate).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	},
);
