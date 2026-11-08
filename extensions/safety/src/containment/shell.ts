import { existsSync } from "node:fs";
import { delimiter } from "node:path";

export const SAFE_PATH = [
	"/opt/homebrew/bin",
	"/usr/local/bin",
	"/usr/bin",
	"/bin",
	"/usr/sbin",
	"/sbin",
].filter((path) => existsSync(path)).join(delimiter);

export function quoteShellArg(value: string): string {
	if (value.length === 0) return "''";
	return `'${value.replace(/'/g, "'\\''")}'`;
}

export function commandExists(path: string): boolean {
	return existsSync(path);
}

