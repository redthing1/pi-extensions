import { Type } from "typebox";
import {
	defineTool,
	startToolTimer,
	toolTimerText,
	renderShellCommand,
	type ExtensionAPI,
	type ExtensionContext,
	type ToolRenderers,
	type ToolDefinition,
	type BashToolDetails,
} from "@earendil-works/pi-coding-agent";
import { Box, Container, Spacer, Text } from "@earendil-works/pi-tui";
import { publishToolEffectAnalyzer } from "../shared/tool-effects.ts";
import { observeActiveWorkspace } from "../shared/active-workspace.ts";
import { describe, Jobs, terminal, textOf, WAIT_SECONDS, type Job, type ShellTool } from "./jobs.ts";
import { MAX_MONITOR_TIMEOUT, MONITOR_TIMEOUT } from "./monitor.ts";

import {
	isBackgroundDetails,
	jobView,
	panel,
	renderHeader,
	renderCall,
	renderJobs,
	renderText,
	type BackgroundDetails,
} from "./render.ts";

type BackgroundShell = ToolDefinition<
	ShellTool["parameters"],
	BashToolDetails | BackgroundDetails | undefined,
	Parameters<NonNullable<ShellTool["renderResult"]>>[3]["state"]
>;

export default function backgroundWork(pi: ExtensionAPI): void {
	registerBackgroundWork(pi);
}

export function registerBackgroundWork(pi: ExtensionAPI) {
	let ctx: ExtensionContext | undefined;
	let registered = false;
	let busy = false;
	let prompting = false;
	let stopped = false;
	let userInput = false;
	let closed = false;
	let scheduled = false;
	let deliveryTimer: ReturnType<typeof setTimeout> | undefined;
	let runSignal: AbortSignal | undefined;
	let jobs = new Jobs(schedule);
	const workspace = observeActiveWorkspace(pi, (access) => {
		if (access.kind === "unavailable") interrupt();
		if (access.kind === "ready") {
			access.workspace.registerCompatibleTool("monitor");
			access.workspace.registerCompatibleTool("background_status");
			access.workspace.registerCompatibleTool("background_wait");
			access.workspace.registerCompatibleTool("background_stop");
		}
	});
	for (const toolName of ["monitor", "background_status", "background_wait", "background_stop"]) {
		publishToolEffectAnalyzer(pi, {
			toolName,
			analyze: () => ({
				toolName,
				effects: [],
				risk: "safe",
				pathInputs: [],
				known: true,
				reason:
					toolName === "monitor"
						? "Delegates to Bash through its normal tool and launch policies"
						: "Managing owned work does not add execution capability",
			}),
		});
	}
	const topLevelCalls = new Set<string>();
	const monitorCalls = new Set<string>();
	const monitorShellCalls = new Set<string>();
	pi.on("tool_execution_start", (event) => {
		if (event.toolName === "bash" && !event.parentToolCallId) topLevelCalls.add(event.toolCallId);
		if (event.toolName === "bash" && event.parentToolCallId && monitorCalls.has(event.parentToolCallId))
			monitorShellCalls.add(event.toolCallId);
	});
	pi.on("tool_execution_end", (event) => {
		topLevelCalls.delete(event.toolCallId);
		monitorShellCalls.delete(event.toolCallId);
	});

	const reply = (text: string, items: Job[], overview = false, omitted = 0) => ({
		content: [{ type: "text" as const, text }],
		details: {
			backgroundWork: { jobs: items.map(jobView), overview, omitted },
		},
	});
	const readyJobs = () =>
		[...jobs.entries.values()]
			.filter(
				(job) =>
					job.background &&
					job.wake &&
					((terminal(job) && !job.announced) ||
						(job.state === "running" && job.monitor && job.monitor.dueAt <= Date.now())),
			)
			.slice(0, 4);
	function messageFor(ready: ReturnType<typeof readyJobs>) {
		const views = ready.map((job) => ({
			...jobView(job),
			...(job.monitor
				? {
						preview: job.monitor.pending.join("\n"),
						event: !terminal(job),
					}
				: {}),
		}));
		return {
			customType: "background-result",
			content: ready
				.map((job, index) =>
					job.monitor
						? [
								describe(job, false),
								job.fullOutputPath && `Full output: ${job.fullOutputPath}`,
								views[index].preview,
								job.diagnostic,
							]
								.filter(Boolean)
								.join("\n")
						: describe(job),
				)
				.join("\n\n"),
			display: true,
			details: { backgroundWork: { jobs: views } },
		};
	}

	function schedule() {
		if (closed || scheduled) return;
		scheduled = true;
		queueMicrotask(() => {
			scheduled = false;
			refresh();
		});
	}

	function refresh() {
		clearTimeout(deliveryTimer);
		if (closed || !ctx) return;
		const active = [...jobs.entries.values()].filter((job) => job.background && !terminal(job));
		const muted = active.filter((job) => !job.wake).length;
		const pending = [...jobs.entries.values()].reduce(
			(count, job) => count + (job.background && job.wake ? (job.monitor?.pending.length ?? 0) : 0),
			0,
		);
		ctx.ui.setStatus(
			"background",
			[
				active.length ? `${active.length} background job${active.length === 1 ? "" : "s"}` : "",
				pending ? `${pending} update${pending === 1 ? "" : "s"} pending` : "",
				muted
					? ctx.ui.theme.fg("muted", muted === active.length ? "automatic updates off" : `${muted} with updates off`)
					: "",
			]
				.filter(Boolean)
				.join(" · ") || undefined,
		);
		if (busy || prompting || stopped || runSignal?.aborted || !ctx.isIdle() || ctx.hasPendingMessages()) return;
		const ready = readyJobs();
		if (!ready.length) {
			const due = Math.min(
				...active.filter((job) => job.wake && job.state === "running").map((job) => job.monitor?.dueAt ?? Infinity),
			);
			if (Number.isFinite(due)) deliveryTimer = setTimeout(schedule, Math.max(0, due - Date.now()));
			return;
		}
		pi.sendMessage(messageFor(ready), {
			triggerTurn: true,
			deliverAs: "followUp",
		});
		for (const job of ready) jobs.collect(job);
	}

	pi.on("turn_end", (event) => {
		if (
			closed ||
			prompting ||
			stopped ||
			runSignal?.aborted ||
			event.outcome !== "completed" ||
			event.context.pendingMessages.length
		)
			return;
		const ready = readyJobs();
		if (!ready.length) return;
		const message = messageFor(ready);
		for (const job of ready) jobs.collect(job);
		return {
			entries: [{ type: "custom_message", ...message }],
			continue: true,
		};
	});

	function interrupt() {
		clearTimeout(deliveryTimer);
		stopped = true;
		return jobs.mute();
	}
	function mute(context: ExtensionContext, explicit = false) {
		const count = interrupt();
		if (count) context.ui.notify("Automatic updates off · background work continues", "info");
		else if (explicit) context.ui.notify("No background work with automatic updates enabled.", "info");
	}
	pi.on("ui_interrupt", (_event, context) => mute(context));

	function receipt(job: Job, reason: "started" | "promoted" | "released" | "timeout" = "started") {
		const introduction =
			reason === "promoted" || reason === "released"
				? `The user chose to continue without waiting for job ${job.id}. `
				: reason === "timeout"
					? `Wait ended after ${WAIT_SECONDS} seconds. `
					: "";
		const continuation = job.wake
			? job.monitor
				? "You can finish your reply. Output events and completion start a new turn when idle, or arrive between steps while busy."
				: "Completion will be reported automatically. You can finish your reply."
			: "Automatic completion notification is off.";
		return {
			content: [
				{
					type: "text" as const,
					text: `${introduction}Job ${job.id} (${job.label}) is running in the background. ${continuation}`,
				},
			],
			details: {
				backgroundWork: {
					jobs: [jobView(job)],
					receipt: reason === "promoted" ? ("started" as const) : reason,
				},
			},
			structuredContent: { status: "running", jobId: job.id },
		};
	}

	function withBackground(shell: ShellTool) {
		const enabled = ctx?.mode === "tui";
		return {
			...shell,
			renderResult: ((result, options, theme, context) => {
				if (isBackgroundDetails(result.details)) {
					// Settle the native renderer's streaming state before replacing its final view.
					shell.renderResult?.({ content: [], details: undefined }, options, theme, context);
					const body = new Container();
					body.addChild(renderJobs(result.details, options.expanded, theme));
					body.addChild(new Spacer(1));
					return panel(body, context.outputPad, theme);
				}
				return (
					shell.renderResult?.({ ...result, details: result.details }, options, theme, context) ??
					renderText(textOf(result), options.expanded, theme, context.isError)
				);
			}) satisfies NonNullable<BackgroundShell["renderResult"]>,
			parameters: enabled
				? Type.Object({
						...shell.parameters.properties,
						background: Type.Optional(
							Type.Boolean({
								description: "Run in the background and report completion automatically",
							}),
						),
					})
				: shell.parameters,
			outputSchema:
				enabled && shell.outputSchema
					? Type.Union([
							shell.outputSchema,
							Type.Object({
								status: Type.Literal("running"),
								jobId: Type.String(),
							}),
						])
					: shell.outputSchema,
			async execute(
				id: string,
				args: { command: string; timeout?: number; background?: boolean },
				signal: Parameters<ShellTool["execute"]>[2],
				update: Parameters<ShellTool["execute"]>[3],
				context: Parameters<ShellTool["execute"]>[4],
			) {
				if (args.background && context.mode !== "tui")
					throw new Error("Managed background commands require the terminal UI.");
				const access = workspace.current();
				if (access.kind === "unavailable") throw new Error("Active workspace is unavailable; no command was launched.");
				if (access.kind === "ready") access.workspace.assertActive();
				const { background, ...command } = args;
				// Programmatic callers keep their awaited-result contract unless they explicitly request background work.
				if (context.mode !== "tui" || (!background && !topLevelCalls.has(id)))
					return shell.execute(id, command, signal, update, context);
				const owner = jobs;
				const job = await owner.start(
					shell,
					id,
					command,
					args.command.slice(0, 80),
					context,
					signal,
					update,
					background,
					monitorShellCalls.has(id),
				);
				job.wake = !stopped;
				if (!job.wake) job.monitor?.discard();
				try {
					await Promise.race([job.done, job.promoted]);
					if (job.background) return receipt(job, background ? "started" : "promoted");
					if (job.error) throw job.error;
					return job.result!;
				} finally {
					if (!job.background) owner.entries.delete(job.id);
				}
			},
		};
	}

	const promote = () => jobs.promote();
	const promoteCommand = (context: ExtensionContext) => {
		if (!promote()) context.ui.notify("No foreground shell command or background wait is active.", "info");
	};
	pi.registerShortcut("ctrl+b", {
		id: "background.promote",
		description: "Background shell command or release wait",
		handler: promoteCommand,
	});
	pi.registerCommand("background", {
		description: "Background the foreground command or release a wait; mute disables automatic updates",
		getArgumentCompletions: (prefix) =>
			"mute".startsWith(prefix) ? [{ value: "mute", label: "mute — disable automatic updates; keep work running" }] : null,
		handler: async (args, context) => {
			if (args.trim() === "mute") mute(context, true);
			else if (!args.trim()) promoteCommand(context);
			else context.ui.notify("Usage: /background [mute]", "info");
		},
	});

	pi.registerMessageRenderer<BackgroundDetails>("background-result", (message, options, theme) => {
		if (!message.details) return undefined;
		const box = new Box(options.outputPad, 0);
		box.addChild(renderJobs(message.details, options.expanded, theme));
		return box;
	});
	const renderResult = ((result, options, theme, context, footer?: string) => {
		const body = new Container();
		const selectedId = (context.args as { id?: string } | undefined)?.id;
		body.addChild(
			result.details?.backgroundWork
				? renderJobs(result.details, options.expanded, theme, selectedId)
				: renderText(textOf(result), options.expanded, theme, context.isError),
		);
		if (footer) body.addChild(new Text(theme.fg("muted", footer.toLowerCase()), 2, 0));
		body.addChild(new Spacer(1));
		return panel(body, context.outputPad, theme);
	}) satisfies NonNullable<ToolRenderers["renderResult"]>;
	function registerTools() {
		pi.registerToolDecorator("bash", (native) => defineTool(withBackground(native as ShellTool)));

		if (ctx?.mode !== "tui") return;
		pi.registerTool(
			defineTool({
				name: "monitor",
				label: "Monitor",
				renderShell: "self",
				description:
					`Run a watcher in the background. Each nonblank output line is an event delivered automatically; print only meaningful changes, not raw logs. Use background_status or background_stop with the returned job id. Stops after ${MONITOR_TIMEOUT} seconds by default (maximum ${MAX_MONITOR_TIMEOUT}).`,
				parameters: Type.Object({
					command: Type.String({
						description: "Shell command that prints one concise event per line",
					}),
					timeout: Type.Optional(
						Type.Number({
							exclusiveMinimum: 0,
							maximum: MAX_MONITOR_TIMEOUT,
							description: "Watcher lifetime in seconds",
						}),
					),
				}),
				renderCall: (args, theme, context) =>
					renderHeader(renderShellCommand(args.command ?? "…", "Monitor", theme), context.outputPad, theme),
				renderResult,
				async execute(id, args, signal, _update, context) {
					monitorCalls.add(id);
					try {
						const outcome = await context.executeTool(
							"bash",
							{
								command: args.command,
								timeout: args.timeout ?? MONITOR_TIMEOUT,
								background: true,
							},
							{ signal },
						);
						return { ...outcome.result, isError: outcome.isError };
					} finally {
						monitorCalls.delete(id);
					}
				},
			}),
		);
		pi.registerTool(
			defineTool({
				name: "background_status",
				label: "Background status",
				renderShell: "self",
				renderCall: (args, theme, context) =>
					renderHeader(renderCall("status", args.id, theme), context.outputPad, theme),
				renderResult,
				description:
					"Inspect a background job's current state and output without waiting. Omit id for an overview of running jobs and results awaiting delivery.",
				parameters: Type.Object({ id: Type.Optional(Type.String()) }),
				async execute(_id, args) {
					if (args.id) {
						const job = jobs.get(args.id);
						const text = describe(job);
						if (terminal(job)) jobs.collect(job);
						return reply(text, [job]);
					}
					const visible = [...jobs.entries.values()].filter(
						(job) => job.background && (!terminal(job) || !job.announced),
					);
					return reply(
						visible.length
							? visible
									.slice(0, 20)
									.map((job) => describe(job, false))
									.join("\n") + (visible.length > 20 ? `\n${visible.length - 20} additional jobs.` : "")
							: "No outstanding background work.",
						visible.slice(0, 20),
						true,
						Math.max(0, visible.length - 20),
					);
				},
			}),
		);
		for (const action of ["wait", "stop"] as const)
			pi.registerTool(
				defineTool({
					name: `background_${action}`,
					label: action === "wait" ? "Wait for background job" : "Stop background job",
					renderShell: "self",
					renderCall: (args, theme, context) => {
						startToolTimer(context);
						const component = new Container();
						component.addChild(renderCall(action, args.id, theme));
						if (context.isPartial) {
							const timer = toolTimerText(context, true);
							if (timer) component.addChild(new Text(theme.fg("muted", timer.toLowerCase()), 2, 0));
						}
						return renderHeader(component, context.outputPad, theme);
					},
					renderResult: (result, options, theme, context) => {
						const timer = toolTimerText(context, options.isPartial);
						return renderResult(
							result,
							options,
							theme,
							context,
							action === "wait" ? timer?.replace(/^Took /, "Waited ") : timer,
						);
					},
					description:
						action === "wait"
							? `Wait for a background command to finish, up to ${WAIT_SECONDS} seconds. Returns its final result or a still-running status.`
							: "Stop a background job and return its final state and output.",
					parameters: Type.Object({ id: Type.String() }),
					async execute(_id, args, signal) {
						const owner = jobs;
						const job = owner.get(args.id);
						if (action === "stop") owner.stop(job);
						const outcome = await owner.wait(job, signal, action);
						if (outcome !== "completed" && !terminal(job)) return receipt(job, outcome);
						job.announced = true;
						return reply(describe(job), [job]);
					},
				}),
			);
	}

	pi.on("session_start", async (event, context) => {
		ctx = context;
		if (!registered) {
			registerTools();
			registered = true;
		}
		if (event.reason === "new" || event.reason === "resume" || event.reason === "fork") {
			busy = true;
			await jobs.close();
			jobs = new Jobs(schedule);
			stopped = false;
			userInput = false;
			runSignal = undefined;
			busy = false;
		}
		schedule();
	});
	pi.on("agent_start", (_event, context) => {
		ctx = context;
		runSignal = context.signal;
		busy = true;
	});
	pi.on("input", (event) => {
		userInput = event.source !== "extension";
	});
	pi.on("before_agent_start", (event) => {
		const freshUser = event.messageType === "user" && userInput;
		userInput = false;
		if (!freshUser) return;
		stopped = false;
	});
	pi.on("agent_end", (event) => {
		const last = [...event.messages].reverse().find((message) => message.role === "assistant");
		if (last?.role === "assistant" && (last.stopReason === "aborted" || last.stopReason === "error")) interrupt();
	});
	pi.on("agent_settled", (event) => {
		busy = false;
		if (event.aborted) interrupt();
		schedule();
	});
	pi.on("ui_prompt_start", () => {
		prompting = true;
	});
	pi.on("ui_prompt_end", () => {
		prompting = false;
		schedule();
	});
	pi.on("session_compact", schedule);
	pi.on("session_tree", (event) => {
		if (event.newLeafId !== event.oldLeafId) interrupt();
	});
	pi.on("session_compact_failed", (event) => {
		if (event.aborted) interrupt();
		schedule();
	});
	pi.on("session_shutdown", async () => {
		closed = true;
		clearTimeout(deliveryTimer);
		await jobs.close();
		ctx?.ui.setStatus("background", undefined);
	});
	return { promote };
}
