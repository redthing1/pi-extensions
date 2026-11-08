import type { ContainmentMode, EnvironmentMode, NetworkMode, ReinsMode } from "../config/types.js";

export const CUSTOM_PROFILE_NAME = "custom";

interface SafetyProfileDefinition {
	label: string;
	description: string;
	reinsMode: ReinsMode;
	containmentMode: ContainmentMode;
	network: NetworkMode;
	environment: EnvironmentMode;
	strictness: number;
	choiceOrder: number;
	statusSummary: string;
}

export const SAFETY_PROFILE_DEFINITIONS = {
	off: {
		label: "Off",
		description: "No permission decisions and no containment.",
		reinsMode: "off",
		containmentMode: "off",
		network: "host",
		environment: "inherit",
		strictness: 0,
		choiceOrder: 60,
		statusSummary: "off",
	},
	explore: {
		label: "Explore",
		description: "Read-only inspection with no network.",
		reinsMode: "read-only",
		containmentMode: "read-only",
		network: "none",
		environment: "minimal",
		strictness: 5,
		choiceOrder: 10,
		statusSummary: "read-only, net none",
	},
	code: {
		label: "Code",
		description: "Workspace edits allowed, commands ask, network off.",
		reinsMode: "accept-edits",
		containmentMode: "workspace-write",
		network: "none",
		environment: "minimal",
		strictness: 4,
		choiceOrder: 20,
		statusSummary: "edits ok, cmds ask, net none",
	},
	guarded: {
		label: "Guarded",
		description: "Careful command monitoring with workspace containment.",
		reinsMode: "guarded",
		containmentMode: "workspace-write",
		network: "none",
		environment: "minimal",
		strictness: 3,
		choiceOrder: 30,
		statusSummary: "guarded, net none",
	},
	watch: {
		label: "Watch",
		description: "Ask before risky actions without containment.",
		reinsMode: "guarded",
		containmentMode: "off",
		network: "host",
		environment: "inherit",
		strictness: 2,
		choiceOrder: 40,
		statusSummary: "asks, no sandbox",
	},
	monitor: {
		label: "Monitor",
		description: "Audit-oriented command monitoring without containment.",
		reinsMode: "observe",
		containmentMode: "off",
		network: "host",
		environment: "inherit",
		strictness: 1,
		choiceOrder: 50,
		statusSummary: "audit-oriented, no sandbox",
	},
} as const satisfies Record<string, SafetyProfileDefinition>;

export type SafetyProfilePresetName = keyof typeof SAFETY_PROFILE_DEFINITIONS;
export type SafetyProfileName = SafetyProfilePresetName | typeof CUSTOM_PROFILE_NAME;

export interface SafetyProfilePreset extends SafetyProfileDefinition {
	name: SafetyProfilePresetName;
}

export const CUSTOM_PROFILE_STRICTNESS = SAFETY_PROFILE_DEFINITIONS.watch.strictness;

export const SAFETY_PROFILE_PRESET_NAMES = Object.keys(SAFETY_PROFILE_DEFINITIONS) as readonly SafetyProfilePresetName[];
export const SAFETY_PROFILE_NAMES = [...SAFETY_PROFILE_PRESET_NAMES, CUSTOM_PROFILE_NAME] as readonly SafetyProfileName[];
export const SAFETY_PROFILE_PRESETS: readonly SafetyProfilePreset[] = SAFETY_PROFILE_PRESET_NAMES.map(profileDefinition);
export const SAFETY_PROFILE_CHOICES: readonly SafetyProfilePreset[] = [...SAFETY_PROFILE_PRESETS].sort(
	(a, b) => a.choiceOrder - b.choiceOrder,
);

const SAFETY_PROFILE_NAME_SET = new Set<string>(SAFETY_PROFILE_NAMES);
const SAFETY_PROFILE_PRESET_NAME_SET = new Set<string>(SAFETY_PROFILE_PRESET_NAMES);
const SAFETY_PROFILE_PRESET_BY_NAME = new Map<string, SafetyProfilePreset>(
	SAFETY_PROFILE_PRESETS.map((preset) => [preset.name, preset]),
);

export function isSafetyProfileName(value: string): value is SafetyProfileName {
	return SAFETY_PROFILE_NAME_SET.has(value);
}

export function isSafetyProfilePresetName(value: string | undefined): value is SafetyProfilePresetName {
	return Boolean(value && SAFETY_PROFILE_PRESET_NAME_SET.has(value));
}

export function profilePreset(name: string): SafetyProfilePreset | undefined {
	return SAFETY_PROFILE_PRESET_BY_NAME.get(name);
}

export function safetyProfileListText(): string {
	return SAFETY_PROFILE_CHOICES.map((preset) => preset.name).join(", ");
}

export function formatProfileName(profile: string): string {
	return profilePreset(profile)?.label ?? titleCase(profile);
}

export function safetyProfileStrictness(profile: SafetyProfileName): number {
	return profilePreset(profile)?.strictness ?? CUSTOM_PROFILE_STRICTNESS;
}

function profileDefinition(name: SafetyProfilePresetName): SafetyProfilePreset {
	return { name, ...SAFETY_PROFILE_DEFINITIONS[name] };
}

function titleCase(value: string): string {
	if (value.length === 0) return value;
	return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}
