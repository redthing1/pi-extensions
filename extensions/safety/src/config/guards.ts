import { isSafetyProfileName } from "../profiles/presets.js";
import {
	CONTAINMENT_MODES,
	ENVIRONMENT_MODES,
	NETWORK_MODES,
	REINS_MODES,
	type ContainmentMode,
	type EnvironmentMode,
	type NetworkMode,
	type ReinsMode,
	type SafetyProfileName,
} from "./types.js";

const REINS_MODE_SET = new Set<string>(REINS_MODES);
const CONTAINMENT_MODE_SET = new Set<string>(CONTAINMENT_MODES);
const NETWORK_MODE_SET = new Set<string>(NETWORK_MODES);
const ENVIRONMENT_MODE_SET = new Set<string>(ENVIRONMENT_MODES);

export function isProfile(value: string): value is SafetyProfileName {
	return isSafetyProfileName(value);
}

export function isReinsMode(value: string): value is ReinsMode {
	return REINS_MODE_SET.has(value);
}

export function isContainmentMode(value: string): value is ContainmentMode {
	return CONTAINMENT_MODE_SET.has(value);
}

export function isNetworkMode(value: string): value is NetworkMode {
	return NETWORK_MODE_SET.has(value);
}

export function isEnvironmentMode(value: string): value is EnvironmentMode {
	return ENVIRONMENT_MODE_SET.has(value);
}
