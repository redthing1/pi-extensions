import { readFileSync } from "node:fs";
import type {
	EffectiveSafetyPolicy,
	ProjectSafetyConfigFile,
	SafetyConfig,
} from "../config/types.js";
import {
	isContainmentMode,
	isEnvironmentMode,
	isNetworkMode,
	isProfile,
	isReinsMode,
} from "../config/guards.js";
import type {
	CommandFamilyName,
	CommandFamilyPathScope,
} from "../shell/command-families.js";
import type { StoredApprovalGrant } from "../reins/grant-types.js";
import type { PathOperation } from "../paths/types.js";
import { isRecord, stringArray, stringTupleArray } from "../util/json.js";
import { parseProjectConfig } from "../config/merge.js";
import type { ProvidedProjectSafetyConfig } from "./project-config.js";

export interface SafetyChildContext {
	version: 1;
	policy: SafetyConfig;
	grants: StoredApprovalGrant[];
	approvedTools: string[];
	project?: ProvidedProjectSafetyConfig;
}

export function createSafetyChildContext(
	policy: EffectiveSafetyPolicy,
	grants: readonly StoredApprovalGrant[],
	approvedTools: readonly string[],
	project?: ProvidedProjectSafetyConfig,
): SafetyChildContext {
	return {
		version: 1,
		policy: cloneSafetyConfig(policy),
		grants: grants.map(cloneGrant),
		approvedTools: [...approvedTools],
		...(project
			? {
					project: {
						path: project.path,
						config: cloneProjectConfig(project.config),
					},
				}
			: {}),
	};
}

export function readSafetyChildContext(path: string): SafetyChildContext {
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(path, "utf-8")) as unknown;
	} catch (error) {
		throw new Error(
			`cannot read inherited Safety context: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const context = parseSafetyChildContext(value);
	if (!context) throw new Error("inherited Safety context is invalid");
	return context;
}

export function parseSafetyChildContext(
	value: unknown,
): SafetyChildContext | undefined {
	if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.grants))
		return undefined;
	const policy = parseSafetyConfig(value.policy);
	if (!policy) return undefined;
	const grants: StoredApprovalGrant[] = [];
	for (const rawGrant of value.grants) {
		const grant = parseGrant(rawGrant);
		if (!grant) return undefined;
		grants.push(grant);
	}
	const approvedTools = stringArray(value.approvedTools);
	if (!approvedTools) return undefined;
	const project = parseProjectSnapshot(value.project);
	if (value.project !== undefined && !project) return undefined;
	return { version: 1, policy, grants, approvedTools, ...(project ? { project } : {}) };
}

export function cloneSafetyConfig(config: SafetyConfig): SafetyConfig {
	return {
		enabled: config.enabled,
		profile: config.profile,
		audit: { enabled: config.audit.enabled },
		reins: { ...config.reins },
		containment: {
			...config.containment,
			filesystem: {
				read: [...config.containment.filesystem.read],
				write: [...config.containment.filesystem.write],
			},
		},
		protectedPaths: [...config.protectedPaths],
		denyCommandPrefixes: config.denyCommandPrefixes.map((prefix) => [
			...prefix,
		]),
	};
}

function parseSafetyConfig(value: unknown): SafetyConfig | undefined {
	if (!isRecord(value)) return undefined;
	if (
		typeof value.enabled !== "boolean" ||
		typeof value.profile !== "string" ||
		!isProfile(value.profile)
	)
		return undefined;
	if (!isRecord(value.audit) || typeof value.audit.enabled !== "boolean")
		return undefined;
	if (
		!isRecord(value.reins) ||
		typeof value.reins.mode !== "string" ||
		!isReinsMode(value.reins.mode) ||
		(value.reins.catastrophic !== "warn" &&
			value.reins.catastrophic !== "block")
	)
		return undefined;
	if (
		!isRecord(value.containment) ||
		typeof value.containment.mode !== "string" ||
		!isContainmentMode(value.containment.mode) ||
		typeof value.containment.network !== "string" ||
		!isNetworkMode(value.containment.network) ||
		typeof value.containment.environment !== "string" ||
		!isEnvironmentMode(value.containment.environment) ||
		!isRecord(value.containment.filesystem)
	)
		return undefined;
	const read = stringArray(value.containment.filesystem.read);
	const write = stringArray(value.containment.filesystem.write);
	const protectedPaths = stringArray(value.protectedPaths);
	const denyCommandPrefixes = stringTupleArray(value.denyCommandPrefixes);
	if (!read || !write || !protectedPaths || !denyCommandPrefixes)
		return undefined;
	return {
		enabled: value.enabled,
		profile: value.profile,
		audit: { enabled: value.audit.enabled },
		reins: { mode: value.reins.mode, catastrophic: value.reins.catastrophic },
		containment: {
			mode: value.containment.mode,
			network: value.containment.network,
			environment: value.containment.environment,
			filesystem: { read, write },
		},
		protectedPaths,
		denyCommandPrefixes,
	};
}

function parseGrant(value: unknown): StoredApprovalGrant | undefined {
	if (
		!isRecord(value) ||
		typeof value.id !== "string" ||
		typeof value.createdAt !== "string" ||
		typeof value.reason !== "string"
	)
		return undefined;
	if (value.type === "commandPrefix") {
		const prefix = stringArray(value.prefix);
		return prefix && prefix.length > 0
			? {
					id: value.id,
					type: "commandPrefix",
					prefix,
					createdAt: value.createdAt,
					reason: value.reason,
				}
			: undefined;
	}
	if (
		value.type === "commandFamily" &&
		isCommandFamily(value.family) &&
		isCommandFamilyPathScope(value.pathScope)
	) {
		return {
			id: value.id,
			type: "commandFamily",
			family: value.family,
			pathScope: value.pathScope,
			createdAt: value.createdAt,
			reason: value.reason,
		};
	}
	if (value.type === "pathAccess") {
		const roots = stringArray(value.roots);
		const operations = parsePathOperations(value.operations);
		if (
			!roots ||
			roots.length === 0 ||
			!operations ||
			(value.sensitivity !== "normal" && value.sensitivity !== "privacy")
		)
			return undefined;
		return {
			id: value.id,
			type: "pathAccess",
			roots,
			operations,
			sensitivity: value.sensitivity,
			createdAt: value.createdAt,
			reason: value.reason,
		};
	}
	return undefined;
}

function parseProjectSnapshot(
	value: unknown,
): ProvidedProjectSafetyConfig | undefined {
	if (
		!isRecord(value) ||
		typeof value.path !== "string" ||
		!value.path.startsWith("/")
	)
		return undefined;
	const parsed = parseProjectConfig(value.config, value.path);
	return parsed.value && parsed.warnings.length === 0
		? { path: value.path, config: parsed.value }
		: undefined;
}

function cloneProjectConfig(
	config: ProjectSafetyConfigFile,
): ProjectSafetyConfigFile {
	return {
		...(config.require ? { require: { ...config.require } } : {}),
		...(config.protect?.paths
			? { protect: { paths: [...config.protect.paths] } }
			: {}),
		...(config.deny?.commandPrefixes
			? {
					deny: {
						commandPrefixes: config.deny.commandPrefixes.map((prefix) => [
							...prefix,
						]),
					},
				}
			: {}),
	};
}

function parsePathOperations(value: unknown): PathOperation[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const operations = value.filter(
		(item): item is PathOperation =>
			item === "read" || item === "list" || item === "write",
	);
	return operations.length === value.length ? operations : undefined;
}

function isCommandFamily(value: unknown): value is CommandFamilyName {
	return value === "cmake.build" || value === "cmake.configure";
}

function isCommandFamilyPathScope(
	value: unknown,
): value is CommandFamilyPathScope {
	return value === "workspace";
}

function cloneGrant<T extends StoredApprovalGrant>(grant: T): T {
	if (grant.type === "commandPrefix")
		return { ...grant, prefix: [...grant.prefix] };
	if (grant.type === "pathAccess")
		return {
			...grant,
			roots: [...grant.roots],
			operations: [...grant.operations],
		};
	return { ...grant };
}
