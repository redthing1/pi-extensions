import type { SafetyRequest } from "../controller/types.js";
import type { PathAccess } from "../paths/types.js";
import type { PathGrant } from "./grant-types.js";
import { matchesPathGrant } from "./grant-match.js";

export interface PathGrantApplication {
	request: SafetyRequest;
	matchedPathGrants: PathGrant[];
}

export function applyPathGrantsToRequest(request: SafetyRequest, grants: readonly PathGrant[]): PathGrantApplication {
	const matchedPathGrants = matchingPathGrants(request.paths, grants);
	return {
		request: matchedPathGrants.length > 0 ? requestWithAllowedPathGrants(request, matchedPathGrants) : request,
		matchedPathGrants,
	};
}

export function hasBlockedPath(request: SafetyRequest): boolean {
	return request.paths.some((path) => !path.allowed);
}

function requestWithAllowedPathGrants(request: SafetyRequest, grants: readonly PathGrant[]): SafetyRequest {
	return {
		...request,
		paths: request.paths.map((path) =>
			path.allowed || !pathCoveredByGrant(path, grants) ? path : { ...path, allowed: true, reason: "allowed" },
		),
	};
}

function matchingPathGrants(paths: readonly PathAccess[], grants: readonly PathGrant[]): PathGrant[] {
	const matched: PathGrant[] = [];
	for (const path of paths) {
		if (path.allowed) continue;
		const grant = coversSinglePath(path, grants);
		if (grant) matched.push(grant);
	}
	return matched;
}

function pathCoveredByGrant(path: PathAccess, grants: readonly PathGrant[]): boolean {
	return Boolean(coversSinglePath(path, grants));
}

function coversSinglePath(path: PathAccess, grants: readonly PathGrant[]): PathGrant | undefined {
	return grants.find((grant) => matchesPathGrant(path, grant));
}
