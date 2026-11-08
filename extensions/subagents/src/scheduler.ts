import { disposeChildLaunchContributions } from "../../shared/child-runtime.ts";
import type { ManagedChildControl } from "../../shared/managed-child.ts";
import {
	completeOutput,
	createBatchArtifacts,
	createChildArtifacts,
	finishBatchArtifacts,
	finishChildArtifacts,
	removeBatchArtifacts,
	writeBatchInput,
	writeChildInput,
	writeChildStatus,
} from "./artifacts.ts";
import { SYSTEM_PROMPT } from "./prompt.ts";
import { runChild } from "./runner.ts";
import type {
	BatchArtifacts,
	BatchView,
	ChildExecutionResult,
	ChildMessage,
	ChildProgress,
	ChildState,
	ChildToolCall,
	ChildUsage,
	ChildView,
	PreparedCommission,
	RunArtifacts,
	RunTargetView,
} from "./types.ts";

interface ChildRecord {
	prepared: PreparedCommission;
	artifacts: RunArtifacts;
	artifactErrors: string[];
	state: ChildState;
	createdAt: number;
	startedAt?: number;
	finishedAt?: number;
	controller?: AbortController;
	cancelling?: boolean;
	finishing?: boolean;
	progress?: ChildProgress;
	usage?: ChildUsage;
	toolCalls?: readonly ChildToolCall[];
	result?: ChildExecutionResult;
	control?: ManagedChildControl;
	latestText?: string;
	collected: boolean;
	notified: boolean;
	messages: ChildMessage[];
}

interface BatchRecord {
	id: string;
	background: boolean;
	createdAt: number;
	finishedAt?: number;
	error?: string;
	artifacts: BatchArtifacts;
	children: ChildRecord[];
}

export class SubagentScheduler {
	private readonly batches = new Map<string, BatchRecord>();
	private readonly children = new Map<string, ChildRecord>();
	private readonly queue: ChildRecord[] = [];
	private readonly listeners = new Set<() => void>();
	private running = 0;
	private accepting = true;
	private readonly maxConcurrency: number;
	private readonly executeChild: typeof runChild;

	constructor(maxConcurrency: number, executeChild: typeof runChild = runChild) {
		this.maxConcurrency = maxConcurrency;
		this.executeChild = executeChild;
	}

	async admit(input: {
		batchId: string;
		background: boolean;
		prepared: readonly PreparedCommission[];
	}): Promise<BatchView> {
		if (!this.accepting) {
			try {
				await disposePrepared(input.prepared);
			} catch (cleanupError) {
				throw new Error(
					`Subagent scheduler is shutting down.\nRejected child cleanup failed: ${errorText(cleanupError)}`,
				);
			}
			throw new Error("Subagent scheduler is shutting down.");
		}
		if (input.prepared.length === 0) throw new Error("A subagent batch cannot be empty.");
		const createdAt = Date.now();
		const persistent = !input.prepared[0].spec.privacy.clientZdr;
		let artifacts: BatchArtifacts | undefined;
		try {
			artifacts = createBatchArtifacts({
				batchId: input.batchId,
				label: input.prepared.length === 1 ? input.prepared[0].spec.label : "batch",
				persistent,
				createdAt,
			});
			const children = input.prepared.map((prepared) => {
				const childArtifacts = createChildArtifacts(artifacts as BatchArtifacts, prepared);
				const record: ChildRecord = {
					prepared,
					artifacts: childArtifacts,
					artifactErrors: [],
					state: "queued",
					createdAt,
					collected: false,
					notified: false,
					messages: [],
				};
				writeChildInput(childArtifacts, prepared);
				writeChildStatus(childArtifacts, childView(record));
				return record;
			});
			writeBatchInput(artifacts, input.prepared);
			const batch: BatchRecord = {
				id: input.batchId,
				background: input.background,
				createdAt,
				artifacts,
				children,
			};
			this.batches.set(batch.id, batch);
			for (const child of children) {
				this.children.set(child.prepared.spec.id, child);
				this.queue.push(child);
			}
			this.changed();
			this.pump();
			return batchView(batch);
		} catch (error) {
			const cleanupErrors: string[] = [];
			try {
				removeBatchArtifacts(artifacts);
			} catch (cleanupError) {
				cleanupErrors.push(`artifact cleanup failed: ${errorText(cleanupError)}`);
			}
			try {
				await disposePrepared(input.prepared);
			} catch (cleanupError) {
				cleanupErrors.push(`prepared child cleanup failed: ${errorText(cleanupError)}`);
			}
			if (cleanupErrors.length > 0) {
				throw new Error(`Subagent admission failed: ${errorText(error)}\n${cleanupErrors.join("\n")}`);
			}
			throw error;
		}
	}

	list(): BatchView[] {
		return [...this.batches.values()].map(batchView);
	}

	batch(id: string): BatchView {
		const batch = this.batches.get(id);
		if (!batch) throw new Error("Subagent group is no longer available in this session.");
		return batchView(batch);
	}

	label(id: string): string {
		return this.record(id).prepared.spec.label;
	}

	runs(options: { ids?: readonly string[]; includeCollected?: boolean } = {}): ChildView[] {
		if (options.ids) return this.targets(options.ids);
		return [...this.children.values()]
			.filter(
				(child) =>
					options.includeCollected ||
					!child.collected ||
					child.messages.some((message) => message.direction === "child" && !message.delivered),
			)
			.map((child) => childView(child, false));
	}

	acknowledge(ids: readonly string[]): void {
		for (const id of ids) {
			const child = this.record(id);
			if (childSettled(child)) child.collected = true;
		}
		this.changed();
	}

	notices(): Array<{ child: ChildView; completion: boolean; messages: ChildMessage[]; error?: string }> {
		return [...this.children.values()].flatMap((record) => {
			const completion =
				this.batches.get(record.prepared.spec.batchId)?.background === true &&
				childSettled(record) &&
				!record.collected &&
				!record.notified;
			const messages = record.messages.filter((message) => message.direction === "child" && !message.delivered);
			return completion || messages.length
				? [
						{
							child: childView(record, false),
							completion,
							messages,
							error: completion ? record.result?.error : undefined,
						},
					]
				: [];
		});
	}

	markNotified(id: string, completion: boolean, messages: readonly ChildMessage[]): void {
		const child = this.record(id);
		if (completion) child.notified = true;
		for (const message of messages) message.delivered = true;
		this.changed();
	}

	async send(id: string, text: string): Promise<string> {
		if (!text.trim() || Buffer.byteLength(text) > 8000)
			throw new Error("Use a nonempty message of at most 8000 UTF-8 bytes.");
		const child = this.record(id);
		if (childSettled(child) || child.cancelling || child.controller?.signal.aborted)
			throw new Error(
				`Child is ${childSettled(child) ? child.state : "cancelling"}; collect its result with subagent_wait.`,
			);
		if (child.finishing)
			throw new Error("Child has finished execution and is cleaning up; collect its result with subagent_wait.");
		const message: ChildMessage = { direction: "parent", text, createdAt: Date.now(), delivered: false };
		child.messages.push(message);
		this.changed();
		if (!child.control) return "Queued until startup.";
		await this.deliver(child, message);
		return "Accepted for processing.";
	}

	private record(id: string): ChildRecord {
		const child = this.children.get(id);
		if (!child) throw new Error(`Unknown child ID '${id}'. Use subagent_list to find retained children.`);
		return child;
	}

	private async deliver(child: ChildRecord, message: ChildMessage): Promise<void> {
		try {
			if (!child.control) throw new Error("Child input is unavailable.");
			await child.control.send(message.text);
			message.delivered = true;
		} catch (error) {
			message.error = errorText(error);
			throw error;
		} finally {
			this.changed();
		}
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	targets(ids: readonly string[]): ChildView[] {
		const targets: ChildView[] = [];
		const seen = new Set<string>();
		for (const id of ids) {
			if (seen.has(id)) continue;
			seen.add(id);
			targets.push(childView(this.record(id)));
		}
		return targets;
	}

	async wait(
		ids: readonly string[],
		signal?: AbortSignal,
		onChange?: (targets: readonly RunTargetView[]) => void,
		timeoutMs?: number,
	): Promise<RunTargetView[]> {
		this.targets(ids);
		const deadline = timeoutMs === undefined ? Infinity : performance.now() + timeoutMs;
		for (;;) {
			const targets = this.targets(ids);
			onChange?.(targets);
			if (targets.every(targetSettled)) return targets;
			const remaining = deadline - performance.now();
			if (remaining <= 0) return targets;
			await this.nextChange(signal, Number.isFinite(remaining) ? remaining : undefined);
		}
	}

	async cancel(
		ids: readonly string[],
		signal?: AbortSignal,
		onChange?: (targets: readonly RunTargetView[]) => void,
	): Promise<RunTargetView[]> {
		const selected = new Set(ids.map((id) => this.record(id)));
		signal?.throwIfAborted();

		const queued: Promise<void>[] = [];
		for (const child of selected) {
			if (child.state === "queued") queued.push(this.cancelQueued(child));
			else if (child.state === "running") child.controller?.abort();
		}
		try {
			await Promise.all([...queued, this.wait(ids, signal, onChange)]);
		} catch (error) {
			if (signal?.aborted) {
				throw new Error("Stopped waiting for cancellation; child cleanup continues in the background.");
			}
			throw error;
		}
		for (const child of selected) if (child.state === "cancelled") child.collected = true;
		this.changed();
		return this.targets(ids);
	}

	async shutdown(): Promise<void> {
		if (!this.accepting) return;
		this.accepting = false;
		const active = [...this.children.values()].filter((child) => child.state === "queued" || child.state === "running");
		if (active.length === 0) return;
		await this.cancel(active.map((child) => child.prepared.spec.id));
	}

	async reset(): Promise<void> {
		await this.shutdown();
		this.batches.clear();
		this.children.clear();
		this.queue.length = 0;
		this.accepting = true;
		this.changed();
	}

	private pump(): void {
		while (this.running < this.maxConcurrency) {
			const child = this.queue.shift();
			if (!child) return;
			if (child.state !== "queued" || child.cancelling) continue;
			this.running += 1;
			void this.execute(child);
		}
	}

	private async execute(child: ChildRecord): Promise<void> {
		const controller = new AbortController();
		child.controller = controller;
		child.state = "running";
		child.startedAt = Date.now();
		try {
			writeChildStatus(child.artifacts, childView(child));
		} catch (error) {
			recordArtifactError(child, "status update", error);
		}
		this.changed();
		let result: ChildExecutionResult;
		const deliveries: Promise<void>[] = [];
		try {
			result = await this.executeChild(
				{
					commission: child.prepared.spec,
					intent: child.prepared.intent,
					contributions: child.prepared.contributions,
					workspaceChildren: child.prepared.workspaceChildren,
					artifacts: child.artifacts,
					systemPrompt: SYSTEM_PROMPT,
					onControl: (control) => {
						child.control = control;
						for (const message of child.messages.filter((entry) => entry.direction === "parent" && !entry.delivered)) {
							deliveries.push(this.deliver(child, message).catch(() => {}));
						}
					},
					onMessage: (text) => {
						child.messages.push({ direction: "child", text, createdAt: Date.now(), delivered: false });
						this.changed();
					},
				},
				controller.signal,
				(update) => {
					child.progress = update.progress;
					child.usage = update.usage;
					child.toolCalls = update.toolCalls;
					child.latestText = update.latestText;
					try {
						writeChildStatus(child.artifacts, childView(child));
					} catch (error) {
						recordArtifactError(child, "progress update", error);
					}
					this.changed();
				},
			);
		} catch (error) {
			result = failedResult(error, child.startedAt);
		}
		child.finishing = true;
		this.changed();
		await Promise.all(deliveries);
		child.control = undefined;
		const undelivered = child.messages.filter((message) => message.direction === "parent" && !message.delivered);
		if (undelivered.length) {
			for (const message of undelivered) message.error ??= "Child ended before accepting queued input.";
			result = {
				...result,
				error: [result.error, ...undelivered.map((message) => `Undelivered input: ${message.error}`)]
					.filter(Boolean)
					.join("\n"),
				outcome: result.outcome === "completed" ? "failed" : result.outcome,
			};
		}

		try {
			await disposeChildLaunchContributions(child.prepared.contributions);
		} catch (error) {
			result = mergeFailure(result, `Child launch cleanup failed: ${errorText(error)}`);
		}
		if (child.artifactErrors.length > 0) {
			result = mergeFailure(result, child.artifactErrors.join("\n"));
		}

		child.controller = undefined;
		child.result = result;
		child.progress = result.progress;
		child.usage = result.usage;
		child.toolCalls = result.toolCalls;
		child.state = result.outcome;
		child.finishedAt = Date.now();
		try {
			finishChildArtifacts(child.artifacts, childView(child), result, child.prepared.contributions);
		} catch (error) {
			result = mergeFailure(result, `Child artifact finalization failed: ${errorText(error)}`);
			child.result = result;
			child.state = "failed";
			child.artifacts.outputPath = undefined;
		}

		this.running -= 1;
		this.finalizeParent(child);
		this.changed();
		this.pump();
	}

	private async cancelQueued(child: ChildRecord): Promise<void> {
		if (child.state !== "queued" || child.cancelling) return;
		child.cancelling = true;
		child.result = cancelledResult(child.createdAt);
		for (const message of child.messages) {
			if (message.direction === "parent" && !message.delivered)
				message.error = "Child was cancelled before accepting queued input.";
		}
		child.progress = child.result.progress;
		child.usage = child.result.usage;
		child.toolCalls = child.result.toolCalls;
		try {
			await disposeChildLaunchContributions(child.prepared.contributions);
		} catch (error) {
			child.result = mergeFailure(child.result, `Child launch cleanup failed: ${errorText(error)}`);
		}
		child.state = child.result.outcome;
		child.finishedAt = Date.now();
		try {
			finishChildArtifacts(child.artifacts, childView(child), child.result, child.prepared.contributions);
		} catch (error) {
			child.result = mergeFailure(child.result, `Child artifact finalization failed: ${errorText(error)}`);
			child.state = "failed";
			child.artifacts.outputPath = undefined;
		}
		this.finalizeParent(child);
		this.changed();
	}

	private finalizeParent(child: ChildRecord): void {
		const batch = this.batches.get(child.prepared.spec.batchId);
		if (!batch || batch.finishedAt !== undefined) return;
		if (!batch.children.every(childSettled)) return;
		batch.finishedAt = Date.now();
		try {
			finishBatchArtifacts(batch.artifacts, batchView(batch), batchOutput(batch));
		} catch (error) {
			batch.error = `Batch artifact finalization failed: ${errorText(error)}`;
			if (child.result) child.result = mergeFailure(child.result, batch.error);
			child.state = "failed";
			child.artifacts.outputPath = undefined;
		}
	}

	private changed(): void {
		for (const listener of [...this.listeners]) listener();
	}

	private nextChange(signal: AbortSignal | undefined, timeoutMs?: number): Promise<void> {
		if (signal?.aborted) {
			return Promise.reject(new Error("Subagent wait was interrupted; runs continue in the background."));
		}
		return new Promise<void>((resolve, reject) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const cleanup = () => {
				this.listeners.delete(finish);
				signal?.removeEventListener("abort", abort);
				clearTimeout(timer);
			};
			const finish = () => {
				cleanup();
				resolve();
			};
			const abort = () => {
				cleanup();
				reject(new Error("Subagent wait was interrupted; runs continue in the background."));
			};
			this.listeners.add(finish);
			signal?.addEventListener("abort", abort, { once: true });
			if (timeoutMs !== undefined) timer = setTimeout(finish, Math.min(timeoutMs, 2_147_483_647));
		});
	}
}

function batchOutput(batch: BatchRecord): string {
	return batch.children
		.map((child) => {
			const output = child.result ? completeOutput(child.result) : "(no output)";
			return `## ${child.prepared.spec.label} (${child.prepared.spec.id})\n\n${output}`;
		})
		.join("\n\n---\n\n");
}

function childView(record: ChildRecord, detailed = true): ChildView {
	const spec = record.prepared.spec;
	return {
		kind: "child",
		id: spec.id,
		batchId: spec.batchId,
		index: spec.index,
		label: spec.label,
		state: record.state,
		activity: childSettled(record)
			? undefined
			: record.finishing || record.cancelling
				? "cleaning up"
				: record.controller?.signal.aborted
					? "cancelling"
					: undefined,
		task: spec.task,
		cwd: spec.cwd,
		provider: spec.provider,
		model: spec.model,
		contextWindow: spec.contextWindow,
		modelSource: spec.modelSource,
		tools: [...spec.tools],
		capabilities: [...spec.capabilities],
		runDir: record.artifacts.runDir,
		outputPath: record.artifacts.outputPath,
		eventsPath: record.artifacts.eventsPath,
		createdAt: record.createdAt,
		startedAt: record.startedAt,
		finishedAt: record.finishedAt,
		result: detailed && record.result ? cloneResult(record.result) : undefined,
		progress: record.progress
			? {
					...record.progress,
					durationMs:
						record.state === "running"
							? Date.now() - (record.startedAt ?? record.createdAt)
							: record.progress.durationMs,
				}
			: undefined,
		usage: record.usage ? { ...record.usage } : undefined,
		toolCalls: (detailed ? record.toolCalls : record.toolCalls?.slice(-1))?.map((tool) => ({ ...tool })),
		totalToolCalls: record.toolCalls?.length ?? 0,
		latestText: record.latestText,
		collected: record.collected,
		messages: detailed ? record.messages.map((message) => ({ ...message })) : undefined,
	};
}

function batchView(record: BatchRecord): BatchView {
	const children = record.children.map((child) => childView(child));
	return {
		kind: "batch",
		id: record.id,
		background: record.background,
		state: batchState(children, record.error),
		createdAt: record.createdAt,
		finishedAt: record.finishedAt,
		runDir: record.artifacts.runDir,
		outputPath: record.error ? undefined : record.artifacts.outputPath,
		error: record.error,
		children,
	};
}

function batchState(children: readonly ChildView[], error?: string): ChildState {
	if (error) return "failed";
	if (children.some((child) => child.state === "running")) return "running";
	if (children.some((child) => child.state === "queued")) return "queued";
	if (children.some((child) => child.state === "failed")) return "failed";
	if (children.some((child) => child.state === "cancelled")) return "cancelled";
	return "completed";
}

function childSettled(child: ChildRecord): boolean {
	return child.state === "completed" || child.state === "failed" || child.state === "cancelled";
}

function targetSettled(target: RunTargetView): boolean {
	if (target.kind === "batch") return target.children.every((child) => childSettledView(child));
	return childSettledView(target);
}

function childSettledView(child: ChildView): boolean {
	return child.state === "completed" || child.state === "failed" || child.state === "cancelled";
}

function failedResult(error: unknown, startedAt: number): ChildExecutionResult {
	const now = Date.now();
	return {
		outcome: "failed",
		output: "",
		error: errorText(error),
		stderr: "",
		toolCalls: [],
		usage: zeroUsage(),
		progress: {
			startedAt,
			durationMs: now - startedAt,
			lastActivityAt: now,
		},
	};
}

function cancelledResult(createdAt: number): ChildExecutionResult {
	const now = Date.now();
	return {
		outcome: "cancelled",
		output: "",
		error: "Child run was cancelled before it started.",
		stderr: "",
		toolCalls: [],
		usage: zeroUsage(),
		progress: {
			startedAt: createdAt,
			durationMs: 0,
			lastActivityAt: now,
		},
	};
}

function mergeFailure(result: ChildExecutionResult, error: string): ChildExecutionResult {
	return {
		...result,
		outcome: "failed",
		error: result.error ? `${result.error}\n${error}` : error,
	};
}

function cloneResult(result: ChildExecutionResult): ChildExecutionResult {
	return {
		...result,
		toolCalls: result.toolCalls.map((tool) => ({ ...tool })),
		usage: { ...result.usage },
		progress: { ...result.progress },
	};
}

function zeroUsage(): ChildUsage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function recordArtifactError(child: ChildRecord, operation: string, error: unknown): void {
	const message = `Child artifact ${operation} failed: ${errorText(error)}`;
	if (!child.artifactErrors.includes(message)) child.artifactErrors.push(message);
}

async function disposePrepared(prepared: readonly PreparedCommission[]): Promise<void> {
	let firstError: unknown;
	for (const child of [...prepared].reverse()) {
		try {
			await disposeChildLaunchContributions(child.contributions);
		} catch (error) {
			firstError ??= error;
		}
	}
	if (firstError) throw firstError;
}
