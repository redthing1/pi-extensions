import { buildDarwinCommand } from "../../src/containment/darwin.js";
import { buildLinuxCommand } from "../../src/containment/linux.js";
import type { ContainmentBackend } from "../../src/containment/types.js";
import type { EffectiveSafetyPolicy } from "../../src/config/types.js";
import { runCommand, type CommandResult } from "../util/process.js";

export async function runContainedCommand(
	command: string,
	cwd: string,
	policy: EffectiveSafetyPolicy,
	backend: ContainmentBackend,
): Promise<CommandResult> {
	const contained =
		backend === "darwin-seatbelt" ? buildDarwinCommand(command, policy) : buildLinuxCommand(command, policy, cwd);
	try {
		return await runCommand("/bin/bash", ["-lc", contained.command], cwd);
	} finally {
		contained.cleanup?.();
	}
}
