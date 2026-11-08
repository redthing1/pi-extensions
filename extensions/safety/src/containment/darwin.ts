import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { EffectiveSafetyPolicy } from "../config/types.js";
import { darwinDeveloperCacheAccess, darwinDeveloperEnvironment } from "./darwin-developer.js";
import { protectedPathsForPolicy, readRootsForPolicy, writeRootsForPolicy } from "./filesystem.js";
import { backendExecutable } from "./support.js";
import { quoteShellArg, SAFE_PATH } from "./shell.js";
import type { ContainedCommand } from "./types.js";

export function buildDarwinCommand(
	command: string,
	policy: EffectiveSafetyPolicy,
	shellPath = "/bin/bash",
): ContainedCommand {
	const tempDir = mkdtempSync(join(tmpdir(), "pi-safety-"));
	const runtimeTmp = join(tempDir, "tmp");
	mkdirSync(runtimeTmp, { recursive: true });
	const realRuntimeTmp = realpathSync(runtimeTmp);
	const profilePath = join(tempDir, "profile.sb");
	writeFileSync(profilePath, buildProfile(policy, realRuntimeTmp), "utf-8");

	const argv = [
		"env",
		"-i",
		`PATH=${SAFE_PATH}`,
		`HOME=${realRuntimeTmp}`,
		`TMPDIR=${realRuntimeTmp}`,
		`TERM=${process.env.TERM ?? "xterm-256color"}`,
		...darwinDeveloperEnvironment(),
		backendExecutable("darwin-seatbelt"),
		"-f",
		profilePath,
		shellPath,
		"-c",
		command,
	];

	return {
		command: argv.map(quoteShellArg).join(" "),
		cleanup: () => rmSync(tempDir, { recursive: true, force: true }),
	};
}

function buildProfile(policy: EffectiveSafetyPolicy, runtimeTmp: string): string {
	const readRoots = readRootsForPolicy(policy, "darwin");
	const writeRoots = writeRootsForPolicy(policy);
	const protectedPaths = protectedPathsForPolicy(policy);
	const readableRoots = [...readRoots, ...writeRoots, runtimeTmp];
	const developerCache = darwinDeveloperCacheAccess();
	const readFilter = requireAny([
		'(literal "/")',
		...readableRoots.flatMap(readRootFilters),
		...developerCache.directories.flatMap(readDirectoryFilters),
		...developerCache.fileRegexes.map(regex),
	]);
	const writeFilter = requireAny([
		...writeRoots.map(subpath),
		subpath(runtimeTmp),
		...developerCache.directories.map(literal),
		...developerCache.fileRegexes.map(regex),
	]);
	const protectedFilter = requireAny(protectedPaths.flatMap(protectedPathFilters));
	const networkRule = policy.containment.network === "host" ? "(allow network*)" : "(deny network*)";
	return `${[
		"(version 1)",
		"(deny default)",
		"(allow process*)",
		"(allow signal (target same-sandbox))",
		"(allow sysctl-read)",
		"(allow mach-lookup)",
		`(allow file-read* ${readFilter})`,
		`(allow file-write* ${writeFilter})`,
		'(allow file-write* (literal "/dev/null"))',
		protectedPaths.length > 0 ? `(deny file-read* ${protectedFilter})` : undefined,
		protectedPaths.length > 0 ? `(deny file-write* ${protectedFilter})` : undefined,
		networkRule,
	]
		.filter((line): line is string => Boolean(line))
		.join("\n")}\n`;
}

function subpath(path: string): string {
	return `(subpath ${JSON.stringify(path)})`;
}

function literal(path: string): string {
	return `(literal ${JSON.stringify(path)})`;
}

function regex(pattern: string): string {
	return `(regex ${JSON.stringify(pattern)})`;
}

function readRootFilters(path: string): string[] {
	return [...ancestorLiterals(path), literal(path), subpath(path)];
}

function readDirectoryFilters(path: string): string[] {
	return [...ancestorLiterals(path), literal(path)];
}

function protectedPathFilters(path: string): string[] {
	return [literal(path), subpath(path)];
}

function ancestorLiterals(path: string): string[] {
	const values: string[] = [];
	let current = resolve(path);
	for (;;) {
		const parent = dirname(current);
		if (parent === current || parent === "/") break;
		values.push(literal(parent));
		current = parent;
	}
	return values;
}

function requireAny(parts: string[]): string {
	if (parts.length === 0) return "(require-any)";
	if (parts.length === 1) return parts[0];
	return `(require-any ${parts.join(" ")})`;
}
