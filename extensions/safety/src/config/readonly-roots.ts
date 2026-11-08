import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { SafetyConfig } from "./types.js";

export interface ReadonlyRootOptions {
	agentDir: string;
	cwd: string;
	workspaceRoot: string;
}

export function appendReadonlyRoots(config: SafetyConfig, roots: string[]): SafetyConfig {
	return {
		...config,
		containment: {
			...config.containment,
			filesystem: {
				read: uniqueStrings([...config.containment.filesystem.read, ...roots]),
				write: [...config.containment.filesystem.write],
			},
		},
	};
}

export function defaultReadonlyRoots(options: ReadonlyRootOptions): string[] {
	return uniqueStrings([
		join(options.agentDir, "skills"),
		join(homedir(), ".agents", "skills"),
		...ancestorAgentsSkillDirs(options.cwd, options.workspaceRoot),
	]);
}

function ancestorAgentsSkillDirs(cwd: string, workspaceRoot: string): string[] {
	const roots: string[] = [];
	let dir = resolve(cwd);
	const stop = resolve(workspaceRoot);

	for (;;) {
		roots.push(join(dir, ".agents", "skills"));
		if (dir === stop) break;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}

	return roots;
}

function uniqueStrings(values: string[]): string[] {
	return Array.from(new Set(values));
}
