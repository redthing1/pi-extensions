import type { EffectiveSafetyPolicy } from "../config/types.js";
import type { PathAccess, PathOperation } from "./types.js";
import { absolutePath, canonicalPath, isWithinOrEqual } from "./normalize.js";
import { matchProtectedPath } from "./protected.js";

export function classifyPathAccess(policy: EffectiveSafetyPolicy, operation: PathOperation, path: string): PathAccess {
	const absolute = absolutePath(policy.workspaceCwd, path, policy.workspaceHome);
	const resolved = canonicalPath(absolute);
	const resolvedRoots = configuredPathRoots(policy, operation).map((root) => canonicalPath(absolutePath(policy.workspaceRoot, root, policy.workspaceHome)));
	return classifyResolvedPathAccess(policy, operation, path, absolute, resolved, resolvedRoots);
}

export function classifyResolvedPathAccess(
	policy: EffectiveSafetyPolicy,
	operation: PathOperation,
	path: string,
	absolute: string,
	resolved: string,
	resolvedRoots: string[],
): PathAccess {
	const workspaceRoot = policy.workspaceKind === "provided" ? absolutePath("/", policy.workspaceRoot, policy.workspaceHome) : canonicalPath(policy.workspaceRoot);
	const scope = isWithinOrEqual(resolved, workspaceRoot) ? "workspace" : "outside-workspace";
	const insideByResolvedPath = resolvedRoots.some((root) => isWithinOrEqual(resolved, root));
	const insideByAbsolutePath = resolvedRoots.some((root) => isWithinOrEqual(absolute, root));
	const protectedMatch = matchProtectedPath(policy.workspaceRoot, absolute, policy.protectedPaths, resolved, policy.workspaceHome);

	if (protectedMatch.protected) {
		return {
			operation,
			path,
			absolutePath: absolute,
			resolvedPath: resolved,
			scope,
			protected: true,
			protectedKind: protectedMatch.kind,
			allowed: false,
			reason: "protected-path",
			matchedPattern: protectedMatch.pattern,
		};
	}

	if (safeVirtualPath(operation, absolute, resolved)) {
		return {
			operation,
			path,
			absolutePath: absolute,
			resolvedPath: resolved,
			scope,
			protected: false,
			allowed: true,
			reason: "allowed",
		};
	}

	if (!insideByResolvedPath) {
		return {
			operation,
			path,
			absolutePath: absolute,
			resolvedPath: resolved,
			scope,
			protected: false,
			allowed: false,
			reason: insideByAbsolutePath ? "symlink-escapes-root" : operation === "write" ? "outside-write-roots" : "outside-read-roots",
		};
	}

	return {
		operation,
		path,
		absolutePath: absolute,
		resolvedPath: resolved,
		scope,
		protected: false,
		allowed: true,
		reason: "allowed",
	};
}

export function configuredPathRoots(policy: EffectiveSafetyPolicy, operation: PathOperation): string[] {
	if (operation === "write") return policy.containment.filesystem.write;
	return Array.from(new Set([...policy.containment.filesystem.read, ...policy.containment.filesystem.write]));
}

function safeVirtualPath(operation: PathOperation, absolutePath: string, resolvedPath: string): boolean {
	return (
		SAFE_VIRTUAL_PATHS.has(absolutePath) ||
		SAFE_VIRTUAL_PATHS.has(resolvedPath) ||
		(operation === "read" && (SAFE_VIRTUAL_READ_PATHS.has(absolutePath) || SAFE_VIRTUAL_READ_PATHS.has(resolvedPath)))
	);
}

const SAFE_VIRTUAL_PATHS = new Set([
	"/dev/null",
	"/dev/stdin",
	"/dev/stdout",
	"/dev/stderr",
	"/dev/fd/0",
	"/dev/fd/1",
	"/dev/fd/2",
	"/proc/self/fd/0",
	"/proc/self/fd/1",
	"/proc/self/fd/2",
]);

const SAFE_VIRTUAL_READ_PATHS = new Set(["/dev/zero", "/dev/random", "/dev/urandom"]);
