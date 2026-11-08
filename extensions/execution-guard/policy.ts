import type { BashLaunchEvent } from "@earendil-works/pi-coding-agent";
import { catastrophicViolation } from "./catastrophic.ts";
import { recklessViolation } from "./reckless.ts";

export interface GuardContext extends Pick<BashLaunchEvent, "cwd" | "home" | "pathStyle"> {
	shell?: "bash" | "powershell";
	protectedPaths?: readonly string[];
}

export interface GuardViolation {
	category: "catastrophic" | "reckless";
	rule: "catastrophic-shell" | "root-traversal";
	reason: string;
}

export function inspectCommand(command: string, context: GuardContext): GuardViolation | undefined {
	return catastrophicViolation(command, context) ?? recklessViolation(command, context);
}

export function blockReason(violation: GuardViolation): string {
	return `Execution guard blocked ${violation.category} command [${violation.rule}]: ${violation.reason}. Use a non-destructive or narrowly scoped alternative.`;
}
