import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import type { BashLaunchEvent, BashLaunchEventResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { observeActiveWorkspace } from "../shared/active-workspace.ts";
import { publishChildPolicyContributor } from "../shared/child-runtime.ts";
import { blockReason, inspectCommand, type GuardContext } from "./policy.ts";
import { inspectTraversal } from "./reckless.ts";

const PROTECTED_PATHS_ENV = "PI_EXECUTION_GUARD_PROTECTED_PATHS";

export function blockExecutionLaunch(
	event: Pick<BashLaunchEvent, "command" | "cwd" | "home" | "pathStyle"> & { shell?: BashLaunchEvent["shell"] },
	protectedPaths: readonly string[] = [],
): Extract<BashLaunchEventResult, { block: true }> | undefined {
	const violation = inspectCommand(event.command, { ...event, protectedPaths });
	return violation ? { block: true, reason: blockReason(violation) } : undefined;
}

export default function executionGuard(pi: ExtensionAPI): void {
	const inherited = readProtectedPaths();
	const workspaces = observeActiveWorkspace(pi);
	pi.on("bash_launch", (event) => blockExecutionLaunch(event, inherited));
	pi.on("tool_call", (event, ctx) => {
		if (event.toolName !== "find" && event.toolName !== "grep") return;
		const access = workspaces.current();
		if (access.kind === "unavailable") return { block: true, reason: "Execution guard: workspace is unavailable" };
		const identity = access.kind === "ready" ? access.workspace.identity : undefined;
		const context: GuardContext = {
			cwd: identity?.cwd ?? ctx.cwd,
			home: identity?.home ?? homedir(),
			pathStyle: identity ? "posix" : process.platform === "win32" ? "win32" : "posix",
		};
		const path = typeof event.input.path === "string" ? event.input.path.replace(/^@/u, "") : ".";
		const violation = inspectTraversal([path], context);
		return violation ? { block: true, reason: blockReason(violation) } : undefined;
	});
	publishChildPolicyContributor(pi, {
		id: "execution-guard",
		async prepare(intent) {
			return {
				id: "execution-guard",
				args: ["--extension", fileURLToPath(import.meta.url)],
				env: {
					[PROTECTED_PATHS_ENV]: JSON.stringify([
						...inherited,
						...intent.references.map((reference) => reference.root),
					]),
				},
				metadata: { protectedReferences: inherited.length + intent.references.length },
				dispose: async () => undefined,
			};
		},
	});
}

function readProtectedPaths(): string[] {
	const encoded = process.env[PROTECTED_PATHS_ENV];
	delete process.env[PROTECTED_PATHS_ENV];
	if (!encoded) return [];
	const value: unknown = JSON.parse(encoded);
	if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string"))
		throw new Error("Invalid inherited execution guard paths");
	return value;
}
