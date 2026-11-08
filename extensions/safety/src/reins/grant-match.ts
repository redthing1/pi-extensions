import { isWithinOrEqual } from "../paths/normalize.js";
import type { PathAccess } from "../paths/types.js";
import { commandFamilyForSegment } from "../shell/command-families.js";
import { cwdAfterShellSegment, initialShellCwd } from "../shell/cwd.js";
import type { ShellAnalysis, ShellSegmentAnalysis } from "../shell/types.js";
import type { CommandGrant, PathGrant } from "./grant-types.js";

export function normalizePrefix(prefix: string[]): string[] {
	return prefix.map((word) => word.trim()).filter((word) => word.length > 0);
}

export function samePrefix(a: string[], b: string[]): boolean {
	return a.length === b.length && a.every((word, index) => word === b[index]);
}

export function matchesPrefix(words: string[], prefix: string[]): boolean {
	if (prefix.length === 0 || words.length < prefix.length) return false;
	for (let i = 0; i < prefix.length; i++) {
		if (words[i] !== prefix[i]) return false;
	}
	return true;
}

export function coversShellWithGrants<TGrant extends CommandGrant>(
	shell: ShellAnalysis,
	grants: readonly TGrant[],
	context: { cwd: string; workspaceRoot: string },
): TGrant[] | undefined {
	if (shell.risk === "dangerous" || shell.risk === "catastrophic") return undefined;
	const matched: TGrant[] = [];
	let cwd = initialShellCwd(context.cwd);

	for (const segment of shell.segments) {
		if (segment.separatorBefore === "||") cwd = initialShellCwd(context.cwd);
		if (segmentAllowedWithoutCommandGrant(segment)) {
			const nextCwd = cwdAfterShellSegment(segment, cwd);
			if (nextCwd) cwd = nextCwd;
			continue;
		}
		const grant = grants.find((candidate) => matchesCommandGrant(segment, candidate, cwd, context.workspaceRoot));
		if (!grant) return undefined;
		matched.push(grant);
		const nextCwd = cwdAfterShellSegment(segment, cwd);
		if (nextCwd) cwd = nextCwd;
	}
	return matched;
}

export function segmentAllowedWithoutCommandGrant(segment: ShellSegmentAnalysis): boolean {
	return (
		(segment.risk === "safe" || segment.risk === "safe_read" || segment.risk === "mutating") &&
		!segment.effects.includes("network") &&
		!segment.effects.includes("external_state")
	);
}

export function coversPathsWithGrants<TGrant extends PathGrant>(
	paths: readonly PathAccess[],
	grants: readonly TGrant[],
): TGrant[] | undefined {
	const blocked = paths.filter((path) => !path.allowed);
	if (blocked.length === 0) return [];
	const matched: TGrant[] = [];
	for (const path of blocked) {
		const grant = grants.find((candidate) => matchesPathGrant(path, candidate));
		if (!grant) return undefined;
		matched.push(grant);
	}
	return matched;
}

export function matchesCommandGrant(
	segment: ShellSegmentAnalysis,
	grant: CommandGrant,
	cwd: string,
	workspaceRoot: string,
): boolean {
	if (grant.type === "commandPrefix") return matchesPrefix(segment.words, grant.prefix);
	const family = commandFamilyForSegment(segment, cwd, workspaceRoot);
	return Boolean(family && family.family === grant.family && family.pathScope === grant.pathScope);
}

export function matchesPathGrant(path: PathAccess, grant: PathGrant): boolean {
	if (!grant.operations.includes(path.operation)) return false;
	if (grant.sensitivity === "privacy" && path.protectedKind !== "privacy") return false;
	if (grant.sensitivity === "normal" && path.protectedKind) return false;
	return grant.roots.some((root) => isWithinOrEqual(path.absolutePath, root) || isWithinOrEqual(path.resolvedPath, root));
}
