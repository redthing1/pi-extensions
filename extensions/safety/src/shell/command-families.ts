import { absolutePath, canonicalPath, isWithinOrEqual } from "../paths/normalize.js";
import { valueAfterEquals } from "./args.js";
import type { ShellSegmentAnalysis } from "./types.js";

export type CommandFamilyName = "cmake.build" | "cmake.configure";
export type CommandFamilyPathScope = "workspace";

export interface CommandFamilyAnalysis {
	family: CommandFamilyName;
	pathScope: CommandFamilyPathScope;
	description: string;
}

const CMAKE_SCRIPT_OR_TOOL_MODES = new Set(["-E", "-P", "--install", "--open", "--find-package"]);

export function commandFamilyForSegment(
	segment: ShellSegmentAnalysis,
	cwd: string,
	workspaceRoot: string,
): CommandFamilyAnalysis | undefined {
	if (segment.program !== "cmake") return undefined;
	return cmakeFamily(segment.words.slice(1), cwd, workspaceRoot);
}

export function commandFamilyDescription(family: CommandFamilyName, pathScope: CommandFamilyPathScope): string {
	if (pathScope !== "workspace") return family;
	switch (family) {
		case "cmake.build":
			return "cmake --build <workspace path> *";
		case "cmake.configure":
			return "cmake configure with workspace source/build dirs";
	}
}

function cmakeFamily(args: string[], cwd: string, workspaceRoot: string): CommandFamilyAnalysis | undefined {
	const buildDir = cmakeBuildDir(args);
	if (buildDir) {
		if (!isWorkspaceScopedPath(cwd, workspaceRoot, buildDir)) return undefined;
		return {
			family: "cmake.build",
			pathScope: "workspace",
			description: commandFamilyDescription("cmake.build", "workspace"),
		};
	}

	const configure = cmakeConfigureDirs(args);
	if (!configure) return undefined;
	if (!isWorkspaceScopedPath(cwd, workspaceRoot, configure.sourceDir)) return undefined;
	if (!isWorkspaceScopedPath(cwd, workspaceRoot, configure.buildDir)) return undefined;
	return {
		family: "cmake.configure",
		pathScope: "workspace",
		description: commandFamilyDescription("cmake.configure", "workspace"),
	};
}

function cmakeBuildDir(args: string[]): string | undefined {
	if (cmakeBuildTargets(args).some(isInstallTarget)) return undefined;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--build") return args[i + 1];
		if (arg.startsWith("--build=")) return valueAfterEquals(arg);
	}
	return undefined;
}

function cmakeBuildTargets(args: string[]): string[] {
	const targets: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--target" || arg === "-t") {
			const target = args[++i];
			if (target) targets.push(target);
			continue;
		}
		if (arg.startsWith("--target=")) {
			const target = valueAfterEquals(arg);
			if (target) targets.push(target);
		}
	}
	return targets;
}

function cmakeConfigureDirs(args: string[]): { sourceDir: string; buildDir: string } | undefined {
	if (args.some(isCmakeScriptOrToolMode)) return undefined;

	let sourceDir: string | undefined;
	let buildDir: string | undefined;
	let optionsDone = false;

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (!optionsDone && arg === "--") {
			optionsDone = true;
			continue;
		}
		if (!optionsDone && arg === "-S") {
			sourceDir = args[++i];
			continue;
		}
		if (!optionsDone && arg === "-B") {
			buildDir = args[++i];
			continue;
		}
		if (!optionsDone && arg.startsWith("-S") && arg.length > 2) {
			sourceDir = arg.slice(2);
			continue;
		}
		if (!optionsDone && arg.startsWith("-B") && arg.length > 2) {
			buildDir = arg.slice(2);
			continue;
		}
		if (!optionsDone && arg.startsWith("-")) continue;
		if (!sourceDir) sourceDir = arg;
	}

	if (!buildDir) return undefined;
	return { sourceDir: sourceDir ?? ".", buildDir };
}

function isCmakeScriptOrToolMode(arg: string): boolean {
	return CMAKE_SCRIPT_OR_TOOL_MODES.has(arg) || arg.startsWith("--install=");
}

function isInstallTarget(target: string): boolean {
	return target === "install" || target.startsWith("install/");
}

function isWorkspaceScopedPath(cwd: string, workspaceRoot: string, path: string | undefined): boolean {
	if (!path || !isPlainPathArgument(path)) return false;
	const absolute = absolutePath(cwd, path);
	const resolved = canonicalPath(absolute);
	const root = canonicalPath(workspaceRoot);
	return isWithinOrEqual(absolute, root) && isWithinOrEqual(resolved, root);
}

function isPlainPathArgument(path: string): boolean {
	if (path.length === 0 || path.startsWith("-") || path.includes("\0")) return false;
	return !path.includes("*") && !path.includes("?") && !path.includes("[");
}
