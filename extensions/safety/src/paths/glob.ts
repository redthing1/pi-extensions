import { basename } from "node:path";
import { absolutePath } from "./normalize.js";

export function matchesSafetyPattern(cwd: string, absoluteCandidate: string, pattern: string, home?: string): boolean {
	const expanded = absolutePath(cwd, pattern, home);
	const normalizedCandidate = normalizeSlashes(absoluteCandidate);
	const normalizedPattern = normalizeSlashes(expanded);
	if (globRegex(normalizedPattern).test(normalizedCandidate)) return true;

	if (!pattern.includes("/") && !pattern.startsWith("~")) {
		return globRegex(pattern).test(basename(normalizedCandidate));
	}
	return false;
}

function globRegex(pattern: string): RegExp {
	let out = "^";
	for (let i = 0; i < pattern.length; i++) {
		const char = pattern[i];
		const next = pattern[i + 1];
		if (char === "*" && next === "*") {
			out += ".*";
			i++;
		} else if (char === "*") {
			out += "[^/]*";
		} else {
			out += escapeRegExp(char);
		}
	}
	out += "$";
	return new RegExp(out);
}

function normalizeSlashes(value: string): string {
	return value.replace(/\/+/g, "/");
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
