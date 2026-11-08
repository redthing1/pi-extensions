import { resolve } from "node:path";
import { absolutePath } from "../paths/normalize.js";
import { parseCdInvocation } from "./cd.js";
import type { ShellSegmentAnalysis } from "./types.js";

export function initialShellCwd(cwd: string): string {
	return resolve(cwd);
}

export function cwdAfterShellSegment(segment: ShellSegmentAnalysis, cwd: string): string | undefined {
	if (segment.program !== "cd") return undefined;
	const parsed = parseCdInvocation(segment.words.slice(1));
	if (!parsed.supported || !parsed.target) return undefined;
	return absolutePath(cwd, parsed.target);
}
