import type { ContainmentMode, EnvironmentMode, ReinsMode, SafetyConfig, SafetyProfileName } from "./types.js";
import { applyProfile } from "../profiles/resolve.js";
import { safetyProfileStrictness } from "../profiles/presets.js";

export function stricterProfile(config: SafetyConfig, required: SafetyProfileName): SafetyConfig {
	const currentRank = safetyProfileStrictness(config.profile);
	const requiredRank = safetyProfileStrictness(required);
	return requiredRank > currentRank ? applyProfile(config, required) : config;
}

export function stricterReinsMode(current: ReinsMode, required: ReinsMode): ReinsMode {
	return reinsStrictness(required) > reinsStrictness(current) ? required : current;
}

export function stricterContainmentMode(current: ContainmentMode, required: ContainmentMode): ContainmentMode {
	return containmentStrictness(required) > containmentStrictness(current) ? required : current;
}

export function stricterEnvironment(current: EnvironmentMode, required: EnvironmentMode): EnvironmentMode {
	return environmentStrictness(required) > environmentStrictness(current) ? required : current;
}

function reinsStrictness(mode: ReinsMode): number {
	switch (mode) {
		case "off":
			return 0;
		case "observe":
			return 1;
		case "guarded":
			return 2;
		case "accept-edits":
			return 3;
		case "read-only":
			return 4;
	}
}

function containmentStrictness(mode: ContainmentMode): number {
	switch (mode) {
		case "off":
			return 0;
		case "workspace-write":
			return 1;
		case "read-only":
			return 2;
	}
}

function environmentStrictness(mode: EnvironmentMode): number {
	switch (mode) {
		case "inherit":
			return 0;
		case "safe":
			return 1;
		case "minimal":
			return 2;
	}
}
