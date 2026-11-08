import type { PathAccess } from "../paths/types.js";
import type {
	CommandFamilyGrantCandidate,
	CommandPrefixGrantCandidate,
	PathAccessGrantCandidate,
} from "./types.js";

export interface PathApprovalRequirement {
	type: "pathAccess";
	reason: string;
	paths: PathAccess[];
	candidate: PathAccessGrantCandidate;
}

export interface CommandApprovalRequirement {
	type: "command";
	reason: string;
	candidate?: CommandPrefixGrantCandidate | CommandFamilyGrantCandidate;
}

export type ApprovalRequirement = PathApprovalRequirement | CommandApprovalRequirement;
