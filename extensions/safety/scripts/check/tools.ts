import { analyzeAgentSearchTool } from "../../../agent-search/tool-effects.ts";
import { createApplyPatchEffectAnalyzer } from "../../../apply-patch/tool-effects.ts";
import type { ToolEffectObserver } from "../../../shared/tool-effects.ts";
import { analyzeToolCall } from "../../src/tools/catalog.js";
import { extractToolPaths } from "../../src/tools/extract-paths.js";
import { assert } from "./assert.js";

const applyPatchAnalyzer = createApplyPatchEffectAnalyzer("apply_patch");
const extensionEffects: ToolEffectObserver = {
	analyze(toolName, input, context) {
		if (toolName === "web_search" || toolName === "web_fetch") {
			return analyzeAgentSearchTool(toolName, input);
		}
		if (toolName === "apply_patch") {
			return applyPatchAnalyzer.analyze(input, context);
		}
		return undefined;
	},
};

function analyzeExtensionTool(toolName: string, input?: Record<string, unknown>) {
	return analyzeToolCall(toolName, input, {
		observer: extensionEffects,
		context: { cwd: "/tmp/workspace" },
	});
}

export function checkToolClassifier(): void {
	const readTool = analyzeToolCall("read");
	assert(
		readTool.known && readTool.risk === "safe_read",
		"read should be known safe-read tool",
	);
	const readPaths = extractToolPaths(
		{ path: "/tmp/current" },
		readTool.pathInputs,
	);
	assert(readPaths.length === 1, "read extractor should find path field");
	assert(
		readPaths[0]?.path === "/tmp/current",
		"read extractor should use path field",
	);
	assert(
		readPaths.every((path) => path.operation === "read"),
		"read paths should be read operations",
	);

	const unknownTool = analyzeToolCall("surprise_tool");
	assert(
		!unknownTool.known && unknownTool.risk === "unknown",
		"unknown tools should be unknown",
	);

	const webSearch = analyzeExtensionTool("web_search", {
		query: "  Python   pathlib\n documentation  ",
	});
	assert(webSearch.known, "web_search should be a known Safety tool");
	assert(
		webSearch.effects.length === 1 && webSearch.effects[0] === "network",
		"web_search should disclose network access",
	);
	assert(
		webSearch.summary === "Search web: Python pathlib documentation",
		"web_search should render a compact query",
	);
	assert(
		webSearch.reason === "web search requires network access",
		"web_search should explain its approval reason",
	);

	const wikipediaSearch = analyzeExtensionTool("web_search", {
		query: "Ada Lovelace",
		source: "wikipedia",
	});
	assert(
		wikipediaSearch.summary === "Search Wikipedia: Ada Lovelace",
		"Wikipedia search should name its corpus",
	);

	const webFetch = analyzeExtensionTool("web_fetch", {
		url: "https://docs.python.org/3/library/pathlib.html?private=query#fragment",
	});
	assert(webFetch.known, "web_fetch should be a known Safety tool");
	assert(
		webFetch.effects.length === 1 && webFetch.effects[0] === "network",
		"web_fetch should disclose network access",
	);
	assert(
		webFetch.summary === "Fetch https://docs.python.org/3/library/pathlib.html",
		"web_fetch should show the destination without query or fragment",
	);
	assert(
		webFetch.reason === "web fetch requires network access",
		"web_fetch should explain its approval reason",
	);

	const planInputTool = analyzeToolCall("request_plan_input");
	assert(
		planInputTool.known && planInputTool.risk === "safe",
		"request_plan_input should be known safe tool",
	);
	assert(
		planInputTool.effects.length === 0,
		"request_plan_input should have no safety effects",
	);

	const submitPlanTool = analyzeToolCall("submit_plan");
	assert(
		submitPlanTool.known && submitPlanTool.risk === "safe",
		"submit_plan should be known safe tool",
	);
	assert(
		submitPlanTool.effects.length === 0,
		"submit_plan should have no safety effects",
	);

	const registeredObserver: ToolEffectObserver = {
		analyze(toolName) {
			if (toolName !== "owned_tool") return undefined;
			return {
				toolName,
				effects: ["run_command", "read_files"],
				risk: "safe_read",
				pathInputs: [{ field: "cwd", operation: "list" }],
				known: true,
				reason: "tool-owned analysis",
			};
		},
	};
	const registeredTool = analyzeToolCall("owned_tool", { cwd: "/tmp/child" }, {
		observer: registeredObserver,
		context: { cwd: "/tmp/workspace" },
	});
	assert(
		registeredTool.known && registeredTool.risk === "safe_read",
		"registered tool analysis should be authoritative",
	);
	assert(
		registeredTool.effects.includes("run_command"),
		"registered tool should disclose its effects",
	);
	assert(
		registeredTool.reason === "tool-owned analysis",
		"registered tool should preserve its owner-provided reason",
	);
	const registeredPaths = extractToolPaths({ cwd: "/tmp/child" }, registeredTool.pathInputs);
	assert(
		registeredPaths.length === 1 && registeredPaths[0]?.operation === "list",
		"registered tool path descriptors should drive extraction",
	);
	const builtinRead = analyzeToolCall("read", { path: "/tmp/child" }, {
		observer: {
			analyze: () => ({
				toolName: "read",
				effects: ["write_files"],
				risk: "dangerous",
				pathInputs: [],
				known: true,
				reason: "conflicting custom analyzer",
			}),
		},
		context: { cwd: "/tmp/workspace" },
	});
	assert(
		builtinRead.risk === "safe_read" && builtinRead.effects.includes("read_files"),
		"registered analyzers should not override native Safety tool ownership",
	);
	const nestedPaths = extractToolPaths(
		{
			commissions: [
				{ task: "Inspect one", cwd: "/tmp/one" },
				{ task: "Inspect two", cwd: "/tmp/two" },
			],
		},
		[{ field: "commissions[].cwd", operation: "read" }],
	);
	assert(
		nestedPaths.length === 2 &&
			nestedPaths[0]?.path === "/tmp/one" &&
			nestedPaths[1]?.path === "/tmp/two",
		"nested child cwd descriptors should preserve every commission path",
	);

	const patchTool = analyzeExtensionTool("apply_patch");
	const paths = extractToolPaths(
		{ operations: [{ path: "src/a.ts" }, { move_path: "src/b.ts" }] },
		patchTool.pathInputs,
	);
	assert(
		paths.length === 2,
		"apply_patch extractor should find operation paths",
	);

	const editTool = analyzeToolCall("edit");
	const editPaths = extractToolPaths({ path: "src/a.ts" }, editTool.pathInputs);
	assert(
		editPaths.length === 1 && editPaths[0]?.operation === "write",
		"edit path should be a write operation",
	);

	const writeTool = analyzeToolCall("write");
	const writePaths = extractToolPaths(
		{ path: "src/b.ts" },
		writeTool.pathInputs,
	);
	assert(
		writePaths.length === 1 && writePaths[0]?.operation === "write",
		"write path should be a write operation",
	);
}
