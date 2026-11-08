import { readFileSync } from "node:fs";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import type { SubagentConfig } from "./types.ts";

const DEFAULT_MAX_CONCURRENCY = 4;

export function loadSubagentConfig(): SubagentConfig {
	try {
		const value = JSON.parse(readFileSync(join(getAgentDir(), "subagents", "config.json"), "utf8")) as unknown;
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			return { maxConcurrency: DEFAULT_MAX_CONCURRENCY };
		}
		const maxConcurrency = (value as Record<string, unknown>).maxConcurrency;
		if (typeof maxConcurrency === "number" && Number.isInteger(maxConcurrency) && maxConcurrency > 0) {
			return { maxConcurrency };
		}
	} catch {
		// Missing and obsolete configuration both use the simple default.
	}
	return { maxConcurrency: DEFAULT_MAX_CONCURRENCY };
}
