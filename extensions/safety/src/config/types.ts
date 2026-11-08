import type { SafetyProfileName } from "../profiles/presets.js";

export type { SafetyProfileName };

export const REINS_MODES = ["off", "observe", "read-only", "accept-edits", "guarded"] as const;
export type ReinsMode = (typeof REINS_MODES)[number];

export const CONTAINMENT_MODES = ["off", "read-only", "workspace-write"] as const;
export type ContainmentMode = (typeof CONTAINMENT_MODES)[number];

export const NETWORK_MODES = ["none", "host"] as const;
export type NetworkMode = (typeof NETWORK_MODES)[number];

export const ENVIRONMENT_MODES = ["minimal", "safe", "inherit"] as const;
export type EnvironmentMode = (typeof ENVIRONMENT_MODES)[number];

export const CATASTROPHIC_POLICIES = ["warn", "block"] as const;
export type CatastrophicPolicy = (typeof CATASTROPHIC_POLICIES)[number];

export interface FilesystemConfig {
	read: string[];
	write: string[];
}

export interface ReinsConfig {
	mode: ReinsMode;
	catastrophic: CatastrophicPolicy;
}

export interface ContainmentConfig {
	mode: ContainmentMode;
	network: NetworkMode;
	environment: EnvironmentMode;
	filesystem: FilesystemConfig;
}

export interface AuditConfig {
	enabled: boolean;
}

export interface SafetyConfig {
	enabled: boolean;
	profile: SafetyProfileName;
	audit: AuditConfig;
	reins: ReinsConfig;
	containment: ContainmentConfig;
	protectedPaths: string[];
	denyCommandPrefixes: string[][];
}

export interface UserSafetyConfigFile {
	enabled?: boolean;
	profile?: SafetyProfileName;
	audit?: Partial<AuditConfig>;
	reins?: Partial<ReinsConfig>;
	containment?: Omit<Partial<ContainmentConfig>, "filesystem"> & {
		filesystem?: Partial<FilesystemConfig>;
	};
	protectedPaths?: string[];
	denyCommandPrefixes?: string[][];
}

export interface ProjectSafetyConfigFile {
	require?: {
		profile?: SafetyProfileName;
		reinsMode?: ReinsMode;
		containmentMode?: ContainmentMode;
		network?: NetworkMode;
		environment?: EnvironmentMode;
	};
	protect?: {
		paths?: string[];
	};
	deny?: {
		commandPrefixes?: string[][];
	};
}

export interface EffectiveSafetyPolicy extends SafetyConfig {
	workspaceKind: "local" | "provided";
	workspaceCwd: string;
	workspaceRoot: string;
	workspaceHome?: string;
	configPaths: string[];
	warnings: string[];
}

export interface ConfigLoadResult {
	policy: EffectiveSafetyPolicy;
	userConfigPath: string;
	projectConfigPath: string;
	workspaceStatePath: string;
	auditDir: string;
}
