import type { StoredApprovalGrant } from "./grant-types.js";

export function workspaceEligibleGrant(grant: StoredApprovalGrant): boolean {
	return grant.type === "commandPrefix" || grant.type === "commandFamily" || (grant.type === "pathAccess" && grant.sensitivity === "normal");
}

export function sameStoredApprovalGrant(left: StoredApprovalGrant, right: StoredApprovalGrant): boolean {
	if (left.type !== right.type) return false;
	if (left.type === "commandPrefix" && right.type === "commandPrefix") return sameStringSet(left.prefix, right.prefix);
	if (left.type === "commandFamily" && right.type === "commandFamily") {
		return left.family === right.family && left.pathScope === right.pathScope;
	}
	if (left.type === "pathAccess" && right.type === "pathAccess") {
		return (
			left.sensitivity === right.sensitivity &&
			sameStringSet(left.operations, right.operations) &&
			sameStringSet(left.roots, right.roots)
		);
	}
	return false;
}

export function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
	if (left.length !== right.length) return false;
	const values = new Set(left);
	return right.every((value) => values.has(value));
}
