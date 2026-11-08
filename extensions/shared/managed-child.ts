import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ChildWorkspaceAttachment, WorkspaceChildOperations } from "./active-workspace.ts";
import {
	childLaunchArgs,
	childLaunchEnvironment,
	type ChildLaunchContribution,
	type ChildRunIntent,
} from "./child-runtime.ts";

export type ManagedChildOutcome = "completed" | "failed" | "cancelled";

export interface ManagedChildUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

export interface ManagedChildToolCall {
	id: string;
	name: string;
	preview: string;
	status: "running" | "completed" | "failed" | "cancelled";
	startedAt: number;
	finishedAt?: number;
	error?: string;
}

export interface ManagedChildProgress {
	startedAt: number;
	durationMs: number;
	lastActivityAt: number;
	contextTokens?: number;
}

export interface ManagedChildUpdate {
	progress: ManagedChildProgress;
	usage: ManagedChildUsage;
	toolCalls: readonly ManagedChildToolCall[];
	latestText?: string;
}

export interface ManagedChildControl {
	send(message: string): Promise<void>;
}

export interface ManagedChildResult {
	outcome: ManagedChildOutcome;
	output: string;
	error?: string;
	exitCode?: number;
	exitSignal?: NodeJS.Signals;
	stderr: string;
	model?: string;
	toolCalls: readonly ManagedChildToolCall[];
	usage: ManagedChildUsage;
	progress: ManagedChildProgress;
}

export interface ManagedChildRequest {
	intent: ChildRunIntent;
	contributions: readonly ChildLaunchContribution[];
	workspaceChildren?: WorkspaceChildOperations;
	systemPrompt: string;
	prompt: string;
	thinkingLevel?: string;
	skills: "none" | "global";
	onEvent?(line: string, event: unknown): void;
	onControl?(control: ManagedChildControl): void;
}

export type ManagedChildProgressCallback = (update: ManagedChildUpdate) => void;

export async function runManagedChild(
	request: ManagedChildRequest,
	signal: AbortSignal,
	onProgress?: ManagedChildProgressCallback,
): Promise<ManagedChildResult> {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-managed-child-"));
	const promptPath = join(tempDir, "system-prompt.md");
	try {
		await writeFile(promptPath, request.systemPrompt, {
			encoding: "utf8",
			mode: 0o600,
		});
	} catch (error) {
		try {
			await rm(tempDir, { recursive: true, force: true });
		} catch (cleanupError) {
			throw combinedError("Child prompt creation failed", error, "prompt cleanup failed", cleanupError);
		}
		throw error;
	}

	const usage: ManagedChildUsage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
	};
	const toolCalls: ManagedChildToolCall[] = [];
	const startedAt = Date.now();
	const progress: ManagedChildProgress = {
		startedAt,
		durationMs: 0,
		lastActivityAt: startedAt,
	};
	let output = "";
	let stderr = "";
	let childModel: string | undefined;
	let modelError: string | undefined;
	let exitCode: number | undefined;
	let exitSignal: NodeJS.Signals | undefined;
	let launchError: string | undefined;
	let transportError: string | undefined;
	let sawAssistantMessage = false;
	let lastStopReason: string | undefined;
	let cancelled = false;
	let workspace: ChildWorkspaceAttachment | undefined;
	let fatalError: unknown;
	const runtimeErrors = new Map<string, string>();

	const snapshotProgress = () => {
		progress.durationMs = Date.now() - startedAt;
		if (!onProgress || runtimeErrors.has("progress reporting")) return;
		try {
			onProgress({
				progress: { ...progress },
				usage: { ...usage },
				toolCalls: toolCalls.map((tool) => ({ ...tool })),
				latestText: output,
			});
		} catch (error) {
			runtimeErrors.set("progress reporting", `Child progress reporting failed: ${errorText(error)}`);
		}
	};

	try {
		workspace = await request.workspaceChildren?.prepareChild({
			cwd: request.intent.cwd,
		});
		if (signal.aborted) {
			cancelled = true;
		} else {
			const contributionEnv = childLaunchEnvironment(request.contributions);
			validateWorkspaceEnvironment(workspace?.env, contributionEnv);
			const args = buildChildArgs(request, promptPath, workspace?.args ?? []);
			const invocation = piInvocation(args);
			const exit = await new Promise<{ code?: number; signal?: NodeJS.Signals }>((resolve) => {
				const child = spawn(invocation.command, invocation.args, {
					cwd: workspace?.hostCwd ?? request.intent.cwd,
					stdio: workspace?.writeHandoff ? ["pipe", "pipe", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
					env: {
						...process.env,
						...workspace?.env,
						...contributionEnv,
					},
				});
				let settled = false;
				let buffer = "";
				let killTimer: ReturnType<typeof setTimeout> | undefined;
				let exitTimer: ReturnType<typeof setTimeout> | undefined;
				let exitStatus: { code?: number; signal?: NodeJS.Signals } | undefined;
				let idle = false;
				let admitted = false;
				let closing = false;
				let sending = 0;
				let checking = false;
				const pending = new Map<string, { resolve(data?: unknown): void; reject(error: Error): void }>();

				const maybeFinish = () => {
					if (settled || closing || checking || !admitted || !idle || sending || pending.size) return;
					checking = true;
					const id = randomUUID();
					pending.set(id, {
						resolve(data) {
							checking = false;
							if (
								!isRecord(data) ||
								typeof data.isStreaming !== "boolean" ||
								typeof data.isCompacting !== "boolean" ||
								typeof data.pendingMessageCount !== "number"
							) {
								failTransport("Child returned an invalid settlement state.");
								return;
							}
							if (data.isStreaming || data.isCompacting || data.pendingMessageCount) return;
							if (!idle || sending || pending.size || settled || closing) return;
							closing = true;
							child.stdin?.end();
							killTimer = setTimeout(() => {
								killTimer = undefined;
								terminate();
							}, 3000);
							killTimer.unref?.();
						},
						reject(error) {
							checking = false;
							failTransport(`Child settlement check failed: ${error.message}`);
						},
					});
					child.stdin?.write(`${JSON.stringify({ id, type: "get_state" })}\n`);
				};

				const prompt = (message: string) =>
					new Promise<void>((resolvePrompt, rejectPrompt) => {
						if (closing || settled || signal.aborted || !child.stdin) {
							rejectPrompt(new Error("Child is no longer accepting input."));
							return;
						}
						const id = randomUUID();
						pending.set(id, { resolve: resolvePrompt, reject: rejectPrompt });
						child.stdin.write(`${JSON.stringify({ id, type: "prompt", message, streamingBehavior: "steer" })}\n`);
					});

				const settle = (result: { code?: number; signal?: NodeJS.Signals }) => {
					if (settled) return;
					settled = true;
					if (killTimer) clearTimeout(killTimer);
					if (exitTimer) clearTimeout(exitTimer);
					signal.removeEventListener("abort", abort);
					for (const response of pending.values()) response.reject(new Error("Child exited before accepting input."));
					pending.clear();
					resolve(result);
				};

				const finishExit = () => {
					if (settled || !exitStatus) return;
					if (buffer.trim()) {
						const line = buffer;
						buffer = "";
						processLine(line);
					}
					settle(exitStatus);
					child.stdin?.destroy();
					child.stdout?.destroy();
					child.stderr?.destroy();
				};
				const drainExit = () => {
					if (settled || !exitStatus) return;
					if (exitTimer) {
						if (cancelled || transportError) return;
						clearTimeout(exitTimer);
					}
					// Drain trailing RPC output, but do not wait for quiet inherited pipes to close.
					// Cancellation does not extend the grace for output from surviving descendants.
					exitTimer = setTimeout(finishExit, 100);
				};

				const abort = () => {
					if (settled) return;
					cancelled = true;
					terminate();
				};

				const terminate = () => {
					if (settled) return;
					child.kill("SIGTERM");
					killTimer ??= setTimeout(() => {
						if (!settled) child.kill("SIGKILL");
					}, 3000);
					killTimer.unref?.();
				};
				const failTransport = (message: string) => {
					transportError ??= message;
					terminate();
				};

				if (!child.stdout || !child.stderr) {
					stderr = "Child process output pipes are unavailable.";
					child.kill("SIGTERM");
					settle({ code: 1 });
					return;
				}

				const processLine = (line: string) => {
					if (!line.trim()) return;
					let event: unknown;
					try {
						event = JSON.parse(line) as unknown;
					} catch {
						event = undefined;
					}
					if (!runtimeErrors.has("event handling")) {
						try {
							request.onEvent?.(line, event);
						} catch (error) {
							runtimeErrors.set("event handling", `Child event handling failed: ${errorText(error)}`);
						}
					}
					if (!isRecord(event)) return;
					const now = Date.now();
					progress.lastActivityAt = now;
					const type = stringField(event, "type");
					if (type === "response") {
						const id = stringField(event, "id");
						const response = id ? pending.get(id) : undefined;
						if (response && id) {
							pending.delete(id);
							if (event.success === true) response.resolve(event.data);
							else response.reject(new Error(stringField(event, "error") ?? "Child rejected input."));
						}
						return;
					}
					if (type === "agent_start") idle = false;
					if (type === "compaction_end" && event.result) {
						delete progress.contextTokens;
						snapshotProgress();
						return;
					}
					if (type === "agent_settled") {
						idle = true;
						maybeFinish();
						return;
					}
					if (type === "tool_execution_start") {
						const id = stringField(event, "toolCallId") ?? `unknown-${toolCalls.length + 1}`;
						const toolName = stringField(event, "toolName") ?? "unknown";
						const preview = previewUnknown(event.args);
						toolCalls.push({ id, name: toolName, preview, status: "running", startedAt: now });
						snapshotProgress();
						return;
					}
					if (type === "tool_execution_end") {
						const id = stringField(event, "toolCallId");
						const call = id
							? [...toolCalls].reverse().find((entry) => entry.id === id && entry.status === "running")
							: [...toolCalls].reverse().find((entry) => entry.status === "running");
						if (call) {
							call.finishedAt = now;
							call.status = booleanField(event, "isError") ? "failed" : "completed";
							if (call.status === "failed") call.error = toolError(event.result);
						}
						snapshotProgress();
						return;
					}
					if (type !== "message_end" || !isRecord(event.message)) return;
					if (stringField(event.message, "role") !== "assistant") return;
					sawAssistantMessage = true;
					childModel = stringField(event.message, "model") ?? childModel;
					const stopReason = stringField(event.message, "stopReason");
					lastStopReason = stopReason;
					modelError =
						stopReason === "error" || stopReason === "aborted"
							? (stringField(event.message, "errorMessage") ?? `Child model request ${stopReason}.`)
							: undefined;
					const messageUsage = usageFromMessage(event.message);
					if (messageUsage) {
						addUsage(usage, messageUsage);
						const tokens =
							(isRecord(event.message.usage) && numberField(event.message.usage, "totalTokens")) ||
							messageUsage.input + messageUsage.output + messageUsage.cacheRead + messageUsage.cacheWrite;
						if (stopReason !== "error" && stopReason !== "aborted" && tokens > 0) progress.contextTokens = tokens;
					}
					const text = textFromContent(event.message.content);
					if (text.trim()) output = text;
					snapshotProgress();
				};

				child.stdout.on("data", (chunk) => {
					buffer += chunk.toString();
					const lines = buffer.split("\n");
					buffer = lines.pop() ?? "";
					for (const line of lines) processLine(line);
					drainExit();
				});
				child.stdout.on("error", (error) => {
					failTransport(`Child stdout failed: ${errorText(error)}`);
				});
				child.stderr.on("data", (chunk) => {
					stderr += chunk.toString();
					drainExit();
				});
				child.stderr.on("error", (error) => {
					failTransport(`Child stderr failed: ${errorText(error)}`);
				});
				child.stdin?.on("error", (error) => failTransport(`Child input failed: ${errorText(error)}`));
				child.on("exit", (code, exitSignal) => {
					closing = true;
					exitStatus = { code: code ?? undefined, signal: exitSignal ?? undefined };
					drainExit();
				});
				child.on("close", (code, closeSignal) => {
					if (buffer.trim()) processLine(buffer);
					settle({
						code: code ?? undefined,
						signal: closeSignal ?? undefined,
					});
				});
				child.on("error", (error) => {
					stderr += error instanceof Error ? error.message : String(error);
					settle({ code: 1 });
				});
				signal.addEventListener("abort", abort, { once: true });
				if (signal.aborted) {
					abort();
				} else {
					const initial = prompt(request.prompt);
					void initial.then(
						() => {
							admitted = true;
							maybeFinish();
						},
						(error) => {
							if (settled) return;
							launchError = `Child task admission failed: ${errorText(error)}`;
							terminate();
						},
					);
					try {
						request.onControl?.({
							async send(message) {
								if (closing || settled || signal.aborted) throw new Error("Child is no longer accepting input.");
								sending += 1;
								try {
									await initial;
									await prompt(message);
								} finally {
									sending -= 1;
									maybeFinish();
								}
							},
						});
					} catch (error) {
						failTransport(`Child control setup failed: ${errorText(error)}`);
					}
				}
				if (!signal.aborted && workspace?.writeHandoff) {
					const stream = child.stdio[3];
					if (!stream || typeof (stream as NodeJS.WritableStream).end !== "function") {
						launchError = "Child workspace handoff fd 3 is unavailable.";
						stderr += launchError;
						terminate();
					} else {
						(stream as NodeJS.WritableStream).on("error", (error) => {
							failTransport(`Child workspace handoff stream failed: ${errorText(error)}`);
						});
						try {
							workspace.writeHandoff(stream as NodeJS.WritableStream);
						} catch (error) {
							launchError = `Child workspace handoff failed: ${errorText(error)}`;
							stderr += launchError;
							terminate();
						}
					}
				}
			});
			exitCode = exit.code;
			exitSignal = exit.signal;
		}
	} catch (error) {
		fatalError = error;
	} finally {
		try {
			await workspace?.dispose();
		} catch (error) {
			runtimeErrors.set("workspace cleanup", `Child workspace cleanup failed: ${errorText(error)}`);
		}
		try {
			await rm(tempDir, { recursive: true, force: true });
		} catch (error) {
			runtimeErrors.set("prompt cleanup", `Child prompt cleanup failed: ${errorText(error)}`);
		}
	}
	if (fatalError !== undefined) {
		const cleanup = [...runtimeErrors.values()];
		throw new Error([`Child execution failed: ${errorText(fatalError)}`, ...cleanup].join("\n"), {
			cause: fatalError,
		});
	}

	progress.durationMs = Date.now() - startedAt;
	if (cancelled) {
		settleOpenToolCalls(toolCalls, "cancelled", "Child run was cancelled.");
		return withRuntimeErrors(
			{
				outcome: "cancelled",
				output,
				error: "Child run was cancelled.",
				exitCode,
				exitSignal,
				stderr,
				model: childModel,
				toolCalls,
				usage,
				progress,
			},
			runtimeErrors,
		);
	}
	const protocolError = !sawAssistantMessage
		? "Child exited without a final assistant message."
		: lastStopReason === "pending" || lastStopReason === "toolUse" || lastStopReason === "deferred"
			? `Child exited before producing a final response (stop reason: ${lastStopReason}).`
			: undefined;
	const toolProtocolError = toolCalls.some((tool) => tool.status === "running")
		? "Child exited with unfinished tool calls."
		: undefined;
	const processError = exitSignal
		? `Child process terminated by ${exitSignal}.`
		: exitCode === 0
			? undefined
			: stderr.trim() || `Child exited with code ${exitCode ?? 1}.`;
	const error =
		[
			...new Set(
				[launchError, transportError, modelError, processError, protocolError, toolProtocolError].filter(Boolean),
			),
		].join("\n") || undefined;
	if (error) settleOpenToolCalls(toolCalls, "failed", error);
	return withRuntimeErrors(
		{
			outcome: error ? "failed" : "completed",
			output,
			error,
			exitCode,
			exitSignal,
			stderr,
			model: childModel,
			toolCalls,
			usage,
			progress,
		},
		runtimeErrors,
	);
}

function buildChildArgs(request: ManagedChildRequest, promptPath: string, workspaceArgs: readonly string[]): string[] {
	const args = ["--mode", "rpc"];
	if (request.intent.privacy.clientZdr) args.push("--zdr-client");
	else args.push("--no-session");
	if (request.intent.privacy.remoteZdr) args.push("--zdr");
	args.push("--no-extensions", ...workspaceArgs);
	args.push(...childLaunchArgs(request.contributions));
	if (request.skills === "none") args.push("--no-skills");
	args.push("--model", request.intent.model);
	if (request.thinkingLevel) args.push("--thinking", request.thinkingLevel);
	if (request.intent.tools.length === 0) args.push("--no-tools");
	else args.push("--tools", request.intent.tools.join(","));
	args.push("--system-prompt", promptPath);
	return args;
}

function piInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	if (currentScript && !currentScript.startsWith("/$bunfs/root/") && existsSync(currentScript)) {
		return { command: process.execPath, args: [...process.execArgv, currentScript, ...args] };
	}
	const executable = basename(process.execPath).toLowerCase();
	if (!/^(?:node|bun)(?:\.exe)?$/u.test(executable)) {
		return { command: process.execPath, args };
	}
	return { command: "pi", args };
}

function validateWorkspaceEnvironment(
	workspace: Readonly<Record<string, string>> | undefined,
	contributions: Readonly<Record<string, string>>,
): void {
	for (const key of Object.keys(workspace ?? {})) {
		if (key in contributions) {
			throw new Error(`Child workspace and launch contributor both set environment variable '${key}'.`);
		}
	}
}

function usageFromMessage(message: Record<string, unknown>): ManagedChildUsage | undefined {
	if (!isRecord(message.usage)) return undefined;
	const cost = isRecord(message.usage.cost) ? (numberField(message.usage.cost, "total") ?? 0) : 0;
	return {
		input: numberField(message.usage, "input") ?? 0,
		output: numberField(message.usage, "output") ?? 0,
		cacheRead: numberField(message.usage, "cacheRead") ?? 0,
		cacheWrite: numberField(message.usage, "cacheWrite") ?? 0,
		cost,
	};
}

function addUsage(target: ManagedChildUsage, source: ManagedChildUsage): void {
	target.input += source.input;
	target.output += source.output;
	target.cacheRead += source.cacheRead;
	target.cacheWrite += source.cacheWrite;
	target.cost += source.cost;
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((entry) =>
			isRecord(entry) && entry.type === "text" && typeof entry.text === "string" ? [entry.text] : [],
		)
		.join("\n");
}

function previewUnknown(value: unknown): string {
	if (value === undefined) return "";
	let encoded: string;
	try {
		encoded = typeof value === "string" ? value : JSON.stringify(value);
	} catch {
		encoded = String(value);
	}
	return encoded.length <= 120 ? encoded : `${encoded.slice(0, 117)}...`;
}

function toolError(value: unknown): string {
	if (isRecord(value)) {
		const text = textFromContent(value.content).trim();
		if (text) return text.length <= 240 ? text : `${text.slice(0, 237)}...`;
	}
	return "Tool call failed.";
}

function settleOpenToolCalls(toolCalls: ManagedChildToolCall[], status: "failed" | "cancelled", error: string): void {
	const now = Date.now();
	for (const tool of toolCalls) {
		if (tool.status !== "running") continue;
		tool.status = status;
		tool.finishedAt = now;
		tool.error = error;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
	return typeof record[key] === "string" ? record[key] : undefined;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
	const value = record[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanField(record: Record<string, unknown>, key: string): boolean {
	return record[key] === true;
}

function withRuntimeErrors(result: ManagedChildResult, errors: ReadonlyMap<string, string>): ManagedChildResult {
	if (errors.size === 0) return result;
	const extra = [...errors.values()].join("\n");
	return {
		...result,
		outcome: "failed",
		error: result.error ? `${result.error}\n${extra}` : extra,
	};
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function combinedError(primaryLabel: string, primary: unknown, secondaryLabel: string, secondary: unknown): Error {
	return new Error(`${primaryLabel}: ${errorText(primary)}\n${secondaryLabel}: ${errorText(secondary)}`);
}
