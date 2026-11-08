import { existsSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";

export function findWorkspaceRoot(cwd: string): string {
	let current = realpathOrResolve(cwd);
	for (;;) {
		if (existsSync(join(current, ".git"))) return current;
		const parent = dirname(current);
		if (parent === current) return realpathOrResolve(cwd);
		current = parent;
	}
}

export function workspaceHash(workspaceRoot: string): string {
	return createHash("sha256").update(realpathOrResolve(workspaceRoot)).digest("hex").slice(0, 16);
}

export function realpathOrResolve(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

