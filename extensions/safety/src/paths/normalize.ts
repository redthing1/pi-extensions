import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";

export function expandHome(path: string, home = homedir()): string {
	if (path === "~") return home;
	if (path.startsWith("~/")) return resolve(home, path.slice(2).replace(/^\/+/, ""));
	if (path === "$HOME" || path === "${HOME}") return home;
	if (path.startsWith("$HOME/")) return resolve(home, path.slice("$HOME/".length).replace(/^\/+/, ""));
	if (path.startsWith("${HOME}/")) return resolve(home, path.slice("${HOME}/".length).replace(/^\/+/, ""));
	return path;
}

export function absolutePath(cwd: string, path: string, home?: string): string {
	const expanded = expandHome(path, home);
	return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

export function canonicalPath(path: string): string {
	const absolute = resolve(path);
	let ancestor = absolute;
	while (!existsSync(ancestor)) {
		const parent = dirname(ancestor);
		if (parent === ancestor) return absolute;
		ancestor = parent;
	}
	try {
		return resolve(realpathSync(ancestor), relative(ancestor, absolute));
	} catch {
		return absolute;
	}
}

export function isWithinOrEqual(child: string, parent: string): boolean {
	const resolvedChild = resolve(child);
	const resolvedParent = resolve(parent);
	return resolvedChild === resolvedParent || resolvedChild.startsWith(`${resolvedParent}/`);
}

export function existingDirectoryOrFile(path: string): boolean {
	try {
		statSync(path);
		return true;
	} catch {
		return false;
	}
}
