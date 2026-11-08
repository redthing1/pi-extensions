import type { ToolDescriptor } from "./types.js";

export const BUILTIN_TOOL_DESCRIPTORS: ToolDescriptor[] = [
	{
		name: "read",
		effects: ["read_files"],
		risk: "safe_read",
		pathInputs: [{ field: "path", operation: "read" }],
		known: true,
	},
	{
		name: "ls",
		effects: ["list_files"],
		risk: "safe_read",
		pathInputs: [{ field: "path", operation: "list" }],
		known: true,
	},
	{
		name: "grep",
		effects: ["read_files", "list_files"],
		risk: "safe_read",
		pathInputs: [{ field: "path", operation: "read" }],
		known: true,
	},
	{
		name: "find",
		effects: ["read_files", "list_files"],
		risk: "safe_read",
		pathInputs: [{ field: "path", operation: "list" }],
		known: true,
	},
	{
		name: "edit",
		effects: ["write_files"],
		risk: "mutating",
		pathInputs: [{ field: "path", operation: "write" }],
		known: true,
	},
	{
		name: "write",
		effects: ["write_files"],
		risk: "mutating",
		pathInputs: [{ field: "path", operation: "write" }],
		known: true,
	},
	{
		name: "bash",
		effects: ["run_command"],
		risk: "unknown",
		pathInputs: [],
		known: true,
	},
];
