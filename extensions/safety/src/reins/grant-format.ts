import type { StoredApprovalGrant } from "./grant-types.js";

export function formatGrants(grants: readonly StoredApprovalGrant[]): string {
	return grants.map(formatGrant).join(", ");
}

export function formatGrant(grant: StoredApprovalGrant): string {
	if (grant.type === "commandPrefix") return grant.prefix.join(" ");
	if (grant.type === "commandFamily") return `${grant.family} (${grant.pathScope})`;
	return `${grant.operations.join("/")} ${grant.roots.join(", ")}${grant.sensitivity === "privacy" ? " (privacy)" : ""}`;
}
