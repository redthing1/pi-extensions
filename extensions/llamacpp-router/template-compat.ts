import type { ChatTemplateKwargValue, ThinkingLevelMap } from "@earendil-works/pi-ai";
import type { ChatTemplateInfo } from "./types.js";

const PI_THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
const PI_THINKING_LEVEL_SET = new Set<string>(PI_THINKING_LEVELS);

export interface TemplateFeatures {
	supportsThinking: boolean;
	supportsReasoningEffort: boolean;
	reasoningEffortLevels?: readonly string[];
	supportsPreserveReasoning: boolean;
}

export function inferTemplateFeatures(template: ChatTemplateInfo): TemplateFeatures {
	const reasoningEffortLevels = template.reasoningEffortLevels?.filter((level) => PI_THINKING_LEVEL_SET.has(level));
	const supportsReasoningEffort = template.supportsReasoningEffort === true || (reasoningEffortLevels?.length ?? 0) > 0;
	return {
		supportsThinking:
			template.supportsThinking === true || supportsReasoningEffort || template.supportsPreserveReasoning === true,
		supportsReasoningEffort,
		reasoningEffortLevels,
		supportsPreserveReasoning: template.supportsPreserveReasoning === true,
	};
}

export function thinkingLevelMapForTemplate(features: TemplateFeatures): ThinkingLevelMap | undefined {
	if (!features.reasoningEffortLevels || features.reasoningEffortLevels.length === 0) return undefined;

	const supported = new Set(features.reasoningEffortLevels);
	return Object.fromEntries(
		PI_THINKING_LEVELS.map((level) => [level, supported.has(level) ? level : null]),
	) as ThinkingLevelMap;
}

export function mapThinkingLevel(
	model: { thinkingLevelMap?: ThinkingLevelMap },
	level: keyof ThinkingLevelMap,
): string | null | undefined {
	const map = model.thinkingLevelMap;
	if (!map) return level;
	const mapped = map[level];
	return mapped === undefined ? level : mapped;
}

export function chatTemplateThinkingKwargs(features: TemplateFeatures): Record<string, ChatTemplateKwargValue> {
	const kwargs: Record<string, ChatTemplateKwargValue> = {
		enable_thinking: { $var: "thinking.enabled" },
	};
	if (features.supportsPreserveReasoning) {
		kwargs.preserve_thinking = true;
	}
	if (features.supportsReasoningEffort) {
		kwargs.reasoning_effort = { $var: "thinking.effort", omitWhenOff: true };
	}
	return kwargs;
}
