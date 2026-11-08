import {
	ShellExecutionError,
	type createBashToolDefinition,
	type ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { MonitorEvents } from "./monitor.ts";

export type ShellTool = ReturnType<typeof createBashToolDefinition>;
type Result = Awaited<ReturnType<ShellTool["execute"]>>;
type Update = NonNullable<Parameters<ShellTool["execute"]>[3]>;

const MAX_RUNNING = 8;
const MAX_RETAINED = 64;
export const WAIT_SECONDS = 60;
type WaitOutcome = "completed" | "released" | "timeout";

export interface Job {
	id: string;
	label: string;
	background: boolean;
	wake: boolean;
	announced: boolean;
	state: "starting" | "running" | "stopping" | "finished" | "failed" | "stopped";
	controller: AbortController;
	monitor?: MonitorEvents;
	exitCode?: number;
	preview: string;
	diagnostic?: string;
	fullOutputPath?: string;
	result?: Result;
	error?: Error;
	done: Promise<void>;
	promoted: Promise<void>;
	promote(): boolean;
}

export function textOf(result: Pick<Result, "content">): string {
	return result.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function preview(text: string): string {
	return Buffer.from(text)
		.subarray(-4000)
		.toString("utf8")
		.replace(/^\uFFFD+/u, "");
}

function excerpt(text: string): { text: string; truncated: boolean } {
	const value = text.replace(/\r?\n$/u, "");
	const tail = Buffer.from(value.split("\n").slice(-6).join("\n"))
		.subarray(-1024)
		.toString("utf8")
		.replace(/^\uFFFD+/u, "");
	return { text: tail, truncated: tail !== value };
}

/** Owns native tool invocations, never shell spawning or output capture. */
export class Jobs {
	readonly entries = new Map<string, Job>();
	private next = 1;
	private closed = false;
	private reservations = 0;
	private readonly waits = new Set<{
		job: Job;
		action: "wait" | "stop";
		finish(outcome: WaitOutcome): void;
	}>();
	private readonly changed: () => void;

	constructor(changed: () => void) {
		this.changed = changed;
	}

	private admit(): void {
		const retained = [...this.entries.values()].filter((job) => job.background);
		if (this.reservations + retained.filter((job) => !terminal(job)).length >= MAX_RUNNING)
			throw new Error(`At most ${MAX_RUNNING} background commands can run at once. Stop or finish one first.`);
		while (retained.length + this.reservations >= MAX_RETAINED) {
			const index = retained.findIndex((job) => terminal(job) && job.announced);
			if (index < 0)
				throw new Error("Background results are awaiting inspection. Inspect completed jobs before starting more.");
			this.entries.delete(retained[index].id);
			retained.splice(index, 1);
		}
	}

	async start(
		shell: ShellTool,
		toolCallId: string,
		args: Parameters<ShellTool["execute"]>[1],
		label: string,
		context: ExtensionToolContext,
		signal?: AbortSignal,
		onUpdate?: Update,
		background = false,
		monitor = false,
	): Promise<Job> {
		if (this.closed || signal?.aborted) throw new Error("Background launch cancelled");
		if (background) {
			this.admit();
			this.reservations++;
		}
		let started!: () => void;
		const ready = new Promise<void>((resolve) => {
			started = resolve;
		});
		let promoted!: () => void;
		const detach = () => signal?.removeEventListener("abort", abort);
		const abort = () => job.controller.abort(signal?.reason);
		const job: Job = {
			id: String(this.next++),
			label,
			background: false,
			wake: true,
			announced: true,
			state: "starting",
			controller: new AbortController(),
			monitor: monitor ? new MonitorEvents() : undefined,
			preview: "",
			done: Promise.resolve(),
			promoted: new Promise<void>((resolve) => {
				promoted = resolve;
			}),
			promote: () => {
				if (job.background || job.result || job.state !== "running" || job.controller.signal.aborted || signal?.aborted)
					return false;
				if (!background) this.admit();
				job.background = true;
				job.announced = false;
				detach();
				promoted();
				this.changed();
				return true;
			},
		};
		this.entries.set(job.id, job);
		signal?.addEventListener("abort", abort, { once: true });
		job.done = (async () => {
			let outcome: Job["state"] = "failed";
			try {
				job.result = await shell.execute(
					toolCallId,
					args,
					job.controller.signal,
					(partial) => {
						if (job.monitor && typeof partial.details?.outputDelta !== "string")
							throw new Error("Monitor requires a Bash tool with incremental output support.");
						// The native tool's initial update follows its final launch guard.
						if (job.state === "starting") {
							job.state = "running";
							started();
						}
						job.preview = preview(textOf(partial));
						job.fullOutputPath = partial.details?.fullOutputPath;
						if (job.monitor && job.wake) {
							job.monitor.append(partial.details!.outputDelta!);
							if (job.monitor.failure) {
								job.state = "stopping";
								job.controller.abort();
							}
							this.changed();
						}
						if (!job.background) onUpdate?.(partial);
					},
					context,
				);
				job.fullOutputPath = job.result.details?.fullOutputPath;
				const value = job.result.structuredContent;
				const exitCode = value && typeof value === "object" && "exit_code" in value ? value.exit_code : undefined;
				if (typeof exitCode === "number") job.exitCode = exitCode;
				outcome = job.result.isError ? "failed" : "finished";
			} catch (error) {
				job.error = error instanceof Error ? error : new Error(String(error));
				job.diagnostic = preview(error instanceof ShellExecutionError ? error.diagnostic : job.error.message);
				if (error instanceof ShellExecutionError) job.fullOutputPath = error.fullOutputPath;
				outcome = job.controller.signal.aborted ? "stopped" : "failed";
			} finally {
				if (job.wake) job.monitor?.finish();
				if (job.monitor?.failure) outcome = "failed";
				job.diagnostic = job.monitor?.failure ?? job.diagnostic;
				const text = job.result
					? textOf({ content: job.result.details?.exitCode ? job.result.content.slice(0, 1) : job.result.content })
					: job.error instanceof ShellExecutionError
						? job.error.output
						: job.preview;
				job.preview = preview(text);
				if (job.background && !job.fullOutputPath && excerpt(text).truncated) {
					try {
						job.fullOutputPath = await context.writeOutputFile(
							"background",
							".log",
							job.diagnostic ? `${text}\n${job.diagnostic}` : text,
						);
					} catch {
						job.preview += "\n[Full output could not be retained; showing the tail.]";
					}
				}
				job.state = outcome;
				job.promote = () => false;
				if (job.background) {
					job.result = undefined;
					job.error = undefined;
				}
				detach();
				started();
				for (const pending of this.waits) if (pending.job === job) pending.finish("completed");
				this.changed();
			}
		})();
		try {
			await ready;
			if (!job.background && job.monitor?.failure) {
				await job.done;
				this.entries.delete(job.id);
				throw new Error(job.monitor.failure);
			}
			if (job.error) {
				this.entries.delete(job.id);
				throw job.error;
			}
			if (background) job.promote();
			return job;
		} finally {
			if (background) this.reservations--;
		}
	}

	get(id: string): Job {
		const job = this.entries.get(id);
		if (!job?.background) throw new Error(`Unknown or expired background job ${id}`);
		return job;
	}

	promote(): Job | undefined {
		const candidates = [
			...[...this.entries.values()]
				.filter((job) => !job.background && job.state === "running")
				.map((job) => ({ job, release: () => job.promote() })),
			...[...this.waits]
				.filter(({ job, action }) => action === "wait" && !terminal(job))
				.map((pending) => ({
					job: pending.job,
					release: () => {
						pending.finish("released");
						return true;
					},
				})),
		];
		if (candidates.length > 1)
			throw new Error("More than one foreground command or wait is active; none was released.");
		const candidate = candidates[0];
		if (!candidate || candidate.release() === false) return undefined;
		return candidate.job;
	}

	mute(): number {
		let count = 0;
		for (const job of this.entries.values()) {
			if (job.background && job.wake && (!terminal(job) || !job.announced)) count++;
			job.wake = false;
			job.monitor?.discard();
		}
		this.changed();
		return count;
	}

	collect(job: Job): void {
		job.monitor?.collect();
		if (terminal(job)) job.announced = true;
		this.changed();
	}

	stop(job: Job): void {
		job.wake = false;
		job.monitor?.discard();
		if (terminal(job)) return;
		job.state = "stopping";
		job.controller.abort();
		this.changed();
	}

	wait(job: Job, signal?: AbortSignal, action: "wait" | "stop" = "wait"): Promise<WaitOutcome> {
		return new Promise<WaitOutcome>((resolve, reject) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const pending = {
				job,
				action,
				finish: (outcome: WaitOutcome) => finish(outcome),
			};
			const clean = () => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", abort);
				this.waits.delete(pending);
			};
			const finish = (result: WaitOutcome) => {
				clean();
				const outcome = terminal(job) ? "completed" : result;
				if (outcome === "completed") this.collect(job);
				resolve(outcome);
			};
			const abort = () => {
				clean();
				reject(new Error(
					typeof signal?.reason === "string" ? signal.reason : `Stopped waiting for background job ${job.id}.`,
				));
			};
			if (signal?.aborted) return abort();
			if (terminal(job)) return finish("completed");
			signal?.addEventListener("abort", abort, { once: true });
			this.waits.add(pending);
			if (action === "wait") timer = setTimeout(() => finish("timeout"), WAIT_SECONDS * 1000);
		});
	}

	async close(): Promise<void> {
		this.closed = true;
		for (const job of this.entries.values()) this.stop(job);
		await Promise.all([...this.entries.values()].map((job) => job.done));
		this.entries.clear();
	}
}

export function terminal(job: Job): boolean {
	return job.state !== "starting" && job.state !== "running" && job.state !== "stopping";
}

export function describe(job: Job, output = true): string {
	const heading = `Job ${job.id} (${job.label}): ${job.state}${job.exitCode !== undefined ? `, exit ${job.exitCode}` : ""}${job.wake ? "" : "; automatic continuation off"}.`;
	if (!output) return heading;
	const tail = excerpt(job.preview);
	return [
		heading,
		job.fullOutputPath ? `Full output: ${job.fullOutputPath}` : undefined,
		tail.truncated ? "[Earlier output omitted]" : undefined,
		tail.text || "(No output)",
		job.diagnostic,
	]
		.filter(Boolean)
		.join("\n");
}
