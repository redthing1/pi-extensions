import type { EffectiveSafetyPolicy } from "../config/types.js";
import type { PathAccess } from "../paths/types.js";
import type { SafetyEffect, SafetyRisk, ShellAnalysis } from "../shell/types.js";

export type SafetyRequestSource = "model_tool" | "user_bash";

export interface SafetyRequest {
	id: string;
	source: SafetyRequestSource;
	cwd: string;
	workspaceRoot: string;
	toolName?: string;
	command?: string;
	effects: SafetyEffect[];
	risk: SafetyRisk;
	paths: PathAccess[];
	summary: string;
	reason: string;
	shell?: ShellAnalysis;
}

export interface SafetyRuntimeContext {
	policy: EffectiveSafetyPolicy;
}

