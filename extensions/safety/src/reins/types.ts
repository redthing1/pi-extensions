import type { SafetyRequest } from "../controller/types.js";
import type { PathOperation } from "../paths/types.js";
import type { CommandFamilyName, CommandFamilyPathScope } from "../shell/command-families.js";
import type { GrantScope, PathGrantSensitivity } from "./grant-types.js";
import type { ApprovalRequirement } from "./requirements.js";

export type ReinsDecisionKind = "allow" | "ask" | "block";

interface BaseGrantCandidate {
	description: string;
	scopes: GrantScope[];
}

export interface CommandPrefixGrantCandidate extends BaseGrantCandidate {
	type: "commandPrefix";
	prefix: string[];
}

export interface CommandFamilyGrantCandidate extends BaseGrantCandidate {
	type: "commandFamily";
	family: CommandFamilyName;
	pathScope: CommandFamilyPathScope;
}

export interface PathAccessGrantCandidate extends BaseGrantCandidate {
	type: "pathAccess";
	roots: string[];
	operations: PathOperation[];
	sensitivity: PathGrantSensitivity;
}

export type CommandGrantCandidate = CommandPrefixGrantCandidate | CommandFamilyGrantCandidate;
export type GrantCandidate = CommandGrantCandidate | PathAccessGrantCandidate;

export interface ReinsDecision {
	kind: ReinsDecisionKind;
	reason: string;
	request: SafetyRequest;
	requirement?: ApprovalRequirement;
}
