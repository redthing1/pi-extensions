import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import type { AgentToolResult, ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { toolGoalText } from "./prompts.js";
import type { GoalRuntime } from "./runtime.js";
import type { GoalToolResponse } from "./types.js";

const EmptyParamsSchema = Type.Object({}, { additionalProperties: false });
const CreateGoalParamsSchema = Type.Object(
	{
		objective: Type.String({
			description:
				"Required. The concrete objective to start pursuing. This starts a new active goal when no goal exists or replaces the current goal when it is complete.",
		}),
		token_budget: Type.Optional(Type.Integer({ description: "Positive token budget for the new goal. Omit unless explicitly requested." })),
	},
	{ additionalProperties: false },
);
const UpdateGoalParamsSchema = Type.Object(
	{
		status: Type.Union([Type.Literal("complete"), Type.Literal("blocked")], {
			description:
				"Required. Set to complete only when the objective is achieved and no required work remains. Set to blocked only after the same blocking condition has recurred for at least three consecutive goal turns and the agent is at an impasse.",
		}),
	},
	{ additionalProperties: false },
);

export function registerGoalTools(pi: ExtensionAPI, runtime: GoalRuntime): void {
	pi.registerTool(getGoalTool(runtime));
	pi.registerTool(createGoalTool(runtime));
	pi.registerTool(updateGoalTool(runtime));
}

function getGoalTool(runtime: GoalRuntime): ToolDefinition<typeof EmptyParamsSchema, GoalToolResponse> {
	return {
		name: "get_goal",
		label: "get_goal",
		description: "Get the current goal for this session, including status, budgets, token and elapsed-time usage, and remaining token budget.",
		promptSnippet: "Get the current goal for this session, including status, budgets, token and elapsed-time usage, and remaining token budget.",
		parameters: EmptyParamsSchema,
		async execute() {
			return jsonResult(runtime.response());
		},
		renderResult(result, _options, theme) {
			return new Text(theme.fg("muted", toolGoalText(result.details.goal)), 0, 0);
		},
	};
}

function createGoalTool(runtime: GoalRuntime): ToolDefinition<typeof CreateGoalParamsSchema, GoalToolResponse> {
	return {
		name: "create_goal",
		label: "create_goal",
		description:
			"Create a goal only when explicitly requested by the user or system/developer instructions; do not infer goals from ordinary tasks. Set token_budget only when an explicit token budget is requested. Fails if an unfinished goal exists; use update_goal only for status.",
		promptSnippet: "Create a goal only when explicitly requested by the user or system/developer instructions.",
		promptGuidelines: [
			"Do not create goals from ordinary tasks unless the user explicitly asks to set a goal.",
			"Set token_budget only when the user explicitly requests a token budget.",
		],
		parameters: CreateGoalParamsSchema,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			runtime.createFromTool(params.objective, parseOptionalBudget(params.token_budget), ctx);
			return jsonResult(runtime.response());
		},
		renderResult(result, _options, theme) {
			return new Text(theme.fg("success", "Goal active") + "\n" + theme.fg("muted", toolGoalText(result.details.goal)), 0, 0);
		},
	};
}

function updateGoalTool(runtime: GoalRuntime): ToolDefinition<typeof UpdateGoalParamsSchema, GoalToolResponse> {
	return {
		name: "update_goal",
		label: "update_goal",
		description:
			"Update the existing goal. Use this tool only to mark the goal achieved or genuinely blocked. Set complete only when the objective is achieved and no required work remains. Set blocked only after the same blocking condition has recurred for at least three consecutive goal turns and the agent cannot make meaningful progress without user input or an external-state change. Do not use blocked merely because work is hard, slow, uncertain, incomplete, or would benefit from clarification. You cannot pause, resume, or budget-limit goals with this tool.",
		promptSnippet: "Mark the active goal complete or blocked only when the strict goal contract is satisfied.",
		promptGuidelines: [
			"Call update_goal with complete only after auditing the objective against actual evidence.",
			"Call update_goal with blocked only after the same genuine impasse has recurred for at least three consecutive goal turns.",
		],
		parameters: UpdateGoalParamsSchema,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (params.status === "complete") runtime.completeFromTool(ctx);
			else runtime.blockFromTool(ctx);
			return jsonResult(runtime.response(params.status === "complete"));
		},
		renderResult(result, _options, theme) {
			const title = result.details.goal?.status === "blocked" ? "Goal blocked" : "Goal complete";
			const report = result.details.completionBudgetReport;
			return new Text(theme.fg("success", title) + (report ? `\n${theme.fg("muted", report)}` : ""), 0, 0);
		},
	};
}

function parseOptionalBudget(value: number | undefined): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isSafeInteger(value) || value <= 0) throw new Error("token_budget must be a positive integer.");
	return value;
}

function jsonResult(response: GoalToolResponse): AgentToolResult<GoalToolResponse> {
	return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], details: response };
}
