import { DEFAULT_SAFETY_CONFIG } from "./defaults.js";
import type {
	ProjectSafetyConfigFile,
	SafetyConfig,
	UserSafetyConfigFile,
} from "./types.js";
import { applyProfile } from "../profiles/resolve.js";
import { isRecord, stringArray, stringTupleArray } from "../util/json.js";
import {
	isContainmentMode,
	isEnvironmentMode,
	isNetworkMode,
	isProfile,
	isReinsMode,
} from "./guards.js";
import {
	stricterContainmentMode,
	stricterEnvironment,
	stricterProfile,
	stricterReinsMode,
} from "./strictness.js";

export interface ParsedConfig<T> {
	value: T | undefined;
	warnings: string[];
}

export function parseUserConfig(
	value: unknown,
	path: string,
): ParsedConfig<UserSafetyConfigFile> {
	const warnings: string[] = [];
	if (value === undefined) return { value: undefined, warnings };
	if (!isRecord(value))
		return {
			value: undefined,
			warnings: [`ignored ${path}: expected an object`],
		};

	const config: UserSafetyConfigFile = {};
	if (typeof value.enabled === "boolean") config.enabled = value.enabled;
	if (typeof value.profile === "string" && isProfile(value.profile))
		config.profile = value.profile;
	else if (value.profile !== undefined)
		warnings.push(`ignored ${path}: invalid profile`);

	const audit = readRecord(value.audit);
	if (audit) {
		config.audit = {};
		if (typeof audit.enabled === "boolean")
			config.audit.enabled = audit.enabled;
	}

	const reins = readRecord(value.reins);
	if (reins) {
		config.reins = {};
		if (typeof reins.mode === "string" && isReinsMode(reins.mode))
			config.reins.mode = reins.mode;
		else if (reins.mode !== undefined)
			warnings.push(`ignored ${path}: invalid reins.mode`);
		if (reins.catastrophic === "warn" || reins.catastrophic === "block")
			config.reins.catastrophic = reins.catastrophic;
	}

	const containment = readRecord(value.containment);
	if (containment) {
		config.containment = {};
		if (
			typeof containment.mode === "string" &&
			isContainmentMode(containment.mode)
		) {
			config.containment.mode = containment.mode;
		} else if (containment.mode !== undefined) {
			warnings.push(`ignored ${path}: invalid containment.mode`);
		}
		if (
			typeof containment.network === "string" &&
			isNetworkMode(containment.network)
		) {
			config.containment.network = containment.network;
		} else if (containment.network !== undefined) {
			warnings.push(`ignored ${path}: invalid containment.network`);
		}
		if (
			typeof containment.environment === "string" &&
			isEnvironmentMode(containment.environment)
		) {
			config.containment.environment = containment.environment;
		} else if (containment.environment !== undefined) {
			warnings.push(`ignored ${path}: invalid containment.environment`);
		}
		const filesystem = readRecord(containment.filesystem);
		if (filesystem) {
			config.containment.filesystem = {};
			const read = stringArray(filesystem.read);
			const write = stringArray(filesystem.write);
			if (read) config.containment.filesystem.read = read;
			if (write) config.containment.filesystem.write = write;
		}
	}

	const protectedPaths = stringArray(value.protectedPaths);
	if (protectedPaths) config.protectedPaths = protectedPaths;
	const denyPrefixes = stringTupleArray(value.denyCommandPrefixes);
	if (denyPrefixes) config.denyCommandPrefixes = denyPrefixes;

	return { value: config, warnings };
}

export function parseProjectConfig(
	value: unknown,
	path: string,
): ParsedConfig<ProjectSafetyConfigFile> {
	const warnings: string[] = [];
	if (value === undefined) return { value: undefined, warnings };
	if (!isRecord(value))
		return {
			value: undefined,
			warnings: [`ignored ${path}: expected an object`],
		};
	warnUnknownKeys(value, ["require", "protect", "deny"], path, warnings);

	const config: ProjectSafetyConfigFile = {};
	const require = readRecord(value.require);
	if (require) {
		warnUnknownKeys(
			require,
			["profile", "reinsMode", "containmentMode", "network", "environment"],
			`${path}.require`,
			warnings,
		);
		config.require = {};
		if (typeof require.profile === "string" && isProfile(require.profile))
			config.require.profile = require.profile;
		else if (require.profile !== undefined)
			warnings.push(`ignored ${path}: invalid require.profile`);
		if (typeof require.reinsMode === "string" && isReinsMode(require.reinsMode))
			config.require.reinsMode = require.reinsMode;
		else if (require.reinsMode !== undefined)
			warnings.push(`ignored ${path}: invalid require.reinsMode`);
		if (
			typeof require.containmentMode === "string" &&
			isContainmentMode(require.containmentMode)
		) {
			config.require.containmentMode = require.containmentMode;
		} else if (require.containmentMode !== undefined)
			warnings.push(`ignored ${path}: invalid require.containmentMode`);
		if (typeof require.network === "string" && isNetworkMode(require.network))
			config.require.network = require.network;
		else if (require.network !== undefined)
			warnings.push(`ignored ${path}: invalid require.network`);
		if (
			typeof require.environment === "string" &&
			isEnvironmentMode(require.environment)
		) {
			config.require.environment = require.environment;
		} else if (require.environment !== undefined)
			warnings.push(`ignored ${path}: invalid require.environment`);
	} else if (value.require !== undefined)
		warnings.push(`ignored ${path}: invalid require`);

	const protect = readRecord(value.protect);
	if (protect) {
		warnUnknownKeys(protect, ["paths"], `${path}.protect`, warnings);
		const paths = stringArray(protect.paths);
		if (paths) config.protect = { paths };
		else if (protect.paths !== undefined)
			warnings.push(`ignored ${path}: invalid protect.paths`);
	} else if (value.protect !== undefined)
		warnings.push(`ignored ${path}: invalid protect`);

	const deny = readRecord(value.deny);
	if (deny) {
		warnUnknownKeys(deny, ["commandPrefixes"], `${path}.deny`, warnings);
		const commandPrefixes = stringTupleArray(deny.commandPrefixes);
		if (commandPrefixes) config.deny = { commandPrefixes };
		else if (deny.commandPrefixes !== undefined)
			warnings.push(`ignored ${path}: invalid deny.commandPrefixes`);
	} else if (value.deny !== undefined)
		warnings.push(`ignored ${path}: invalid deny`);

	return { value: config, warnings };
}

export function mergeUserConfig(
	userConfig: UserSafetyConfigFile | undefined,
	enabledOverride: boolean,
): SafetyConfig {
	let merged = cloneConfig(DEFAULT_SAFETY_CONFIG);
	if (userConfig) {
		if (userConfig.enabled !== undefined) merged.enabled = userConfig.enabled;
		if (userConfig.profile) merged = applyProfile(merged, userConfig.profile);
		if (userConfig.audit?.enabled !== undefined)
			merged.audit.enabled = userConfig.audit.enabled;
		if (userConfig.reins?.mode) merged.reins.mode = userConfig.reins.mode;
		if (userConfig.reins?.catastrophic)
			merged.reins.catastrophic = userConfig.reins.catastrophic;
		if (userConfig.containment?.mode)
			merged.containment.mode = userConfig.containment.mode;
		if (userConfig.containment?.network)
			merged.containment.network = userConfig.containment.network;
		if (userConfig.containment?.environment)
			merged.containment.environment = userConfig.containment.environment;
		if (userConfig.containment?.filesystem?.read)
			merged.containment.filesystem.read =
				userConfig.containment.filesystem.read;
		if (userConfig.containment?.filesystem?.write)
			merged.containment.filesystem.write =
				userConfig.containment.filesystem.write;
		if (userConfig.protectedPaths)
			merged.protectedPaths = userConfig.protectedPaths;
		if (userConfig.denyCommandPrefixes)
			merged.denyCommandPrefixes = userConfig.denyCommandPrefixes;
	}
	if (enabledOverride) merged.enabled = true;
	return merged;
}

export function applyProjectTightening(
	config: SafetyConfig,
	projectConfig: ProjectSafetyConfigFile | undefined,
): SafetyConfig {
	if (!projectConfig) return config;
	let merged = cloneConfig(config);

	if (projectConfig.require?.profile) {
		merged = stricterProfile(merged, projectConfig.require.profile);
	}
	if (projectConfig.require?.reinsMode) {
		merged.reins.mode = stricterReinsMode(
			merged.reins.mode,
			projectConfig.require.reinsMode,
		);
	}
	if (projectConfig.require?.containmentMode) {
		merged.containment.mode = stricterContainmentMode(
			merged.containment.mode,
			projectConfig.require.containmentMode,
		);
	}
	if (projectConfig.require?.network === "none") {
		merged.containment.network = "none";
	}
	if (projectConfig.require?.environment) {
		merged.containment.environment = stricterEnvironment(
			merged.containment.environment,
			projectConfig.require.environment,
		);
	}
	if (projectConfig.protect?.paths) {
		merged.protectedPaths = uniqueStrings([
			...merged.protectedPaths,
			...projectConfig.protect.paths,
		]);
	}
	if (projectConfig.deny?.commandPrefixes) {
		merged.denyCommandPrefixes = [
			...merged.denyCommandPrefixes,
			...projectConfig.deny.commandPrefixes,
		];
	}

	return merged;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
	return isRecord(value) ? value : undefined;
}

function warnUnknownKeys(
	record: Record<string, unknown>,
	allowed: readonly string[],
	path: string,
	warnings: string[],
): void {
	const allowedKeys = new Set(allowed);
	for (const key of Object.keys(record)) {
		if (!allowedKeys.has(key))
			warnings.push(`ignored ${path}: unknown key '${key}'`);
	}
}

function cloneConfig(config: SafetyConfig): SafetyConfig {
	return {
		...config,
		audit: { ...config.audit },
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

function uniqueStrings(values: string[]): string[] {
	return Array.from(new Set(values));
}
