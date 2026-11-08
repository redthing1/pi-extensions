import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ConfigLoadResult, EffectiveSafetyPolicy, ProjectSafetyConfigFile, SafetyConfig } from "./types.js";
import { applyProjectTightening, mergeUserConfig, parseProjectConfig, parseUserConfig } from "./merge.js";
import { findWorkspaceRoot, workspaceHash } from "./workspace.js";
import { applyProfile, inferProfile } from "../profiles/resolve.js";
import { readJsonFile } from "../util/json.js";
import { appendReadonlyRoots, defaultReadonlyRoots } from "./readonly-roots.js";
import { isContainmentMode, isNetworkMode, isReinsMode } from "./guards.js";
import { isSafetyProfilePresetName } from "../profiles/presets.js";
import { cloneSafetyConfig } from "../child/context.js";
import { applySafetySessionSettings, type SafetySessionSettings } from "./session-settings.js";

export interface LoadSafetyConfigOptions {
	agentDir: string;
	cwd: string;
	workspace?: { cwd: string; root: string; home?: string };
	enabledOverride: boolean;
	profileOverride?: string;
	reinsModeOverride?: string;
	containmentModeOverride?: string;
	networkOverride?: string;
	inheritedConfig?: SafetyConfig;
	inheritedProjectConfig?: ProjectSafetyConfigFile;
	inheritedProjectConfigPath?: string;
	sessionSettings?: SafetySessionSettings;
}

export function loadSafetyConfig(options: LoadSafetyConfigOptions): ConfigLoadResult {
	const workspaceRoot = options.workspace?.root ?? findWorkspaceRoot(options.cwd);
	const workspaceCwd = options.workspace?.cwd ?? options.cwd;
	const userConfigPath = join(options.agentDir, "safety", "config.json");
	const projectConfigPath = join(workspaceRoot, ".pi", "safety.json");
	const workspaceStatePath = join(options.agentDir, "safety", "workspaces", `${workspaceHash(workspaceRoot)}.json`);
	const auditDir = join(options.agentDir, "safety", "audit");
	const configPaths: string[] = [];
	const warnings: string[] = [];

	let userConfig = undefined;
	if (!options.inheritedConfig && existsSync(userConfigPath)) {
		configPaths.push(userConfigPath);
		const read = readJsonFile(userConfigPath);
		if (read.warning) warnings.push(read.warning);
		const parsed = parseUserConfig(read.value, userConfigPath);
		warnings.push(...parsed.warnings);
		userConfig = parsed.value;
	}

	let projectConfig = options.inheritedProjectConfig;
	if (!options.workspace && existsSync(projectConfigPath)) {
		configPaths.push(projectConfigPath);
		const read = readJsonFile(projectConfigPath);
		if (read.warning) warnings.push(read.warning);
		const parsed = parseProjectConfig(read.value, projectConfigPath);
		warnings.push(...parsed.warnings);
		projectConfig = parsed.value;
	} else if (options.workspace && projectConfig && options.inheritedProjectConfigPath) {
		configPaths.push(options.inheritedProjectConfigPath);
	}

	let config = options.inheritedConfig
		? cloneSafetyConfig(options.inheritedConfig)
		: mergeUserConfig(userConfig, options.enabledOverride);
	if (!options.inheritedConfig) {
		if (isSafetyProfilePresetName(options.profileOverride)) config = applyProfile(config, options.profileOverride);
		if (options.reinsModeOverride && isReinsMode(options.reinsModeOverride)) config.reins.mode = options.reinsModeOverride;
		if (options.containmentModeOverride && isContainmentMode(options.containmentModeOverride)) {
			config.containment.mode = options.containmentModeOverride;
		}
		if (options.networkOverride && isNetworkMode(options.networkOverride)) config.containment.network = options.networkOverride;
	}
	if (options.sessionSettings) {
		applySafetySessionSettings(config, options.sessionSettings);
	}
	config = applyProjectTightening(config, projectConfig);
	if (
		options.inheritedConfig?.enabled === false ||
		options.sessionSettings?.enabled === false
	) {
		config.enabled = false;
	}
	if (!options.workspace) config = appendReadonlyRoots(config, defaultReadonlyRoots({ agentDir: options.agentDir, cwd: options.cwd, workspaceRoot }));
	config.profile = inferProfile(config);

	const policy: EffectiveSafetyPolicy = {
		...config,
		workspaceKind: options.workspace ? "provided" : "local",
		workspaceCwd,
		workspaceRoot,
		...(options.workspace?.home ? { workspaceHome: options.workspace.home } : {}),
		configPaths,
		warnings,
	};

	return {
		policy,
		userConfigPath,
		projectConfigPath,
		workspaceStatePath,
		auditDir,
	};
}
