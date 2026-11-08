import type { ContainmentMode, NetworkMode, ReinsMode, SafetyProfileName } from "../config/types.js";
import type { SafetyRequest } from "../controller/types.js";
import type { ReinsDecisionKind } from "../reins/types.js";

export interface SafetyAuditEvent {
	version: 1;
	timestamp: string;
	workspaceRoot: string;
	profile: SafetyProfileName;
	reinsMode: ReinsMode;
	containment: {
		mode: ContainmentMode;
		network: NetworkMode;
	};
	source: SafetyRequest["source"];
	toolName?: string;
	summary: string;
	effects: string[];
	risk: string;
	decision: ReinsDecisionKind;
	decisionReason: string;
	paths: Array<{
		path: string;
		operation: string;
		allowed: boolean;
		reason: string;
	}>;
}

