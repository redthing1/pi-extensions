import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, parse, resolve } from "node:path";
import type { SafetyRequest } from "../controller/types.js";
import type { PathAccess, PathOperation } from "../paths/types.js";
import type { GrantScope, PathGrantSensitivity } from "./grant-types.js";
import type { PathApprovalRequirement } from "./requirements.js";
import type { PathAccessGrantCandidate } from "./types.js";

export type PathAccessDecision =
	| { kind: "allow" }
	| { kind: "ask"; reason: string; requirement: PathApprovalRequirement }
	| { kind: "block"; reason: string };

export function pathDecisionForRequest(request: SafetyRequest): PathAccessDecision {
	const blocked = request.paths.filter((path) => !path.allowed);
	if (blocked.length === 0) return { kind: "allow" };

	const hardBlock = blocked.find((path) => path.protectedKind === "secret" || path.protectedKind === "custom");
	if (hardBlock) return { kind: "block", reason: blockedPathReason(hardBlock) };

	const first = blocked[0];
	if (!first) return { kind: "allow" };
	const sensitivity: PathGrantSensitivity = first.protectedKind === "privacy" ? "privacy" : "normal";
	const sameSensitivity = blocked.filter(
		(path) =>
			(path.protectedKind === "privacy" ? "privacy" : "normal") === sensitivity,
	);
	// Combine one operation across roots or several operations on identical roots, never an unauthorized cross-product.
	const firstRoots = grantRootsForPath(first);
	const sameOperation = sameSensitivity.filter((path) => path.operation === first.operation);
	const sameRoots = sameSensitivity.filter((path) => sameStrings(grantRootsForPath(path), firstRoots));
	const selected = sameRoots.length >= sameOperation.length ? sameRoots : sameOperation;
	const roots = pathGrantRootsForBlockedPaths(selected);
	const operations = uniqueOperations(selected.map((path) => path.operation));
	const scopes = grantScopes(sensitivity, operations, roots);
	const reason = pathApprovalReason(sensitivity, selected);
	const candidate: PathAccessGrantCandidate = {
		type: "pathAccess",
		roots,
		operations,
		sensitivity,
		description: pathGrantDescription(operations, roots, selected),
		scopes,
	};
	return {
		kind: "ask",
		reason,
		requirement: {
			type: "pathAccess",
			reason,
			paths: selected,
			candidate,
		},
	};
}

export function pathGrantRootsForBlockedPaths(paths: readonly PathAccess[]): string[] {
	const roots = paths.flatMap((path) => grantRootsForPath(path));
	return uniqueStrings(roots);
}

function grantRootsForPath(path: PathAccess): string[] {
	const directoryRoot = directoryGrantRoot(path);
	return directoryRoot ? [directoryRoot] : [path.resolvedPath];
}

function directoryGrantRoot(path: PathAccess): string | undefined {
	const root =
		path.operation === "list" || existingDirectory(path.resolvedPath)
			? path.resolvedPath
			: dirname(path.resolvedPath);
	return unsafeSystemGrantRoot(root) ? undefined : root;
}

function sessionReusableDirectoryRoot(path: string): boolean {
	const root = resolve(path);
	if (tempDirectoryRoot(root)) return true;
	return workspaceReusableDirectoryRoot(root);
}

function workspaceReusableDirectoryRoot(path: string): boolean {
	const root = resolve(path);
	if (root === parse(root).root) return false;
	if (root === resolve(homedir())) return false;
	const parts = root.split("/").filter(Boolean);
	if (parts.length === 0) return false;
	if (unsafeSystemGrantRoot(root)) return false;
	if (parts[0] === "tmp" && parts.length <= 1) return false;
	if (parts[0] === "var" && parts.length <= 1) return false;
	if (parts[0] === "private" && parts[1] === "tmp" && parts.length <= 2) return false;
	if (parts[0] === "private" && parts[1] === "var" && parts.length <= 2) return false;
	if (parts[0] === "Users" && parts.length <= 2) return false;
	if (parts[0] === "Volumes" && parts.length <= 2) return false;
	return true;
}

function tempDirectoryRoot(root: string): boolean {
	const parts = root.split("/").filter(Boolean);
	return (parts[0] === "tmp" && parts.length === 1) || (parts[0] === "private" && parts[1] === "tmp" && parts.length === 2);
}

function unsafeSystemGrantRoot(path: string): boolean {
	const parts = resolve(path).split("/").filter(Boolean);
	return parts[0] === "dev" || parts[0] === "proc" || parts[0] === "sys";
}

function grantScopes(sensitivity: PathGrantSensitivity, operations: PathOperation[], roots: string[]): GrantScope[] {
	if (roots.length === 0) return [];
	if (sensitivity === "privacy") return operations.includes("write") ? [] : ["session"];
	if (roots.some((root) => !sessionReusableDirectoryRoot(root))) return [];
	if (roots.some((root) => !workspaceReusableDirectoryRoot(root))) return ["session"];
	return ["session", "workspace"];
}

function pathApprovalReason(sensitivity: PathGrantSensitivity, paths: PathAccess[]): string {
	if (sensitivity === "privacy") return `privacy-protected path requires approval: ${formatPathSummary(paths)}`;
	return `path access requires approval: ${formatPathSummary(paths)}`;
}

function blockedPathReason(path: PathAccess): string {
	return `path ${path.path} is blocked: ${path.reason}`;
}

function formatPathSummary(paths: PathAccess[]): string {
	if (paths.length === 1) return `${paths[0].operation} ${paths[0].path}`;
	return `${paths.length} paths`;
}

function pathGrantDescription(operations: PathOperation[], roots: string[], paths: PathAccess[]): string {
	const operationText = operations.join("/");
	if (roots.length === 1) return `${operationText} ${roots[0]}`;
	if (roots.length > 1) return `${operationText} ${roots.length} paths`;
	return `${operationText} ${formatPathSummary(paths)}`;
}

function uniqueOperations(values: PathOperation[]): PathOperation[] {
	const order: PathOperation[] = ["read", "list", "write"];
	const set = new Set(values);
	return order.filter((operation) => set.has(operation));
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function uniqueStrings(values: string[]): string[] {
	return Array.from(new Set(values));
}

function existingDirectory(path: string): boolean {
	if (!existsSync(path)) return false;
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}
