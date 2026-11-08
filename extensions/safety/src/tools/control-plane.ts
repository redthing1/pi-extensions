import type { ToolDescriptor } from "./types.js";

export const CONTROL_PLANE_TOOL_DESCRIPTORS: ToolDescriptor[] = [
	{
		name: "request_plan_input",
		effects: [],
		risk: "safe",
		pathInputs: [],
		known: true,
	},
	{
		name: "submit_plan",
		effects: [],
		risk: "safe",
		pathInputs: [],
		known: true,
	},
];
