import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { PathAccess, PathOperation } from "../paths/types.js";
import type { ShellAnalysis } from "../shell/types.js";
import { nowIso } from "../util/time.js";
import { isRecord, stringArray } from "../util/json.js";
import type { CommandFamilyGrantCandidate, CommandPrefixGrantCandidate, PathAccessGrantCandidate } from "./types.js";
import type { CommandGrant, PathGrant, StoredApprovalGrant } from "./grant-types.js";
import { coversPathsWithGrants, coversShellWithGrants, normalizePrefix, samePrefix } from "./grant-match.js";
import { commandFamilyDescription, type CommandFamilyName, type CommandFamilyPathScope } from "../shell/command-families.js";
import { normalizePathGrantRoots } from "./path-grant-roots.js";
import { sameStoredApprovalGrant, sameStringSet } from "./grant-equivalence.js";

export type WorkspaceGrant = StoredApprovalGrant;

interface WorkspaceGrantFile {
	version: 1;
	workspaceRoot: string;
	createdAt: string;
	updatedAt: string;
	grants: WorkspaceGrant[];
}

export class WorkspaceGrantStore {
	private grantFile: WorkspaceGrantFile;

	constructor(
		private readonly path: string,
		private readonly workspaceRoot: string,
	) {
		this.grantFile = this.load();
	}

	addCommandPrefix(prefix: string[], reason: string): WorkspaceGrant {
		const normalized = normalizePrefix(prefix);
		const existing = this.grantFile.grants.find((grant) => grant.type === "commandPrefix" && samePrefix(grant.prefix, normalized));
		if (existing) return existing;
		const grant: WorkspaceGrant = {
			id: `workspace-${this.grantFile.grants.length + 1}`,
			type: "commandPrefix",
			prefix: normalized,
			createdAt: nowIso(),
			reason,
		};
		this.grantFile.grants.push(grant);
		this.grantFile.updatedAt = nowIso();
		this.save();
		return grant;
	}

	addCommandFamily(candidate: CommandFamilyGrantCandidate, reason: string): WorkspaceGrant {
		const existing = this.grantFile.grants.find(
			(grant) => grant.type === "commandFamily" && grant.family === candidate.family && grant.pathScope === candidate.pathScope,
		);
		if (existing) return existing;
		const grant: WorkspaceGrant = {
			id: `workspace-${this.grantFile.grants.length + 1}`,
			type: "commandFamily",
			family: candidate.family,
			pathScope: candidate.pathScope,
			createdAt: nowIso(),
			reason,
		};
		this.grantFile.grants.push(grant);
		this.grantFile.updatedAt = nowIso();
		this.save();
		return grant;
	}

	addCommandCandidate(candidate: CommandFamilyGrantCandidate | CommandPrefixGrantCandidate, reason: string): WorkspaceGrant {
		if (candidate.type === "commandPrefix") return this.addCommandPrefix(candidate.prefix, reason);
		return this.addCommandFamily(candidate, reason);
	}

	addPathAccess(candidate: PathAccessGrantCandidate, reason: string): WorkspaceGrant | undefined {
		if (candidate.sensitivity !== "normal") return undefined;
		const roots = normalizePathGrantRoots(this.workspaceRoot, candidate.roots);
		const existing = this.pathGrants().find(
			(grant) =>
				sameStringSet(grant.roots, roots) &&
				sameStringSet(grant.operations, candidate.operations) &&
				grant.sensitivity === candidate.sensitivity,
		);
		if (existing) return existing;
		const grant: PathGrant = {
			id: `workspace-${this.grantFile.grants.length + 1}`,
			type: "pathAccess",
			roots,
			operations: [...candidate.operations],
			sensitivity: candidate.sensitivity,
			createdAt: nowIso(),
			reason,
		};
		this.grantFile.grants.push(grant);
		this.grantFile.updatedAt = nowIso();
		this.save();
		return grant;
	}

	coversShell(shell: ShellAnalysis, cwd: string): WorkspaceGrant[] | undefined {
		return coversShellWithGrants(shell, this.commandGrants(), { cwd, workspaceRoot: this.workspaceRoot });
	}

	coversPaths(paths: readonly PathAccess[]): PathGrant[] | undefined {
		return coversPathsWithGrants(paths, this.pathGrants());
	}

	list(): WorkspaceGrant[] {
		return this.grantFile.grants.map(cloneGrant);
	}

	hasEquivalent(grant: StoredApprovalGrant): boolean {
		return this.grantFile.grants.some((candidate) => sameStoredApprovalGrant(candidate, grant));
	}

	remove(id: string): boolean {
		const index = this.grantFile.grants.findIndex((grant) => grant.id === id);
		if (index === -1) return false;
		this.grantFile.grants.splice(index, 1);
		this.grantFile.updatedAt = nowIso();
		this.save();
		return true;
	}

	private commandGrants(): CommandGrant[] {
		return this.grantFile.grants.filter((grant): grant is CommandGrant => grant.type === "commandPrefix" || grant.type === "commandFamily");
	}

	private pathGrants(): PathGrant[] {
		return this.grantFile.grants.filter((grant): grant is PathGrant => grant.type === "pathAccess");
	}

	private load(): WorkspaceGrantFile {
		if (!existsSync(this.path)) return emptyFile(this.workspaceRoot);
		try {
			const parsed = JSON.parse(readFileSync(this.path, "utf-8")) as unknown;
			const file = parseGrantFile(parsed, this.workspaceRoot);
			return file ?? emptyFile(this.workspaceRoot);
		} catch {
			return emptyFile(this.workspaceRoot);
		}
	}

	private save(): void {
		mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
		writeFileSync(this.path, `${JSON.stringify(this.grantFile, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
	}
}

function emptyFile(workspaceRoot: string): WorkspaceGrantFile {
	const now = nowIso();
	return {
		version: 1,
		workspaceRoot,
		createdAt: now,
		updatedAt: now,
		grants: [],
	};
}

function parseGrantFile(value: unknown, workspaceRoot: string): WorkspaceGrantFile | undefined {
	if (!isRecord(value)) return undefined;
	if (value.version !== 1 || value.workspaceRoot !== workspaceRoot || !Array.isArray(value.grants)) return undefined;
	const grants: WorkspaceGrant[] = [];
	for (const item of value.grants) {
		if (!isRecord(item)) continue;
		if (typeof item.id !== "string" || typeof item.createdAt !== "string" || typeof item.reason !== "string") continue;
		if (item.type === "commandPrefix") {
			const prefix = stringArray(item.prefix);
			if (!prefix || prefix.length === 0) continue;
			grants.push({
				id: item.id,
				type: "commandPrefix",
				prefix,
				createdAt: item.createdAt,
				reason: item.reason,
			});
		} else if (item.type === "commandFamily" && isCommandFamily(item.family) && isCommandFamilyPathScope(item.pathScope)) {
			grants.push({
				id: item.id,
				type: "commandFamily",
				family: item.family,
				pathScope: item.pathScope,
				createdAt: item.createdAt,
				reason: item.reason || commandFamilyDescription(item.family, item.pathScope),
			});
		} else if (item.type === "pathAccess") {
			const roots = stringArray(item.roots);
			const operations = pathOperations(item.operations);
			if (!roots || roots.length === 0 || !operations || item.sensitivity !== "normal") continue;
			grants.push({
				id: item.id,
				type: "pathAccess",
				roots: normalizePathGrantRoots(workspaceRoot, roots),
				operations,
				sensitivity: "normal",
				createdAt: item.createdAt,
				reason: item.reason,
			});
		}
	}
	return {
		version: 1,
		workspaceRoot,
		createdAt: typeof value.createdAt === "string" ? value.createdAt : nowIso(),
		updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : nowIso(),
		grants,
	};
}

function cloneGrant<T extends WorkspaceGrant>(grant: T): T {
	if (grant.type === "commandPrefix") return { ...grant, prefix: [...grant.prefix] };
	if (grant.type === "pathAccess") return { ...grant, roots: [...grant.roots], operations: [...grant.operations] };
	return { ...grant };
}

function isCommandFamily(value: unknown): value is CommandFamilyName {
	return value === "cmake.build" || value === "cmake.configure";
}

function isCommandFamilyPathScope(value: unknown): value is CommandFamilyPathScope {
	return value === "workspace";
}

function pathOperations(value: unknown): PathOperation[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const operations: PathOperation[] = [];
	for (const item of value) {
		if (item === "read" || item === "list" || item === "write") operations.push(item);
	}
	return operations.length === value.length ? operations : undefined;
}
