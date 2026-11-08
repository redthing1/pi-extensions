import type { ToolEffectContext, ToolEffectObserver } from "../../../shared/tool-effects.ts";
import { BUILTIN_TOOL_DESCRIPTORS } from "./builtins.js";
import { CONTROL_PLANE_TOOL_DESCRIPTORS } from "./control-plane.js";
import type { ToolAnalysis, ToolDescriptor } from "./types.js";

const KNOWN_TOOLS = new Map<string, ToolDescriptor>(
	[...BUILTIN_TOOL_DESCRIPTORS, ...CONTROL_PLANE_TOOL_DESCRIPTORS].map(
		(descriptor) => [descriptor.name, descriptor],
	),
);

export function analyzeToolCall(
	toolName: string,
	input?: Record<string, unknown>,
	registered?: { observer: ToolEffectObserver; context: ToolEffectContext },
): ToolAnalysis {
	const descriptor = KNOWN_TOOLS.get(toolName);
	if (descriptor) {
		return {
			toolName,
			effects: descriptor.effects,
			risk: descriptor.risk,
			pathInputs: descriptor.pathInputs,
			known: true,
			reason: "known Safety tool descriptor",
		};
	}
	const registeredAnalysis = registered?.observer.analyze(toolName, input, registered.context);
	if (registeredAnalysis) return registeredAnalysis;
	return {
		toolName,
		effects: [],
		risk: "unknown",
		pathInputs: [],
		known: false,
		reason: "unknown custom tool",
	};
}
