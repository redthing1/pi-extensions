import { commandFamilyForSegment } from "../shell/command-families.js";
import { cwdAfterShellSegment, initialShellCwd } from "../shell/cwd.js";
import type { ShellAnalysis } from "../shell/types.js";
import type { CommandGrant } from "./grant-types.js";
import { matchesCommandGrant, segmentAllowedWithoutCommandGrant } from "./grant-match.js";
import type { CommandGrantCandidate } from "./types.js";

export function deniedByPrefix(shell: ShellAnalysis, denyPrefixes: string[][]): string | undefined {
	for (const segment of shell.segments) {
		for (const prefix of denyPrefixes) {
			if (matchesPrefix(segment.words, prefix)) {
				return `denied command prefix: ${prefix.join(" ")}`;
			}
		}
	}
	return undefined;
}

export function firstGrantCandidate(shell: ShellAnalysis, cwd: string, workspaceRoot: string): CommandGrantCandidate | undefined {
	return firstUncoveredGrantCandidate(shell, cwd, workspaceRoot, []);
}

export function firstUncoveredGrantCandidate(
	shell: ShellAnalysis,
	cwd: string,
	workspaceRoot: string,
	grants: readonly CommandGrant[],
): CommandGrantCandidate | undefined {
	if (shell.risk === "dangerous" || shell.risk === "catastrophic") return undefined;
	let segmentCwd = initialShellCwd(cwd);
	for (const segment of shell.segments) {
		if (segment.separatorBefore === "||") segmentCwd = initialShellCwd(cwd);
		if (segmentAllowedWithoutCommandGrant(segment)) {
			const nextCwd = cwdAfterShellSegment(segment, segmentCwd);
			if (nextCwd) segmentCwd = nextCwd;
			continue;
		}
		const matchedGrant = grants.find((grant) => matchesCommandGrant(segment, grant, segmentCwd, workspaceRoot));
		if (matchedGrant) {
			const nextCwd = cwdAfterShellSegment(segment, segmentCwd);
			if (nextCwd) segmentCwd = nextCwd;
			continue;
		}
		if (!segment.grantEligible || !segment.grantPrefix || segment.grantPrefix.length === 0) return undefined;
		const family = commandFamilyForSegment(segment, segmentCwd, workspaceRoot);
		if (family) {
			return {
				type: "commandFamily",
				family: family.family,
				pathScope: family.pathScope,
				description: family.description,
				scopes: ["session", "workspace"],
			};
		}
		return {
			type: "commandPrefix",
			prefix: segment.grantPrefix,
			description: segment.grantPrefix.join(" "),
			scopes: ["session", "workspace"],
		};
	}
	return undefined;
}

function matchesPrefix(words: string[], prefix: string[]): boolean {
	if (prefix.length === 0 || words.length < prefix.length) return false;
	for (let i = 0; i < prefix.length; i++) {
		if (words[i] !== prefix[i]) return false;
	}
	return true;
}
