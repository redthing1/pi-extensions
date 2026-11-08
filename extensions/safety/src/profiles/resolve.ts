import type { SafetyConfig, SafetyProfileName } from "../config/types.js";
import { CUSTOM_PROFILE_NAME, profilePreset, SAFETY_PROFILE_PRESETS } from "./presets.js";

export function applyProfile(config: SafetyConfig, profileName: SafetyProfileName): SafetyConfig {
	if (profileName === CUSTOM_PROFILE_NAME) return { ...config, profile: CUSTOM_PROFILE_NAME };

	const preset = profilePreset(profileName);
	if (!preset) return config;

	return {
		...config,
		profile: preset.name,
		enabled: preset.name !== "off",
		reins: {
			...config.reins,
			mode: preset.reinsMode,
		},
		containment: {
			...config.containment,
			mode: preset.containmentMode,
			network: preset.network,
			environment: preset.environment,
		},
	};
}

export function inferProfile(config: SafetyConfig): SafetyProfileName {
	for (const preset of SAFETY_PROFILE_PRESETS) {
		if (
			config.reins.mode === preset.reinsMode &&
			config.containment.mode === preset.containmentMode &&
			config.containment.network === preset.network &&
			config.containment.environment === preset.environment
		) {
			return preset.name;
		}
	}
	return CUSTOM_PROFILE_NAME;
}
