import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Static } from "typebox";
import {
	observeActiveWorkspace,
	type WorkspaceAccess,
	type WorkspaceChildOperations,
	type WorkspaceObserver,
} from "../../shared/active-workspace.ts";
import {
	type ChildRuntimeContributors,
	disposeChildLaunchContributions,
	prepareChildLaunchContributions,
} from "../../shared/child-runtime.ts";
import { registerBackgroundRuns } from "./background.ts";
import { childIntent, resolveCommission } from "./commission.ts";
import {
	renderLifecycleCall,
	renderSubagentCall,
	renderSubagentResult,
	renderSubagentSendCall,
	renderSubagentSendResult,
} from "./render.ts";
import {
	childPresentations,
	compactTargets,
	formatList,
	formatStarted,
	formatTargets,
	inspectionPresentations,
	resultPage,
	targetSummary,
} from "./results.ts";
import type { SubagentScheduler } from "./scheduler.ts";
import { StartSchema, ListSchema, RunIdsSchema, SendSchema, WaitSchema } from "./schema.ts";
import type { CommissionInput, PreparedCommission, RunTargetView, SubagentToolDetails } from "./types.ts";

type StartParams = Static<typeof StartSchema>;
const DEFAULT_WAIT_SECONDS = 30;

export type SubagentIntegrations = ChildRuntimeContributors;

export function registerSubagentTools(
	pi: ExtensionAPI,
	scheduler: SubagentScheduler,
	integrations: SubagentIntegrations,
): void {
	registerBackgroundRuns(pi, scheduler);
	const workspaces = observeActiveWorkspace(pi, (access) => {
		if (access.kind === "ready" && access.workspace.children) {
			for (const name of ["subagent", "subagent_wait", "subagent_list", "subagent_cancel", "subagent_send"]) {
				access.workspace.registerCompatibleTool(name);
			}
		}
	});

	pi.registerTool(
		defineTool<typeof StartSchema, SubagentToolDetails>({
			name: "subagent",
			label: "Subagent",
			description:
				"Delegate distinct, self-contained work with exact tools. Foreground waits for results; background returns child IDs and announces each completion.",
			promptSnippet: "Delegate a distinct workstream to its own context",
			parameters: StartSchema,
			executionMode: "parallel",
			async execute(toolCallId, params, signal, onUpdate, ctx) {
				let admittedBatchId: string | undefined;
				let ids: string[] = [];
				try {
					const prepared = await prepareCommissions({
						toolCallId,
						params,
						ctx,
						workspaces,
						integrations,
						signal,
					});
					if (signal?.aborted) {
						try {
							await disposePrepared(prepared);
						} catch (cleanupError) {
							throw combinedError(
								"Subagent submission was cancelled before admission",
								new Error("interrupted"),
								"prepared child cleanup failed",
								cleanupError,
							);
						}
						throw new Error("Subagent submission was cancelled before admission.");
					}
					const batchId = prepared[0].spec.batchId;
					const batch = await scheduler.admit({
						batchId,
						background: params.background,
						prepared,
					});
					admittedBatchId = batch.id;
					ids = batch.children.map((child) => child.id);
					if (params.background) {
						return toolResult("start", [batch], formatStarted(batch));
					}
					onUpdate?.(toolResult("start", [batch], formatStarted(batch)));
					try {
						const targets = await scheduler.wait(ids, signal, (updated) =>
							onUpdate?.(toolResult("start", updated, formatTargets(updated))),
						);
						const page = resultPage(targets);
						const output = page.text;
						if (page.nextOffset === undefined) scheduler.acknowledge(ids);
						return toolResult("start", [scheduler.batch(batch.id)], output);
					} catch (error) {
						if (signal?.aborted) {
							try {
								await scheduler.cancel(ids);
							} catch (cancelError) {
								throw combinedError(
									"Foreground subagent wait was interrupted",
									error,
									"cancellation failed",
									cancelError,
								);
							}
							throw new Error("Foreground subagents were interrupted and cancelled.");
						}
						throw error;
					}
				} catch (error) {
					return errorResult("start", error, admittedBatchId ? scheduler.targets(ids) : []);
				}
			},
			renderCall: renderSubagentCall,
			renderResult: (result, options, theme) => renderSubagentResult(result, options.expanded, theme),
		}),
	);

	pi.registerTool(
		defineTool<typeof WaitSchema, SubagentToolDetails>({
			name: "subagent_wait",
			label: "Subagent Wait",
			description:
				"Wait for all selected children and collect their results. A timeout returns status without collecting. Large results include the exact next-page call.",
			promptSnippet: "Wait for background subagent results",
			parameters: WaitSchema,
			executionMode: "parallel",
			async execute(_toolCallId, params, signal, onUpdate) {
				try {
					const timeoutSeconds = params.timeoutSeconds === undefined ? DEFAULT_WAIT_SECONDS : params.timeoutSeconds;
					const targets = await scheduler.wait(
						params.ids,
						signal,
						(updated) => onUpdate?.(toolResult("wait", updated, formatTargets(updated))),
						timeoutSeconds === null ? undefined : timeoutSeconds * 1000,
					);
					if (targets.some((target) => target.finishedAt === undefined)) {
						const result = toolResult(
							"wait",
							targets,
							`Time limit reached; no results collected.\n\n${targets.map(targetSummary).join("\n")}`,
						);
						result.details.timedOut = true;
						return result;
					}
					const page = resultPage(targets, params.offset);
					const output = page.text;
					if (page.nextOffset === undefined) {
						scheduler.acknowledge(params.ids);
						for (const target of targets) if (target.kind === "child") target.collected = true;
					}
					return toolResult("wait", targets, output, params.offset);
				} catch (error) {
					return errorResult("wait", error, []);
				}
			},
			renderCall: (args, theme) => renderLifecycleCall("subagent_wait", args, theme),
			renderResult: (result, options, theme) => renderSubagentResult(result, options.expanded, theme),
		}),
	);

	pi.registerTool(
		defineTool<typeof ListSchema, SubagentToolDetails>({
			name: "subagent_list",
			label: "Subagent List",
			description:
				"Show running children and uncollected results. Supply ids to inspect tasks, recent activity, and messages; includeCollected reveals retained history.",
			promptSnippet: "List current subagent runs",
			parameters: ListSchema,
			executionMode: "parallel",
			async execute(_id, params) {
				try {
					if (params.messageOffset !== undefined && params.ids?.length !== 1)
						throw new Error("Use messageOffset with exactly one child ID.");
					const all = scheduler.runs({ ids: params.ids, includeCollected: true });
					const pendingMessages = new Set(
						scheduler
							.notices()
							.filter((notice) => notice.messages.length)
							.map((notice) => notice.child.id),
					);
					const start = params.after ? all.findIndex((child) => child.id === params.after) + 1 : 0;
					if (params.after && start === 0)
						throw new Error("Unknown list continuation; reuse the previous page's call.");
					const visible = all
						.slice(start)
						.filter(
							(child) => params.ids || params.includeCollected || !child.collected || pendingMessages.has(child.id),
						);
					const shown = [];
					const parts: string[] = [];
					let bytes = 0;
					for (const child of visible) {
						const part = formatList([child], !!params.ids, params.messageOffset);
						if (shown.length && (shown.length >= 50 || bytes + Buffer.byteLength(part) > 45_000)) break;
						shown.push(child);
						parts.push(part);
						bytes += Buffer.byteLength(part);
					}
					const omitted =
						params.ids || params.includeCollected
							? 0
							: all.filter((child) => child.collected && !pendingMessages.has(child.id)).length;
					if (omitted) parts.push(`${omitted} collected children omitted; includeCollected=true shows history.`);
					if (shown.length < visible.length)
						parts.push(`[More children: subagent_list ${JSON.stringify({ ...params, after: shown.at(-1)!.id })}]`);
					const result = toolResult("list", shown, parts.join("\n\n") || "No outstanding subagents.");
					result.details.omittedChildren = omitted;
					result.details.moreChildren = shown.length < visible.length;
					if (params.ids) result.details.presentations = inspectionPresentations(shown, params.messageOffset);
					return result;
				} catch (error) {
					return errorResult("list", error, []);
				}
			},
			renderCall: (args, theme) => renderLifecycleCall("subagent_list", args, theme),
			renderResult: (result, options, theme) => renderSubagentResult(result, options.expanded, theme),
		}),
	);

	pi.registerTool(
		defineTool<typeof RunIdsSchema, SubagentToolDetails>({
			name: "subagent_cancel",
			label: "Subagent Cancel",
			description:
				`Cancel selected children and wait up to ${DEFAULT_WAIT_SECONDS} seconds for cleanup. Pending cancellation continues in the background. Completed siblings keep their uncollected results.`,
			promptSnippet: "Cancel subagent runs explicitly",
			parameters: RunIdsSchema,
			executionMode: "parallel",
			async execute(_toolCallId, params, signal, onUpdate) {
				const deadline = new AbortController();
				const waitSignal = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
				const timer = setTimeout(() => deadline.abort(), DEFAULT_WAIT_SECONDS * 1000);
				try {
					const targets = await scheduler.cancel(params.ids, waitSignal, (updated) =>
						onUpdate?.(toolResult("cancel", updated, formatList(updated))),
					);
					return toolResult("cancel", targets, formatTargets(targets));
				} catch (error) {
					if (deadline.signal.aborted && !signal?.aborted) {
						const targets = scheduler.targets(params.ids);
						const result = toolResult(
							"cancel",
							targets,
							`Cancellation is still in progress; no results collected. Use subagent_list or subagent_wait to follow progress.\n\n${formatList(targets)}`,
						);
						result.details.timedOut = true;
						return result;
					}
					return errorResult("cancel", error, []);
				} finally {
					clearTimeout(timer);
				}
			},
			renderCall: (args, theme) => renderLifecycleCall("subagent_cancel", args, theme),
			renderResult: (result, options, theme) => renderSubagentResult(result, options.expanded, theme),
		}),
	);

	pi.registerTool(
		defineTool<typeof SendSchema, SubagentToolDetails, { label?: string }>({
			name: "subagent_send",
			label: "Subagent Send",
			description:
				"Send a message to a live child at its next agent step; does not interrupt tools or wait for a reply.",
			promptSnippet: "Steer a live child",
			parameters: SendSchema,
			executionMode: "parallel",
			async execute(_call, params) {
				let result: AgentToolResult<SubagentToolDetails>;
				try {
					const output = await scheduler.send(params.id, params.message);
					result = toolResult("send", [], output);
				} catch (error) {
					result = errorResult("send", error, []);
				}
				try {
					result.details.recipientLabel = scheduler.label(params.id);
				} catch {
					// Unknown children have no label.
				}
				return result;
			},
			renderCall: (args, theme, context) => {
				if (!context.state.label && args.id) {
					try {
						context.state.label = scheduler.label(args.id);
					} catch {
						// Unknown children still show the supplied ID and the send error.
					}
				}
				return {
					invalidate() {},
					render: (width) =>
						renderSubagentSendCall({ ...args, label: context.state.label }, context.expanded, theme).render(width),
				};
			},
			renderResult: (result, options, theme, context) => {
				context.state.label = result.details?.recipientLabel ?? context.state.label;
				return renderSubagentSendResult(result, options.expanded, theme);
			},
		}),
	);
}

async function prepareCommissions(input: {
	toolCallId: string;
	params: StartParams;
	ctx: ExtensionContext;
	workspaces: WorkspaceObserver;
	integrations: SubagentIntegrations;
	signal?: AbortSignal;
}): Promise<PreparedCommission[]> {
	if (!input.ctx.model) {
		throw new Error("No active parent model is available for child model inheritance.");
	}
	const batchId = `batch-${randomUUID()}`;
	const thinkingLevel = input.ctx.thinkingLevel;
	const access = input.workspaces.current();
	const baseCwd = access.kind === "ready" ? access.workspace.identity.cwd : input.ctx.cwd;
	const workspaceChildren = childOperations(access);
	const specs = [];
	for (let index = 0; index < input.params.tasks.length; index += 1) {
		if (input.signal?.aborted) throw new Error("Subagent submission was cancelled.");
		const commission: CommissionInput = input.params.tasks[index];
		const cwd = await resolveWorkspaceCwd(access, baseCwd, commission.cwd ?? ".");
		const spec = resolveCommission({
			commission,
			index,
			batchId,
			toolCallId: input.toolCallId,
			cwd,
			parentModel: {
				provider: input.ctx.model.provider,
				id: input.ctx.model.id,
			},
			privacy: input.ctx.privacy,
			thinkingLevel,
			toolProviders: input.integrations.tools,
		});
		specs.push({ ...spec, contextWindow: validateModel(spec, input.ctx) });
	}

	const prepared: PreparedCommission[] = [];
	try {
		for (const spec of specs) {
			if (input.signal?.aborted) throw new Error("Subagent submission was cancelled.");
			const intent = childIntent(spec);
			const contributions = await prepareChildLaunchContributions(input.integrations, intent, spec.extensionTools);
			prepared.push({ spec, intent, contributions, workspaceChildren });
		}
		return prepared;
	} catch (error) {
		try {
			await disposePrepared(prepared);
		} catch (cleanupError) {
			throw combinedError("Subagent batch preparation failed", error, "prepared child cleanup failed", cleanupError);
		}
		throw error;
	}
}

function validateModel(spec: PreparedCommission["spec"], ctx: ExtensionContext): number {
	const model = ctx.modelRegistry.find(spec.provider, spec.modelId);
	if (!model) {
		throw new Error(`Child model '${spec.model}' is not registered.`);
	}
	if (
		ctx.scopedModels.length > 0 &&
		!ctx.scopedModels.some((entry) => entry.model.provider === spec.provider && entry.model.id === spec.modelId)
	) {
		throw new Error(`Child model '${spec.model}' is outside the session's scoped models.`);
	}
	return model.contextWindow;
}

async function resolveWorkspaceCwd(access: WorkspaceAccess, base: string, value: string): Promise<string> {
	if (access.kind === "local") return realpath(path.resolve(base, value));
	if (access.kind === "unavailable") throw new Error("Active workspace is unavailable.");
	access.workspace.assertActive();
	if (!access.workspace.files) {
		throw new Error("Active workspace does not provide path operations.");
	}
	return access.workspace.files.canonicalize(path.posix.isAbsolute(value) ? value : path.posix.resolve(base, value));
}

function childOperations(access: WorkspaceAccess): WorkspaceChildOperations | undefined {
	if (access.kind === "local") return undefined;
	if (access.kind === "unavailable") throw new Error("Active workspace is unavailable.");
	access.workspace.assertActive();
	if (!access.workspace.children) {
		throw new Error("Active workspace does not support child agents.");
	}
	return access.workspace.children;
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

function combinedError(primaryLabel: string, primary: unknown, secondaryLabel: string, secondary: unknown): Error {
	return new Error(`${primaryLabel}: ${errorText(primary)}\n${secondaryLabel}: ${errorText(secondary)}`);
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function toolResult(
	operation: SubagentToolDetails["operation"],
	targets: readonly RunTargetView[],
	output: string,
	offset?: number,
): AgentToolResult<SubagentToolDetails> {
	const presentations = childPresentations(targets, operation !== "list");
	return {
		content: [{ type: "text", text: output }],
		details: { operation, targets: compactTargets(targets), presentations, offset },
	};
}

function errorResult(
	operation: SubagentToolDetails["operation"],
	error: unknown,
	targets: readonly RunTargetView[],
): AgentToolResult<SubagentToolDetails> {
	const message = error instanceof Error ? error.message : String(error);
	const presentations = childPresentations(targets, operation !== "list");
	return {
		content: [{ type: "text", text: message }],
		details: {
			operation,
			targets: compactTargets(targets),
			presentations,
			error: message,
		},
	};
}
