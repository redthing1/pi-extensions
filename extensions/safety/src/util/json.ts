import { readFileSync } from "node:fs";

export interface JsonReadResult {
	value: unknown | undefined;
	warning?: string;
}

export function readJsonFile(path: string): JsonReadResult {
	try {
		return { value: JSON.parse(readFileSync(path, "utf-8")) as unknown };
	} catch (err) {
		if (err instanceof SyntaxError) {
			return { value: undefined, warning: `invalid JSON in ${path}: ${err.message}` };
		}
		return { value: undefined, warning: `failed to read ${path}: ${err instanceof Error ? err.message : String(err)}` };
	}
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const out: string[] = [];
	for (const item of value) {
		if (typeof item !== "string") return undefined;
		out.push(item);
	}
	return out;
}

export function stringTupleArray(value: unknown): string[][] | undefined {
	if (!Array.isArray(value)) return undefined;
	const out: string[][] = [];
	for (const item of value) {
		const tuple = stringArray(item);
		if (!tuple) return undefined;
		out.push(tuple);
	}
	return out;
}

