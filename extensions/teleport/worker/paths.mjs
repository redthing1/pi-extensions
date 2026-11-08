import { constants } from "node:fs";
import { access, lstat, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";

export function createPathResolver(cwd) {
	function resolveRemotePath(value) {
		if (typeof value !== "string" || value.includes("\0")) throw new Error("invalid remote path");
		if (value === "~") return homedir();
		if (value.startsWith("~/")) return join(homedir(), value.slice(2));
		return isAbsolute(value) ? resolve(value) : resolve(cwd, value);
	}
	return resolveRemotePath;
}

export function resolveStartupPath(value) {
	if (value === "~") return homedir();
	if (value.startsWith("~/")) return join(homedir(), value.slice(2));
	return isAbsolute(value) ? resolve(value) : resolve(process.cwd(), value);
}

export async function firstExecutable(candidates) {
	for (const candidate of candidates) {
		if (typeof candidate !== "string") continue;
		const paths = candidate.includes("/")
			? [candidate]
			: (process.env.PATH ?? "").split(delimiter).map((directory) => resolve(directory, candidate));
		for (const path of paths) {
			try {
				await access(path, constants.X_OK);
				if ((await stat(path)).isFile()) return path;
			} catch {
				// Continue through PATH, then the explicit fallbacks.
			}
		}
	}
	return undefined;
}

export async function findGitRoot(start) {
	let current = start;
	for (;;) {
		try {
			await lstat(join(current, ".git"));
			return current;
		} catch (error) {
			if (error?.code !== "ENOENT") throw error;
		}
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}
