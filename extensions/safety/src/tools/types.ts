import type {
	ToolEffectAnalysis,
	ToolPathInput as SharedToolPathInput,
} from "../../../shared/tool-effects.ts";
import type { SafetyEffect, SafetyRisk } from "../shell/types.js";

export type ToolPathInput = SharedToolPathInput;

export interface ToolDescriptor {
	name: string;
	effects: SafetyEffect[];
	risk: SafetyRisk;
	pathInputs: ToolPathInput[];
	known: boolean;
}

export type ToolAnalysis = ToolEffectAnalysis;
