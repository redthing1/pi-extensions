import { resolve } from "node:path";
import { cwdAfterShellSegment, initialShellCwd } from "./cwd.js";
import { extractCommandPathReferences } from "./path-extractors.js";
import type { ShellPathReference } from "./path-references.js";
import type { ShellAnalysis, ShellSegmentAnalysis } from "./types.js";

export type { ShellPathReference } from "./path-references.js";

export function extractShellPathReferences(analysis: ShellAnalysis, initialCwd = process.cwd()): ShellPathReference[] {
	const references: ShellPathReference[] = [];
	let cwd = initialShellCwd(initialCwd);

	for (const segment of analysis.segments) {
		if (segment.separatorBefore === "||") cwd = initialShellCwd(initialCwd);
		for (const reference of extractSegmentPaths(segment)) {
			references.push({ ...reference, path: resolveShellPath(cwd, reference.path) });
		}
		const nextCwd = cwdAfterShellSegment(segment, cwd);
		if (nextCwd) cwd = nextCwd;
	}

	return references;
}

function extractSegmentPaths(segment: ShellSegmentAnalysis): ShellPathReference[] {
	const redirectionPaths = segment.redirections.flatMap((redirection) =>
		redirection.operation && redirection.target ? [{ path: redirection.target, operation: redirection.operation, segment: segment.raw }] : [],
	);
	if (!segment.program) return redirectionPaths;
	return [...extractCommandPathReferences(segment.program, segment.words.slice(1), segment.raw), ...redirectionPaths];
}

function resolveShellPath(cwd: string, path: string): string {
	if (isHomePath(path)) return path;
	if (path.length === 0 || path.includes("*") || path.includes("?") || path.includes("[")) return path;
	return resolve(cwd, path);
}

function isHomePath(path: string): boolean {
	return (
		path === "~" ||
		path.startsWith("~/") ||
		path === "$HOME" ||
		path.startsWith("$HOME/") ||
		path === "${HOME}" ||
		path.startsWith("${HOME}/")
	);
}
