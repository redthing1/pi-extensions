import type { PathOperation } from "../paths/types.js";
import type { CommandFamilyName, CommandFamilyPathScope } from "../shell/command-families.js";

export type PathGrantSensitivity = "normal" | "privacy";

interface StoredGrant {
	id: string;
	createdAt: string;
	reason: string;
}

export interface CommandPrefixGrant extends StoredGrant {
	type: "commandPrefix";
	prefix: string[];
}

export interface CommandFamilyGrant extends StoredGrant {
	type: "commandFamily";
	family: CommandFamilyName;
	pathScope: CommandFamilyPathScope;
}

export interface PathAccessGrant extends StoredGrant {
	type: "pathAccess";
	roots: string[];
	operations: PathOperation[];
	sensitivity: PathGrantSensitivity;
}

export type CommandGrant = CommandPrefixGrant | CommandFamilyGrant;
export type PathGrant = PathAccessGrant;
export type StoredApprovalGrant = CommandGrant | PathGrant;
export type GrantScope = "session" | "workspace";
export type ApprovalPersistence = "session" | "workspace";
