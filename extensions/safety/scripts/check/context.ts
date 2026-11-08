import type { ConfigLoadResult } from "../../src/config/types.js";

export interface CheckContext {
	agentDir: string;
	cwd: string;
	loaded: ConfigLoadResult;
}
