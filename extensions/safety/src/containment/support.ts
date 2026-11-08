import { platform } from "node:os";
import { commandExists } from "./shell.js";
import type { ContainmentBackend, ContainmentSupport } from "./types.js";
import type { EffectiveSafetyPolicy } from "../config/types.js";

const DARWIN_SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const LINUX_BWRAP = "/usr/bin/bwrap";

export function containmentSupport(policy: EffectiveSafetyPolicy): ContainmentSupport {
	if (!policy.enabled || policy.containment.mode === "off") return { available: false, reason: "containment is off" };
	const backend = backendForPlatform();
	if (!backend) return { available: false, reason: `unsupported platform: ${platform()}` };
	if (backend === "darwin-seatbelt" && !commandExists(DARWIN_SANDBOX_EXEC)) {
		return { available: false, backend, reason: "sandbox-exec not found" };
	}
	if (backend === "linux-bwrap" && !commandExists(LINUX_BWRAP)) {
		return { available: false, backend, reason: "bubblewrap not found at /usr/bin/bwrap" };
	}
	return { available: true, backend };
}

export function backendForPlatform(): ContainmentBackend | undefined {
	const current = platform();
	if (current === "darwin") return "darwin-seatbelt";
	if (current === "linux") return "linux-bwrap";
	return undefined;
}

export function backendExecutable(backend: ContainmentBackend): string {
	switch (backend) {
		case "darwin-seatbelt":
			return DARWIN_SANDBOX_EXEC;
		case "linux-bwrap":
			return LINUX_BWRAP;
	}
}

