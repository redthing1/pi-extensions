import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { EffectiveSafetyPolicy } from "../config/types.js";
import { PRIVACY_PROTECTED_PATHS } from "../config/protected-paths.js";
import { absolutePath, canonicalPath } from "../paths/normalize.js";
import { darwinDeveloperReadRoots } from "./darwin-developer.js";

const DARWIN_SYSTEM_READ_ROOTS = [
	"/bin",
	"/sbin",
	"/usr",
	"/System",
	"/Library",
	"/opt/homebrew",
	"/usr/local",
	"/etc",
	"/private/var/run/resolv.conf",
	"/dev",
];
const LINUX_SYSTEM_READ_ROOTS = ["/bin", "/sbin", "/usr", "/lib", "/lib64", "/etc"];

export function readRootsForPolicy(policy: EffectiveSafetyPolicy, platform: NodeJS.Platform): string[] {
	const configured = uniqueRealPaths(
		[
			...policy.containment.filesystem.read,
			...policy.containment.filesystem.write,
		]
			.map((path) => absolutePath(policy.workspaceRoot, path))
			.filter((path) => existsSync(path)),
	);
	const system =
		platform === "darwin" ? [...DARWIN_SYSTEM_READ_ROOTS, ...darwinDeveloperReadRoots()] : LINUX_SYSTEM_READ_ROOTS;
	return uniqueRealPaths([...system.filter((path) => existsSync(path)), ...configured]);
}

export function writeRootsForPolicy(policy: EffectiveSafetyPolicy): string[] {
	if (policy.containment.mode === "read-only") return [];
	return uniqueRealPaths(
		policy.containment.filesystem.write
			.map((path) => absolutePath(policy.workspaceRoot, path))
			.filter((path) => existsSync(path)),
	);
}

export function protectedPathsForPolicy(policy: EffectiveSafetyPolicy): string[] {
	return uniqueRealPaths(
		policy.protectedPaths
			.filter((path) => !PRIVACY_PROTECTED_PATHS.includes(path))
			.map(containmentProtectedPath)
			.filter((path): path is string => Boolean(path))
			.map((path) => absolutePath(policy.workspaceRoot, path))
			.filter((path) => existsSync(path)),
	);
}

export function uniqueRealPaths(paths: string[]): string[] {
	const values = paths.flatMap((path) => {
		const absolute = resolve(path);
		const real = canonicalPath(absolute);
		return aliasesForPath(real === absolute ? [absolute] : [absolute, real]);
	});
	return Array.from(new Set(values));
}

function aliasesForPath(paths: string[]): string[] {
	const values = [...paths];
	for (const path of paths) {
		pushAlias(values, path, /^\/private\/var(?=\/|$)/, "/var");
		pushAlias(values, path, /^\/private\/tmp(?=\/|$)/, "/tmp");
		pushAlias(values, path, /^\/private\/etc(?=\/|$)/, "/etc");
		pushAlias(values, path, /^\/var(?=\/|$)/, "/private/var");
		pushAlias(values, path, /^\/tmp(?=\/|$)/, "/private/tmp");
		pushAlias(values, path, /^\/etc(?=\/|$)/, "/private/etc");
	}
	return values;
}

function pushAlias(values: string[], path: string, pattern: RegExp, replacement: string): void {
	const alias = path.replace(pattern, replacement);
	if (alias !== path && existsSync(alias)) values.push(alias);
}

export function realpathExisting(path: string): string | undefined {
	try {
		return realpathSync(path);
	} catch {
		return undefined;
	}
}

function containmentProtectedPath(pattern: string): string | undefined {
	if (!pattern.includes("*")) return pattern;
	if (pattern.endsWith("/**")) return pattern.slice(0, -"/**".length);
	return undefined;
}
