import type {
	BashLaunchEvent,
	ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import type { EffectiveSafetyPolicy } from "../config/types.js";
import {
	classifyPathAccess,
	classifyResolvedPathAccess,
	configuredPathRoots,
} from "../paths/classify.js";
import { absolutePath } from "../paths/normalize.js";
import type { PathAccess } from "../paths/types.js";
import { analyzeShellCommand } from "../shell/classify.js";
import { extractShellPathReferences } from "../shell/paths.js";
import type { SafetyEffect, SafetyRisk } from "../shell/types.js";
import { analyzeToolCall } from "../tools/catalog.js";
import { extractToolPaths } from "../tools/extract-paths.js";
import type { SafetyRequest } from "./types.js";
import type { WorkspacePathOperations } from "../../../shared/active-workspace.ts";
import type { ToolEffectObserver } from "../../../shared/tool-effects.ts";

export function requestFromToolCall(
	event: ToolCallEvent,
	cwd: string,
	policy: EffectiveSafetyPolicy,
	toolEffects?: ToolEffectObserver,
): SafetyRequest {
	const tool = analyzeToolCall(event.toolName, event.input, toolEffects ? {
		observer: toolEffects,
		context: { cwd, workspace: workspaceIdentity(policy) },
	} : undefined);
	if (event.toolName === "bash") {
		const command =
			typeof event.input.command === "string" ? event.input.command : "";
		const shell = analyzeShellCommand(command, { cwd, home: policy.workspaceHome });
		const paths = extractShellPathReferences(shell, cwd).map((path) =>
			classifyPathAccess(policy, path.operation, path.path),
		);
		return toolCallRequest(event, cwd, policy, paths, tool, shell);
	}

	const paths = extractToolPaths(event.input, tool.pathInputs).map((path) =>
		classifyPathAccess(policy, path.operation, path.path),
	);
	paths.push(
		...(tool.pathReferences ?? []).map((path) =>
			classifyPathAccess(policy, path.operation, path.path),
		),
	);
	return toolCallRequest(event, cwd, policy, paths, tool);
}

export function requestFromBashLaunch(
	event: BashLaunchEvent,
	policy: EffectiveSafetyPolicy,
	cwd = event.cwd,
): SafetyRequest {
	const shell = analyzeShellCommand(event.command, event);
	const paths = extractShellPathReferences(shell, cwd).map((path) =>
		classifyPathAccess(policy, path.operation, path.path),
	);
	return bashLaunchRequest(event, cwd, policy, paths, shell);
}

export async function requestFromToolCallWithWorkspace(
	event: ToolCallEvent,
	cwd: string,
	policy: EffectiveSafetyPolicy,
	pathOperations: WorkspacePathOperations,
	toolEffects?: ToolEffectObserver,
): Promise<SafetyRequest> {
	const tool = analyzeToolCall(event.toolName, event.input, toolEffects ? {
		observer: toolEffects,
		context: { cwd, workspace: workspaceIdentity(policy) },
	} : undefined);
	const shell =
		event.toolName === "bash"
			? analyzeShellCommand(
					typeof event.input.command === "string" ? event.input.command : "",
					{ cwd, home: policy.workspaceHome },
				)
			: undefined;
	const references = shell
		? extractShellPathReferences(shell, cwd)
		: [...extractToolPaths(event.input, tool.pathInputs), ...(tool.pathReferences ?? [])];
	const paths = await classifyWorkspacePaths(references, policy, pathOperations);
	return toolCallRequest(event, cwd, policy, paths, tool, shell);
}

function workspaceIdentity(policy: EffectiveSafetyPolicy) {
	return {
		label: policy.workspaceKind,
		cwd: policy.workspaceCwd,
		root: policy.workspaceRoot,
		...(policy.workspaceHome ? { home: policy.workspaceHome } : {}),
	};
}

export async function requestFromBashLaunchWithWorkspace(
	event: BashLaunchEvent,
	policy: EffectiveSafetyPolicy,
	cwd: string,
	pathOperations: WorkspacePathOperations,
): Promise<SafetyRequest> {
	const shell = analyzeShellCommand(event.command, event);
	const references = extractShellPathReferences(shell, cwd);
	const paths = await classifyWorkspacePaths(references, policy, pathOperations);
	return bashLaunchRequest(event, cwd, policy, paths, shell);
}

function toolCallRequest(
	event: ToolCallEvent,
	cwd: string,
	policy: EffectiveSafetyPolicy,
	paths: PathAccess[],
	tool: ReturnType<typeof analyzeToolCall>,
	shell?: ReturnType<typeof analyzeShellCommand>,
): SafetyRequest {
	const command =
		"command" in event.input && typeof event.input.command === "string"
			? event.input.command
			: undefined;
	return {
		id: event.toolCallId,
		source: "model_tool",
		cwd,
		workspaceRoot: policy.workspaceRoot,
		toolName: event.toolName,
		command,
		effects: shell?.effects ?? tool.effects,
		risk: shell?.risk ?? effectiveToolRisk(tool.risk, paths),
		paths,
		summary: shell
			? (command ?? "")
			: (tool.summary ?? `${event.toolName} tool`),
		reason: shell?.reason ?? tool.reason,
		shell,
	};
}

function bashLaunchRequest(
	event: BashLaunchEvent,
	cwd: string,
	policy: EffectiveSafetyPolicy,
	paths: PathAccess[],
	shell: ReturnType<typeof analyzeShellCommand>,
): SafetyRequest {
	return {
		id: event.id ?? `bash-launch-${Date.now()}`,
		source: event.source === "tool" ? "model_tool" : "user_bash",
		cwd,
		workspaceRoot: policy.workspaceRoot,
		command: event.command,
		effects: shell.effects,
		risk: shell.risk,
		paths,
		summary: event.submittedCommand,
		reason: shell.reason,
		shell,
	};
}

async function classifyWorkspacePaths(
	references: Array<{ operation: PathAccess["operation"]; path: string }>,
	policy: EffectiveSafetyPolicy,
	pathOperations: WorkspacePathOperations,
): Promise<PathAccess[]> {
	const roots = new Map<PathAccess["operation"], Promise<string[]>>();
	const resolvedRoots = (operation: PathAccess["operation"]) => {
		let pending = roots.get(operation);
		if (!pending) {
			pending = Promise.all(
				configuredPathRoots(policy, operation).map((root) =>
					pathOperations.canonicalize(
						absolutePath(policy.workspaceRoot, root, policy.workspaceHome),
					),
				),
			);
			roots.set(operation, pending);
		}
		return pending;
	};
	return Promise.all(
		references.map(async (path) => {
			const absolute = absolutePath(
				policy.workspaceCwd,
				path.path,
				policy.workspaceHome,
			);
			return classifyResolvedPathAccess(
				policy,
				path.operation,
				path.path,
				absolute,
				await pathOperations.canonicalize(absolute),
				await resolvedRoots(path.operation),
			);
		}),
	);
}

function effectiveToolRisk(risk: SafetyRisk, paths: PathAccess[]): SafetyRisk {
	const blocked = paths.filter((path) => !path.allowed);
	if (blocked.length === 0) return risk;
	if (
		blocked.every(
			(path) => !path.protectedKind || path.protectedKind === "privacy",
		)
	)
		return risk;
	return "dangerous";
}

export function mergeEffects(effects: SafetyEffect[]): SafetyEffect[] {
	return Array.from(new Set(effects));
}
