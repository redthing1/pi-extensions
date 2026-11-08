import { randomUUID } from "node:crypto";
import type { ChildRunIntent, ChildToolProviderObserver } from "../../shared/child-runtime.ts";
import {
	builtinChildToolEffects,
	UNKNOWN_CHILD_TOOL_EFFECTS,
	type ToolEffect,
	type ToolEffectAnalysis,
	type ToolEffectAnalyzer,
	type ToolEffectContext,
} from "../../shared/tool-effects.ts";
import type { CommissionInput, ResolvedCommission } from "./types.ts";

export interface ResolveCommissionInput {
	commission: CommissionInput;
	index: number;
	batchId: string;
	toolCallId: string;
	cwd: string;
	parentModel: { provider: string; id: string };
	thinkingLevel?: ResolvedCommission["thinkingLevel"];
	privacy: { clientZdr: boolean; remoteZdr: boolean };
	toolProviders: ChildToolProviderObserver;
}

export function resolveCommission(input: ResolveCommissionInput): ResolvedCommission {
	const task = input.commission.task.trim();
	if (!task) throw new Error(`Task ${input.index + 1} has empty instructions.`);
	if (input.commission.label && input.commission.label.length > 120)
		throw new Error("Use a short child label of at most 120 characters.");
	const tools = resolveTaskTools(input.commission.tools);
	const resolvedTools = resolveTools(tools, input.toolProviders);
	const model = resolveModel(input.commission.model, input.parentModel);
	return {
		id: `child-${randomUUID()}`,
		batchId: input.batchId,
		toolCallId: input.toolCallId,
		index: input.index,
		label: input.commission.label?.trim() || `subagent-${input.index + 1}`,
		task,
		cwd: input.cwd,
		provider: model.provider,
		modelId: model.id,
		model: model.model,
		modelSource: model.source,
		thinkingLevel: input.thinkingLevel,
		tools,
		extensionTools: resolvedTools.extensionTools,
		capabilities: resolvedTools.capabilities,
		privacy: { ...input.privacy },
	};
}

export function childIntent(spec: ResolvedCommission): ChildRunIntent {
	return {
		origin: { kind: "tool", toolCallId: spec.toolCallId },
		runId: spec.id,
		batchId: spec.batchId,
		cwd: spec.cwd,
		model: spec.model,
		provider: spec.provider,
		tools: [...spec.tools],
		capabilities: [...spec.capabilities],
		references: [],
		privacy: { ...spec.privacy },
	};
}

export function createSubagentEffectAnalyzer(toolProviders: ChildToolProviderObserver): ToolEffectAnalyzer {
	return {
		toolName: "subagent",
		analyze(input, context) {
			return analyzeSubagentEffects(input, context, toolProviders);
		},
	};
}

export function analyzeSubagentEffects(
	input: Record<string, unknown> | undefined,
	_context: ToolEffectContext,
	toolProviders: ChildToolProviderObserver,
): ToolEffectAnalysis {
	const rawCommissions = input?.tasks;
	if (!Array.isArray(rawCommissions) || rawCommissions.length === 0) {
		return unknownAnalysis("subagent tasks could not be resolved");
	}

	const capabilities = new Set<ToolEffect>();
	const pathReferences: Array<{ path: string; operation: "read" | "list" | "write" }> = [];
	let unresolved = false;
	for (const raw of rawCommissions) {
		if (!isRecord(raw)) {
			unresolved = true;
			for (const operation of childPathOperations(UNKNOWN_CHILD_TOOL_EFFECTS)) {
				pathReferences.push({ path: ".", operation });
			}
			continue;
		}
		let childUnresolved = false;
		const explicitTools = stringArrayField(raw, "tools");
		if (raw.tools !== undefined && !explicitTools) childUnresolved = true;
		const cwd = stringField(raw, "cwd") ?? ".";
		if (raw.cwd !== undefined && !stringField(raw, "cwd")) childUnresolved = true;
		const childCapabilities = new Set<ToolEffect>();
		let tools: readonly string[];
		try {
			tools = resolveTaskTools(explicitTools);
		} catch {
			childUnresolved = true;
			tools = [];
		}
		for (const tool of tools) {
			try {
				for (const effect of resolveTool(tool, toolProviders).effects) childCapabilities.add(effect);
			} catch {
				childUnresolved = true;
			}
		}
		if (childUnresolved) {
			unresolved = true;
			for (const effect of UNKNOWN_CHILD_TOOL_EFFECTS) childCapabilities.add(effect);
		}
		for (const effect of childCapabilities) capabilities.add(effect);
		for (const operation of childPathOperations([...childCapabilities])) {
			pathReferences.push({ path: cwd, operation });
		}
	}
	if (unresolved) {
		for (const effect of UNKNOWN_CHILD_TOOL_EFFECTS) capabilities.add(effect);
	}
	const childEffects = [...capabilities];
	const readOnly = !unresolved && childEffects.every((effect) => effect === "read_files" || effect === "list_files");
	return {
		toolName: "subagent",
		effects: uniqueEffects(["run_command", ...childEffects]),
		risk: readOnly ? "safe_read" : "unknown",
		pathInputs: [],
		pathReferences,
		known: true,
		reason: unresolved
			? "subagent intent could not be fully resolved"
			: readOnly
				? "resolved read-only child tasks"
				: "resolved capability-bearing child tasks",
	};
}

function resolveTaskTools(explicitTools: readonly string[] | undefined): string[] {
	if (!explicitTools) throw new Error("Each task requires tools: choose the exact child tools, or [] for none.");
	return uniqueStrings(explicitTools);
}

function resolveModel(
	requested: string | undefined,
	parent: { provider: string; id: string },
): { provider: string; id: string; model: string; source: "inherited" | "explicit" } {
	if (!requested) {
		return {
			provider: parent.provider,
			id: parent.id,
			model: `${parent.provider}/${parent.id}`,
			source: "inherited",
		};
	}
	const value = requested.trim();
	if (!value) throw new Error("Explicit child model cannot be empty.");
	const separator = value.indexOf("/");
	const provider = separator === -1 ? parent.provider : value.slice(0, separator);
	const id = separator === -1 ? value : value.slice(separator + 1);
	if (!provider || !id) throw new Error(`Invalid child model '${requested}'.`);
	if (provider !== parent.provider) {
		throw new Error(
			`Child model provider '${provider}' differs from parent provider '${parent.provider}'. Cross-provider selection is not enabled.`,
		);
	}
	return { provider, id, model: `${provider}/${id}`, source: "explicit" };
}

function resolveTools(
	tools: readonly string[],
	providers: ChildToolProviderObserver,
): { extensionTools: string[]; capabilities: ToolEffect[] } {
	const extensionTools: string[] = [];
	const capabilities = new Set<ToolEffect>();
	for (const tool of tools) {
		const resolved = resolveTool(tool, providers);
		if (resolved.extension) extensionTools.push(tool);
		for (const effect of resolved.effects) capabilities.add(effect);
	}
	return { extensionTools, capabilities: [...capabilities] };
}

function resolveTool(
	tool: string,
	providers: ChildToolProviderObserver,
): { effects: readonly ToolEffect[]; extension: boolean } {
	const native = builtinChildToolEffects(tool);
	const provided = providers.definition(tool);
	if (native && provided) throw new Error(`Child tool '${tool}' is both native and provided by an extension.`);
	const effects = native ?? provided?.effects;
	if (!effects) throw new Error(`Tool '${tool}' is not available to children.`);
	return { effects, extension: Boolean(provided) };
}

function unknownAnalysis(reason: string): ToolEffectAnalysis {
	return {
		toolName: "subagent",
		effects: [...UNKNOWN_CHILD_TOOL_EFFECTS],
		risk: "unknown",
		pathInputs: [],
		pathReferences: childPathOperations(UNKNOWN_CHILD_TOOL_EFFECTS).map((operation) => ({
			path: ".",
			operation,
		})),
		known: true,
		reason,
	};
}

function childPathOperations(effects: readonly ToolEffect[]) {
	return [
		...(effects.includes("list_files") ? ["list" as const] : []),
		...(effects.includes("read_files") ? ["read" as const] : []),
		...(effects.includes("write_files") ? ["write" as const] : []),
	];
}

function uniqueStrings(values: readonly string[]): string[] {
	const result: string[] = [];
	for (const value of values) {
		const normalized = value.trim();
		if (normalized && !result.includes(normalized)) result.push(normalized);
	}
	return result;
}

function uniqueEffects(effects: readonly ToolEffect[]): ToolEffect[] {
	return [...new Set(effects)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArrayField(record: Record<string, unknown>, key: string): string[] | undefined {
	const value = record[key];
	if (!Array.isArray(value)) return undefined;
	if (!value.every((entry) => typeof entry === "string" && entry.trim())) {
		return undefined;
	}
	return value.map((entry: string) => entry.trim());
}
