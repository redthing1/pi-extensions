import type { PathGrant } from "./grant-types.js";

export interface ExecutionGrants {
	pathGrants: PathGrant[];
	commandApproved: boolean;
}

export function emptyExecutionGrants(): ExecutionGrants {
	return {
		pathGrants: [],
		commandApproved: false,
	};
}

export function cloneExecutionGrants(grants: ExecutionGrants): ExecutionGrants {
	return {
		pathGrants: grants.pathGrants.map((grant) => ({ ...grant, roots: [...grant.roots], operations: [...grant.operations] })),
		commandApproved: grants.commandApproved,
	};
}
