import { runManagedChild } from "../../shared/managed-child.ts";
import { appendChildEvent } from "./artifacts.ts";
import type { ChildExecutionResult, ChildExecutionUpdate, ChildLaunchRequest } from "./types.ts";

export type ChildProgressCallback = (update: ChildExecutionUpdate) => void;

export function runChild(
	request: ChildLaunchRequest,
	signal: AbortSignal,
	onProgress?: ChildProgressCallback,
): Promise<ChildExecutionResult> {
	const messages = new Map<string, string>();
	return runManagedChild(
		{
			intent: request.intent,
			contributions: request.contributions,
			workspaceChildren: request.workspaceChildren,
			systemPrompt: request.systemPrompt,
			prompt: `Task: ${request.commission.task}`,
			thinkingLevel: request.commission.thinkingLevel,
			skills: "none",
			onControl: request.onControl,
			onEvent: (line, event) => {
				appendChildEvent(request.artifacts, line);
				if (!event || typeof event !== "object") return;
				const value = event as Record<string, unknown>;
				const id = value.toolCallId;
				if (typeof id !== "string") return;
				if (value.type === "tool_execution_start" && value.toolName === "parent_message") {
					const args = value.args as { message?: unknown } | undefined;
					if (typeof args?.message === "string") messages.set(id, args.message);
				} else if (value.type === "tool_execution_end") {
					const message = messages.get(id);
					messages.delete(id);
					if (message && !value.isError) request.onMessage?.(message);
				}
			},
		},
		signal,
		onProgress,
	);
}
