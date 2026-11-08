import type {
	ContainmentMode,
	EnvironmentMode,
	NetworkMode,
	ReinsMode,
	SafetyConfig,
} from "./types.js";
import type { SafetyProfilePresetName } from "../profiles/presets.js";
import { applyProfile, inferProfile } from "../profiles/resolve.js";

export interface SafetySessionSettings {
	profile?: SafetyProfilePresetName;
	enabled?: boolean;
	reinsMode?: ReinsMode;
	containmentMode?: ContainmentMode;
	network?: NetworkMode;
	environment?: EnvironmentMode;
}

export function applySafetySessionSettings(
	policy: SafetyConfig,
	settings: SafetySessionSettings,
): void {
	let structuralChange = false;
	if (settings.profile) {
		const profiled = applyProfile(policy, settings.profile);
		policy.profile = profiled.profile;
		policy.reins = profiled.reins;
		policy.containment = profiled.containment;
		structuralChange = true;
	}
	if (settings.reinsMode) {
		policy.reins.mode = settings.reinsMode;
		structuralChange = true;
	}
	if (settings.containmentMode) {
		policy.containment.mode = settings.containmentMode;
		structuralChange = true;
	}
	if (settings.network) {
		policy.containment.network = settings.network;
		structuralChange = true;
	}
	if (settings.environment) {
		policy.containment.environment = settings.environment;
		structuralChange = true;
	}
	if (structuralChange) {
		policy.profile = inferProfile(policy);
		policy.enabled = policy.profile !== "off";
	}
	if (settings.enabled !== undefined) policy.enabled = settings.enabled;
}

export function cloneSafetySessionSettings(
	settings: SafetySessionSettings,
): SafetySessionSettings {
	return { ...settings };
}

export function setSessionProfile(
	settings: SafetySessionSettings,
	profile: SafetyProfilePresetName,
): void {
	settings.profile = profile;
	delete settings.reinsMode;
	delete settings.containmentMode;
	delete settings.network;
	delete settings.environment;
}

export function setPolicyReinsMode(policy: SafetyConfig, mode: ReinsMode): void {
	policy.reins.mode = mode;
	refreshPolicyProfile(policy);
}

export function setPolicyContainmentMode(policy: SafetyConfig, mode: ContainmentMode): void {
	policy.containment.mode = mode;
	refreshPolicyProfile(policy);
}

export function setPolicyNetworkMode(policy: SafetyConfig, network: NetworkMode): void {
	policy.containment.network = network;
	refreshPolicyProfile(policy);
}

export function setPolicyEnvironmentMode(policy: SafetyConfig, environment: EnvironmentMode): void {
	policy.containment.environment = environment;
	refreshPolicyProfile(policy);
}

function refreshPolicyProfile(policy: SafetyConfig): void {
	policy.profile = inferProfile(policy);
	policy.enabled = policy.profile !== "off";
}
