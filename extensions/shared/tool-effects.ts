import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { WorkspaceIdentity } from "./active-workspace.ts";

const TOOL_EFFECT_CHANNEL = "rt1.tool-effects.v1";
const TOOL_EFFECT_QUERY_CHANNEL = "rt1.tool-effects.query.v1";

export type ToolEffect =
	| "read_files"
	| "write_files"
	| "list_files"
	| "run_command"
	| "network"
	| "external_state"
	| "secret_access";

export type ToolRisk = "safe" | "safe_read" | "mutating" | "unknown" | "dangerous" | "catastrophic";

export const UNKNOWN_CHILD_TOOL_EFFECTS: readonly ToolEffect[] = [
	"run_command",
	"read_files",
	"list_files",
	"write_files",
	"network",
	"external_state",
	"secret_access",
];

const BUILTIN_CHILD_TOOL_EFFECTS: Readonly<Record<string, readonly ToolEffect[]>> = {
	read: ["read_files"],
	grep: ["read_files", "list_files"],
	find: ["read_files", "list_files"],
	ls: ["list_files"],
	edit: ["write_files"],
	write: ["write_files"],
	bash: UNKNOWN_CHILD_TOOL_EFFECTS,
};

export function builtinChildToolEffects(name: string): readonly ToolEffect[] | undefined {
	return BUILTIN_CHILD_TOOL_EFFECTS[name];
}

export function builtinChildToolCapabilities(tools: readonly string[]): ToolEffect[] {
	const capabilities = new Set<ToolEffect>();
	for (const tool of tools) {
		const effects = builtinChildToolEffects(tool);
		if (!effects) throw new Error(`Unknown built-in child tool '${tool}'.`);
		for (const effect of effects) capabilities.add(effect);
	}
	return [...capabilities];
}

export type ToolPathOperation = "read" | "list" | "write";

export interface ToolPathInput {
	field: string;
	operation: ToolPathOperation;
}

export interface ToolPathReference {
	path: string;
	operation: ToolPathOperation;
}

export interface ToolEffectAnalysis {
	toolName: string;
	summary?: string;
	effects: ToolEffect[];
	risk: ToolRisk;
	pathInputs: ToolPathInput[];
	pathReferences?: ToolPathReference[];
	known: boolean;
	reason: string;
}

export interface ToolEffectContext {
	cwd: string;
	workspace?: WorkspaceIdentity;
}

export interface ToolEffectAnalyzer {
	toolName: string;
	analyze(input: Record<string, unknown> | undefined, context: ToolEffectContext): ToolEffectAnalysis;
}

export interface ToolEffectObserver {
	analyze(
		toolName: string,
		input: Record<string, unknown> | undefined,
		context: ToolEffectContext,
	): ToolEffectAnalysis | undefined;
}

export function publishToolEffectAnalyzer(pi: Pick<ExtensionAPI, "events">, analyzer: ToolEffectAnalyzer): void {
	pi.events.on(TOOL_EFFECT_QUERY_CHANNEL, () => {
		pi.events.emit(TOOL_EFFECT_CHANNEL, analyzer);
	});
	pi.events.emit(TOOL_EFFECT_CHANNEL, analyzer);
}

export function observeToolEffectAnalyzers(pi: Pick<ExtensionAPI, "events">): ToolEffectObserver {
	const analyzers = new Map<string, ToolEffectAnalyzer>();
	const conflictingTools = new Set<string>();
	pi.events.on(TOOL_EFFECT_CHANNEL, (value) => {
		if (!isToolEffectAnalyzer(value)) return;
		const existing = analyzers.get(value.toolName);
		if (existing && existing !== value) {
			conflictingTools.add(value.toolName);
			return;
		}
		analyzers.set(value.toolName, value);
	});
	pi.events.emit(TOOL_EFFECT_QUERY_CHANNEL, undefined);
	return {
		analyze(toolName, input, context) {
			if (conflictingTools.has(toolName)) {
				throw new Error(`Duplicate tool-effect analyzers published for '${toolName}'.`);
			}
			return analyzers.get(toolName)?.analyze(input, context);
		},
	};
}

function isToolEffectAnalyzer(value: unknown): value is ToolEffectAnalyzer {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<ToolEffectAnalyzer>;
	return (
		typeof candidate.toolName === "string" && candidate.toolName.length > 0 && typeof candidate.analyze === "function"
	);
}
