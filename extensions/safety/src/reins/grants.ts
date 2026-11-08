import type { PathAccess } from "../paths/types.js";
import type { ShellAnalysis } from "../shell/types.js";
import { nowIso } from "../util/time.js";
import type { CommandFamilyGrantCandidate, CommandPrefixGrantCandidate, PathAccessGrantCandidate } from "./types.js";
import type { CommandGrant, PathGrant, StoredApprovalGrant } from "./grant-types.js";
import { coversPathsWithGrants, coversShellWithGrants, normalizePrefix, samePrefix } from "./grant-match.js";
import { normalizePathGrantRoots } from "./path-grant-roots.js";
import { sameStringSet } from "./grant-equivalence.js";

export type SessionGrant = StoredApprovalGrant;

export class SessionGrantStore {
	private readonly grants: SessionGrant[];
	private readonly workspaceRoot: string;

	constructor(workspaceRoot: string, initialGrants: readonly SessionGrant[] = []) {
		this.workspaceRoot = workspaceRoot;
		this.grants = initialGrants.map(cloneGrant);
	}

	addCommandPrefix(prefix: string[], reason: string): CommandGrant {
		const normalized = normalizePrefix(prefix);
		const existing = this.commandGrants().find((grant) => grant.type === "commandPrefix" && samePrefix(grant.prefix, normalized));
		if (existing) return existing;
		const grant: CommandGrant = {
			id: `session-${this.grants.length + 1}`,
			type: "commandPrefix",
			prefix: normalized,
			createdAt: nowIso(),
			reason,
		};
		this.grants.push(grant);
		return grant;
	}

	addCommandFamily(candidate: CommandFamilyGrantCandidate, reason: string): CommandGrant {
		const existing = this.commandGrants().find(
			(grant) => grant.type === "commandFamily" && grant.family === candidate.family && grant.pathScope === candidate.pathScope,
		);
		if (existing) return existing;
		const grant: CommandGrant = {
			id: `session-${this.grants.length + 1}`,
			type: "commandFamily",
			family: candidate.family,
			pathScope: candidate.pathScope,
			createdAt: nowIso(),
			reason,
		};
		this.grants.push(grant);
		return grant;
	}

	addPathAccess(candidate: PathAccessGrantCandidate, reason: string): PathGrant {
		const roots = normalizePathGrantRoots(this.workspaceRoot, candidate.roots);
		const existing = this.pathGrants().find(
			(grant) =>
				sameStringSet(grant.roots, roots) &&
				sameStringSet(grant.operations, candidate.operations) &&
				grant.sensitivity === candidate.sensitivity,
		);
		if (existing) return existing;
		const grant: PathGrant = {
			id: `session-${this.grants.length + 1}`,
			type: "pathAccess",
			roots,
			operations: [...candidate.operations],
			sensitivity: candidate.sensitivity,
			createdAt: nowIso(),
			reason,
		};
		this.grants.push(grant);
		return grant;
	}

	addCommandCandidate(candidate: CommandPrefixGrantCandidate | CommandFamilyGrantCandidate, reason: string): CommandGrant {
		if (candidate.type === "commandPrefix") return this.addCommandPrefix(candidate.prefix, reason);
		return this.addCommandFamily(candidate, reason);
	}

	coversShell(shell: ShellAnalysis, cwd: string, workspaceRoot: string): CommandGrant[] | undefined {
		return coversShellWithGrants(shell, this.commandGrants(), { cwd, workspaceRoot });
	}

	coversPaths(paths: readonly PathAccess[]): PathGrant[] | undefined {
		return coversPathsWithGrants(paths, this.pathGrants());
	}

	list(): SessionGrant[] {
		return this.grants.map(cloneGrant);
	}

	remove(id: string): boolean {
		const index = this.grants.findIndex((grant) => grant.id === id);
		if (index === -1) return false;
		this.grants.splice(index, 1);
		return true;
	}

	private commandGrants(): CommandGrant[] {
		return this.grants.filter((grant): grant is CommandGrant => grant.type === "commandPrefix" || grant.type === "commandFamily");
	}

	private pathGrants(): PathGrant[] {
		return this.grants.filter((grant): grant is PathGrant => grant.type === "pathAccess");
	}
}

function cloneGrant<T extends SessionGrant>(grant: T): T {
	if (grant.type === "commandPrefix") return { ...grant, prefix: [...grant.prefix] };
	if (grant.type === "pathAccess") return { ...grant, roots: [...grant.roots], operations: [...grant.operations] };
	return { ...grant };
}
