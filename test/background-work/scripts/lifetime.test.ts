import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createBashToolDefinition, initTheme } from "@earendil-works/pi-coding-agent";
import background from "../../../extensions/background-work/index.ts";
import { Jobs } from "../../../extensions/background-work/jobs.ts";

const { createHarness, createTestUiContext, getToolResult, getMessageText } = await import(
	pathToFileURL(
		join(process.env.PI_BACKGROUND_CHECKOUT!, "packages/coding-agent/test/suite/harness.ts"),
	).href
);
const harnesses: Awaited<ReturnType<typeof createHarness>>[] = [];
const owners: Jobs[] = [];
afterEach(async () => {
	vi.useRealTimers();
	for (const owner of owners.splice(0)) await owner.close();
	for (const h of harnesses.splice(0)) {
		await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "exit" });
		h.cleanup();
	}
});
const answer = (text: string) => fauxAssistantMessage(text);
const call = (args: Record<string, unknown>) =>
	fauxAssistantMessage(fauxToolCall("bash", args), { stopReason: "toolUse" });

async function controlled(abortDiagnostic = "aborted") {
	const h = await createHarness();
	harnesses.push(h);
	const pending = new Map<string, () => void>();
	let launches = 0;
	const shell = createBashToolDefinition(h.tempDir, {
		operations: {
			async exec(command, _cwd, { signal, onData }) {
				launches++;
				await new Promise<void>((resolve, reject) => {
					const abort = () => reject(new Error(abortDiagnostic));
					if (signal?.aborted) {
						abort();
						return;
					}
					signal?.addEventListener("abort", abort, { once: true });
					pending.set(command, () => {
						signal?.removeEventListener("abort", abort);
						resolve();
					});
				});
				onData(Buffer.from("retained result"));
				return { exitCode: 0 };
			},
		},
	});
	const owner = new Jobs(() => {});
	owners.push(owner);
	const start = (name: string, detached = true) =>
		owner.start(
			shell,
			name,
			{ command: name },
			name,
			h.session.extensionRunner.createToolContext(name, undefined),
			undefined,
			undefined,
			detached,
		);
	return { owner, start, finish: (name: string) => pending.get(name)!(), launches: () => launches };
}

test("admission reserves capacity for foreground and background launches", async () => {
	const { owner, start, launches } = await controlled();
	const foreground = await start("foreground", false);
	const jobs = await Promise.all(Array.from({ length: 7 }, (_, n) => start(String(n))));
	await expect(start("excess")).rejects.toThrow("At most 8");
	await expect(start("excess-foreground", false)).rejects.toThrow("At most 8");
	expect(launches()).toBe(8);
	expect(foreground.background).toBe(false);
	expect(foreground.controller.signal.aborted).toBe(false);
	expect(foreground.promote()).toBe(true);
	owner.stop(jobs[0]);
	await jobs[0].done;
	await start("replacement");
});

test("foreground work automatically promotes once without restarting its invocation", async () => {
	const { owner, start, finish, launches } = await controlled();
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	const job = await start("foreground", false);
	await vi.advanceTimersByTimeAsync(29_999);
	expect(job.background).toBe(false);
	await vi.advanceTimersByTimeAsync(1);
	expect(job.background).toBe(true);
	expect(job.promotion).toBe("automatic");
	expect(launches()).toBe(1);
	expect(job.promote()).toBe(false);
	finish("foreground");
	await job.done;
	expect(vi.getTimerCount()).toBe(0);
});

test("retention evicts delivered records only and never silently loses pending results", async () => {
	const { owner, start, finish } = await controlled();
	for (let n = 0; n < 64; n++) {
		const job = await start(String(n));
		finish(String(n));
		await job.done;
	}
	await expect(start("blocked")).rejects.toThrow("awaiting inspection");
	expect(owner.entries.size).toBe(64);
	owner.get("1").announced = true;
	const next = await start("new");
	expect(() => owner.get("1")).toThrow("expired");
	expect(owner.get("2").preview).toContain("retained result");
	expect(owner.entries.size).toBe(64);
	finish("new");
	await next.done;
});

test.each(["stop", "close"] as const)("%s settles an outstanding wait", async (action) => {
	const { owner, start } = await controlled();
	const job = await start("pending");
	const waiting = owner.wait(job);
	if (action === "stop") owner.stop(job);
	else await owner.close();
	await waiting;
	expect(job.state).toBe("stopped");
	expect(job.announced).toBe(true);
});

test("unconfirmed termination is a failure rather than a confirmed stop", async () => {
	const { owner, start } = await controlled("Command termination could not be confirmed");
	const job = await start("pending");
	owner.stop(job);
	await job.done;
	expect(job.state).toBe("failed");
	expect(job.diagnostic).toBe("Command termination could not be confirmed");
});

test.each([false, true])(
	"aborting a wait does not cancel or collect the job (already aborted=%s)",
	async (alreadyAborted) => {
		const { owner, start, finish } = await controlled();
		const job = await start("pending");
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const controller = new AbortController();
		if (alreadyAborted) controller.abort();
		const waiting = owner.wait(job, controller.signal);
		controller.abort();
		await expect(waiting).rejects.toThrow("Stopped waiting");
		expect(vi.getTimerCount()).toBe(0);
		expect(owner.promote()).toBeUndefined();
		expect(job.controller.signal.aborted).toBe(false);
		expect(job.announced).toBe(false);
		finish("pending");
		await job.done;
		expect(job.announced).toBe(false);
		await owner.wait(job);
		expect(job.announced).toBe(true);
	},
);

test.each([false, true])("the 60-second wait limit preserves work and notification policy (muted=%s)", async (muted) => {
	const { owner, start, finish } = await controlled();
	const job = await start("pending");
	if (muted) owner.mute();
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	let settled = false;
	const waiting = owner.wait(job).then((outcome) => { settled = true; return outcome; });
	await vi.advanceTimersByTimeAsync(59_999);
	expect(settled).toBe(false);
	await vi.advanceTimersByTimeAsync(1);
	expect(await waiting).toBe("timeout");
	expect(job.controller.signal.aborted).toBe(false);
	expect(job.announced).toBe(false);
	expect(job.wake).toBe(!muted);
	expect(owner.promote()).toBeUndefined();
	expect(vi.getTimerCount()).toBe(0);
	finish("pending");
	await job.done;
	expect(await owner.wait(job)).toBe("completed");
});

test("completion before the deadline collects once and clears the timer and release handle", async () => {
	const { owner, start, finish } = await controlled();
	const job = await start("pending");
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	const waiting = owner.wait(job);
	await vi.advanceTimersByTimeAsync(59_999);
	finish("pending");
	await job.done;
	expect(owner.promote()).toBeUndefined();
	expect(await waiting).toBe("completed");
	expect(job.announced).toBe(true);
	expect(vi.getTimerCount()).toBe(0);
});

test("stop settlement has no release action or wait deadline", async () => {
	const { owner, start } = await controlled();
	const job = await start("pending");
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	let settled = false;
	const waiting = owner.wait(job, undefined, "stop").then(() => { settled = true; });
	await vi.advanceTimersByTimeAsync(120_000);
	expect(settled).toBe(false);
	expect(owner.promote()).toBeUndefined();
	expect(vi.getTimerCount()).toBe(0);
	owner.stop(job);
	await waiting;
	expect(job.state).toBe("stopped");
});

test("released and expired waits do not collect a later completion", async () => {
	const { owner, start, finish } = await controlled();
	const job = await start("pending");
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	for (let n = 0; n < 3; n++) {
		const waiting = owner.wait(job);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(await waiting).toBe("timeout");
	}
	const released = owner.wait(job);
	expect(owner.promote()).toBe(job);
	expect(await released).toBe("released");
	finish("pending");
	await job.done;
	expect(job.announced).toBe(false);
	expect(job.wake).toBe(true);
	expect(vi.getTimerCount()).toBe(0);
	expect(owner.promote()).toBeUndefined();
});

test("ambiguous foreground work is not released", async () => {
	const { owner, start, finish } = await controlled();
	const first = await start("first");
	const second = await start("second", false);
	const waiting = owner.wait(first);
	expect(() => owner.promote()).toThrow("More than one");
	expect(second.background).toBe(false);
	finish("first");
	expect(await waiting).toBe("completed");
	owner.stop(second);
	await second.done;
});

test.each(["print", "json", "rpc"] as const)(
	"%s omits managed tools and rejects background before dispatch",
	async (mode) => {
		let launches = 0;
		const h = await createHarness({
			extensionFactories: [
				background,
				(pi) =>
					pi.on("bash_launch", () => ({
						operations: {
							async exec() {
								launches++;
								return { exitCode: 0 };
							},
						},
					})),
			],
		});
		harnesses.push(h);
		await h.session.bindExtensions({ mode });
		expect(h.session.getActiveToolNames()).not.toContain("background_status");
		expect(h.session.getActiveToolNames()).not.toContain("background_wait");
		expect(h.session.getToolDefinition("bash").parameters.properties).not.toHaveProperty(
			"background",
		);
		h.setResponses([call({ command: "synthetic", background: true }), answer("Rejected.")]);
		await h.session.prompt("Try unsupported background work.");
		expect(getToolResult(h, "bash").isError).toBe(true);
		expect(launches).toBe(0);
		h.setResponses([call({ command: "synthetic" }), answer("Done.")]);
		await h.session.prompt("Run ordinary foreground work.");
		expect(launches).toBe(1);
	},
);

test("shutdown settles a pending output write before clearing job records", async () => {
	let releaseWrite!: () => void;
	let outputPath: string | undefined;
	let writing = false;
	let releaseProcess!: () => void;
	const processDone = new Promise<void>((resolve) => {
		releaseProcess = resolve;
	});
	const h = await createHarness({
		extensionFactories: [
			(pi) => {
				pi.on("output_file", async (_event, ctx) => {
					writing = true;
					await new Promise<void>((resolve) => {
						releaseWrite = resolve;
					});
					// Return to the core writer after the gate; no secondary storage owner.
					return undefined;
				});
			},
		],
	});
	harnesses.push(h);
	const owner = new Jobs(() => {});
	owners.push(owner);
	const native = createBashToolDefinition(h.tempDir, {
		operations: {
			async exec(_c, _d, { onData }) {
				await processDone;
				onData(Buffer.from("x".repeat(8000)));
				return { exitCode: 0 };
			},
		},
	});
	const job = await owner.start(
		native,
		"output",
		{ command: "synthetic" },
		"output",
		h.session.extensionRunner.createToolContext("output", undefined),
		undefined,
		undefined,
		true,
	);
	releaseProcess();
	await vi.waitFor(() => expect(writing).toBe(true));
	let collected = false;
	const waiting = owner.wait(job).then(() => {
		collected = true;
	});
	let closed = false;
	const closing = owner.close().then(() => {
		closed = true;
	});
	await Promise.resolve();
	expect(closed).toBe(false);
	expect(collected).toBe(false);
	releaseWrite();
	await closing;
	await waiting;
	outputPath = job.fullOutputPath;
	expect(outputPath).toBeTruthy();
	expect(existsSync(outputPath!)).toBe(true);
	expect(owner.entries.size).toBe(0);
	h.session.dispose();
	expect(existsSync(outputPath!)).toBe(false);
});

test.each([false, true])(
	"compaction preserves completion unless explicitly interrupted (aborted=%s)",
	async (aborted) => {
		initTheme("dark", false);
		let finish!: () => void;
		const pending = new Promise<void>((resolve) => {
			finish = resolve;
		});
		let compacting!: () => void;
		const entered = new Promise<void>((resolve) => {
			compacting = resolve;
		});
		const h = await createHarness({
			settings: { compaction: { enabled: false, keepRecentTokens: 1 } },
			extensionFactories: [
				background,
				(pi) => {
					pi.on("bash_launch", () => ({
						operations: {
							async exec(_c, _d, { onData, signal }) {
								await pending;
								if (signal?.aborted) throw new Error("aborted");
								onData(Buffer.from("completion across compaction"));
								return { exitCode: 0 };
							},
						},
					}));
					pi.on("session_before_compact", async (event) => {
						compacting();
						if (aborted)
							return new Promise<{ cancel: true }>((resolve) =>
								event.signal.addEventListener("abort", () => resolve({ cancel: true }), {
									once: true,
								}),
							);
						finish();
						await new Promise<void>((resolve) => setImmediate(resolve));
						expect(h.session.messages.filter((m) => m.role === "custom")).toHaveLength(0);
						return {
							compaction: {
								summary: "Synthetic summary",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
							},
						};
					});
				},
			],
		});
		harnesses.push(h);
		await h.session.bindExtensions({ mode: "tui", uiContext: createTestUiContext() });
		h.setResponses([call({ command: "synthetic", background: true }), answer("Started.")]);
		await h.session.prompt("Start synthetic work that will finish during compaction.");
		h.setResponses(aborted ? [] : [answer("Used completion after compaction.")]);
		const result = h.session.compact().catch((error: Error) => error);
		await entered;
		if (aborted) h.session.abortCompaction();
		await result;
		if (aborted) {
			finish();
			await new Promise<void>((resolve) => setImmediate(resolve));
			h.setResponses([answer("New topic.")]);
			await h.session.prompt("A different question.");
			expect(h.session.messages.filter((m) => m.role === "custom")).toHaveLength(0);
		} else {
			await vi.waitFor(() => expect(h.getPendingResponseCount()).toBe(0));
			expect(
				h.session.messages.filter(
					(m) => m.role === "custom" && m.customType === "background-result",
				),
			).toHaveLength(1);
		}
	},
);

test("real reload settles old invocations and installs a fresh job owner", async () => {
	initTheme("dark", false);
	const { createTestExtensionsResult, createTestResourceLoader } = await import(
		pathToFileURL(
			join(process.env.PI_BACKGROUND_CHECKOUT!, "packages/coding-agent/test/utilities.ts"),
		).href
	);
	let cancelled = 0;
	const pending = new Map<string, () => void>();
	const load = () =>
		createTestExtensionsResult(
			[
				background,
				(pi) =>
					pi.on("bash_launch", () => ({
						operations: {
							async exec(command, _cwd, { signal, onData }) {
								await new Promise<void>((resolve, reject) => {
									const abort = () => {
										cancelled++;
										reject(new Error("aborted"));
									};
									signal?.addEventListener("abort", abort, { once: true });
									pending.set(command, () => {
										signal?.removeEventListener("abort", abort);
										resolve();
									});
								});
								onData(Buffer.from(command));
								return { exitCode: 0 };
							},
						},
					})),
			],
			process.env.TMPDIR,
		);
	let loaded = await load();
	const loader = createTestResourceLoader();
	loader.getExtensions = () => loaded;
	loader.reload = async () => {
		loaded = await load();
	};
	const h = await createHarness({ resourceLoader: loader });
	harnesses.push(h);
	await h.session.bindExtensions({ mode: "tui", uiContext: createTestUiContext() });
	h.setResponses([call({ command: "old-job", background: true }), answer("Started.")]);
	await h.session.prompt("Run synthetic work.");
	const waiting = h.session
		.getToolDefinition("background_wait")
		.execute(
			"before-reload", { id: "1" }, undefined, undefined,
			h.session.extensionRunner.createToolContext("before-reload", undefined),
		);
	await h.session.reload();
	expect(getMessageText(await waiting)).toContain("stopped");
	expect(cancelled).toBe(1);
	expect(h.session.messages.filter((m) => m.role === "custom")).toHaveLength(0);
	// Reload resets provider adapters; exercise the newly registered definitions directly.
	const context = h.session.extensionRunner.createToolContext("after-reload", undefined);
	const result = await h.session
		.getToolDefinition("bash")
		.execute(
			"after-reload",
			{ command: "new-job", background: true },
			undefined,
			undefined,
			context,
		);
	expect(result.structuredContent.status).toBe("running");
	const status = await h.session
		.getToolDefinition("background_status")
		.execute("status", { id: result.structuredContent.jobId }, undefined, undefined, context);
	expect(getMessageText(status)).toContain("new-job");
	expect(getMessageText(status)).not.toContain("old-job");
	await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "exit" });
	expect(cancelled).toBe(2);
	expect(h.session.messages.filter((m) => m.role === "custom")).toHaveLength(0);
});
