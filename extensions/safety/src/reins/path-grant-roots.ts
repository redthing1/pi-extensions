import { absolutePath, canonicalPath } from "../paths/normalize.js";

export function normalizePathGrantRoots(workspaceRoot: string, roots: readonly string[]): string[] {
	return uniqueStrings(roots.map((root) => canonicalPath(absolutePath(workspaceRoot, root))));
}

function uniqueStrings(values: string[]): string[] {
	return Array.from(new Set(values));
}
