import { PRIVACY_PROTECTED_PATHS, SECRET_PROTECTED_PATHS } from "../config/protected-paths.js";
import { matchesSafetyPattern } from "./glob.js";
import { canonicalPath } from "./normalize.js";
import type { ProtectedPathKind } from "./types.js";

export interface ProtectedPathMatch {
	protected: boolean;
	pattern?: string;
	kind?: ProtectedPathKind;
}

export function matchProtectedPath(
	cwd: string,
	absolutePath: string,
	patterns: string[],
	resolvedPath = canonicalPath(absolutePath),
	home?: string,
): ProtectedPathMatch {
	for (const pattern of patterns) {
		if (matchesSafetyPattern(cwd, absolutePath, pattern, home) || matchesSafetyPattern(cwd, resolvedPath, pattern, home)) {
			return { protected: true, pattern, kind: protectedPathKind(pattern) };
		}
	}
	return { protected: false };
}

function protectedPathKind(pattern: string): ProtectedPathKind {
	if (PRIVACY_PROTECTED_PATHS.includes(pattern)) return "privacy";
	if (SECRET_PROTECTED_PATHS.includes(pattern)) return "secret";
	return "custom";
}
