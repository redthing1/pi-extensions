import type { PathOperation } from "../paths/types.js";
import type { ToolPathInput } from "./types.js";

export interface ExtractedToolPath {
	path: string;
	operation: PathOperation;
	field: string;
}

export function extractToolPaths(
	input: Record<string, unknown>,
	pathInputs: ToolPathInput[],
): ExtractedToolPath[] {
	const out: ExtractedToolPath[] = [];
	for (const descriptor of pathInputs) {
		for (const value of valuesAtPath(input, descriptor.field)) {
			if (typeof value === "string" && value.trim().length > 0) {
				out.push({
					path: value,
					operation: descriptor.operation,
					field: descriptor.field,
				});
			}
		}
	}
	return out;
}

function valuesAtPath(value: unknown, path: string): unknown[] {
	const parts = path.split(".");
	return collect(value, parts);
}

function collect(value: unknown, parts: string[]): unknown[] {
	if (parts.length === 0) return [value];
	const [head, ...tail] = parts;
	if (!head) return [];
	if (head.endsWith("[]")) {
		const key = head.slice(0, -2);
		if (!isRecord(value)) return [];
		const arrayValue = value[key];
		if (!Array.isArray(arrayValue)) return [];
		return arrayValue.flatMap((item) => collect(item, tail));
	}
	if (!isRecord(value)) return [];
	return collect(value[head], tail);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
