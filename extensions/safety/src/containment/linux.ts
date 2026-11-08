import { statSync } from "node:fs";
import type { EffectiveSafetyPolicy } from "../config/types.js";
import { protectedPathsForPolicy, readRootsForPolicy, writeRootsForPolicy } from "./filesystem.js";
import { isWithinOrEqual } from "../paths/normalize.js";
import { backendExecutable } from "./support.js";
import { quoteShellArg, SAFE_PATH } from "./shell.js";
import type { ContainedCommand } from "./types.js";

export function buildLinuxCommand(
	command: string,
	policy: EffectiveSafetyPolicy,
	cwd = policy.workspaceRoot,
	shellPath = "/bin/bash",
): ContainedCommand {
	const runtimeRoot = "/tmp/pi-safety";
	const runtimeHome = `${runtimeRoot}/home`;
	const runtimeTmp = `${runtimeRoot}/tmp`;
	const writeRoots = writeRootsForPolicy(policy);
	const protectedPaths = protectedPathsForPolicy(policy);
	const readRoots = readRootsForPolicy(policy, "linux").filter(
		(root) => !writeRoots.some((writeRoot) => isWithinOrEqual(root, writeRoot)),
	);
	const argv = [
		backendExecutable("linux-bwrap"),
		"--die-with-parent",
		...(policy.containment.network === "none" ? ["--unshare-net"] : []),
		"--proc",
		"/proc",
		"--dev",
		"/dev",
		"--tmpfs",
		"/tmp",
		"--dir",
		runtimeRoot,
		"--dir",
		runtimeHome,
		"--dir",
		runtimeTmp,
		"--setenv",
		"PATH",
		SAFE_PATH,
		"--setenv",
		"HOME",
		runtimeHome,
		"--setenv",
		"TMPDIR",
		runtimeTmp,
		"--chdir",
		cwd,
		...readRoots.flatMap((root) => ["--ro-bind", root, root]),
		...writeRoots.flatMap((root) => ["--bind", root, root]),
		...protectedPaths.flatMap(protectedMaskArgs),
		shellPath,
		"-c",
		command,
	];
	return {
		command: argv.map(quoteShellArg).join(" "),
	};
}

function protectedMaskArgs(path: string): string[] {
	return isDirectory(path) ? ["--tmpfs", path] : ["--ro-bind", "/dev/null", path];
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}
