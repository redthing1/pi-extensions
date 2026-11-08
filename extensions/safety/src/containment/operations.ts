import { createLocalBashOperations, type BashOperations } from "@earendil-works/pi-coding-agent";
import type { EffectiveSafetyPolicy } from "../config/types.js";
import { buildDarwinCommand } from "./darwin.js";
import { buildLinuxCommand } from "./linux.js";
import { containmentSupport } from "./support.js";

export function createContainedBashOperations(policy: EffectiveSafetyPolicy, shellPath?: string): BashOperations | undefined {
	const support = containmentSupport(policy);
	if (!support.available || !support.backend) return undefined;
	const local = createLocalBashOperations({ shellPath });
	return {
		async exec(command, cwd, options) {
			const contained =
				support.backend === "darwin-seatbelt"
					? buildDarwinCommand(command, policy, shellPath)
					: buildLinuxCommand(command, policy, cwd, shellPath);
			try {
				return await local.exec(contained.command, cwd, options);
			} finally {
				contained.cleanup?.();
			}
		},
	};
}
