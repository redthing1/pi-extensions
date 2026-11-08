import type { ToolEffectAnalyzer } from "../shared/tool-effects.ts";

export const APPLY_PATCH_EFFECTS = ["write_files"] as const;

export function createApplyPatchEffectAnalyzer(toolName: string): ToolEffectAnalyzer {
	return {
		toolName,
		analyze: () => ({
			toolName,
			effects: [...APPLY_PATCH_EFFECTS],
			risk: "mutating",
			pathInputs: [
				{ field: "operations[].path", operation: "write" },
				{ field: "operations[].move_path", operation: "write" },
			],
			known: true,
			reason: "apply_patch writes requested files",
		}),
	};
}
