import { analyzeShellCommand } from "../safety/src/shell/classify.ts";
import type { GuardContext, GuardViolation } from "./policy.ts";

export function catastrophicViolation(command: string, context: GuardContext): GuardViolation | undefined {
	const analysis = analyzeShellCommand(command, {
		...context,
		protectedPaths: [context.cwd, ...(context.protectedPaths ?? [])],
	});
	return analysis.risk === "catastrophic"
		? { category: "catastrophic", rule: "catastrophic-shell", reason: analysis.reason }
		: undefined;
}
