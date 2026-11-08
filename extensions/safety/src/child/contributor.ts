import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ChildPolicyContributor,
	ChildRunIntent,
} from "../../../shared/child-runtime.ts";
import type { SafetyChildContext } from "./context.js";

export function createSafetyChildPolicyContributor(input: {
	extensionPath: string;
	contextFor(
		intent: ChildRunIntent,
	): SafetyChildContext | Promise<SafetyChildContext>;
}): ChildPolicyContributor {
	return {
		id: "safety",
		async prepare(intent) {
			const context = await input.contextFor(intent);
			const directory = await mkdtemp(join(tmpdir(), "pi-safety-child-"));
			const contextPath = join(directory, "context.json");
			try {
				await writeFile(contextPath, `${JSON.stringify(context)}\n`, {
					encoding: "utf-8",
					mode: 0o600,
				});
			} catch (error) {
				try {
					await rm(directory, { recursive: true, force: true });
				} catch (cleanupError) {
					throw new Error(
						`Safety child context creation failed: ${errorText(error)}\nSafety child context cleanup failed: ${errorText(cleanupError)}`,
						{ cause: error },
					);
				}
				throw error;
			}
			return {
				id: "safety",
				args: [
					"--extension",
					input.extensionPath,
					"--safety-context",
					contextPath,
				],
				metadata: {
					inherited: true,
					enabled: context.policy.enabled,
					profile: context.policy.profile,
				},
				dispose: async () => rm(directory, { recursive: true, force: true }),
			};
		},
	};
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
