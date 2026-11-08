import { basename, relative } from "node:path";
import type {
	ContainmentMode,
	EffectiveSafetyPolicy,
	EnvironmentMode,
	NetworkMode,
	ReinsMode,
	SafetyProfileName,
} from "../config/types.js";
import { formatProfileName, SAFETY_PROFILE_CHOICES } from "../profiles/presets.js";
import type { ChoiceOption, SafetyPanelModel } from "./panel-types.js";

export const REINS_VALUES: ReinsMode[] = ["read-only", "accept-edits", "guarded", "observe", "off"];
export const CONTAINMENT_VALUES: ContainmentMode[] = ["read-only", "workspace-write", "off"];
export const NETWORK_VALUES: NetworkMode[] = ["none", "host"];
export const ENVIRONMENT_VALUES: EnvironmentMode[] = ["minimal", "safe", "inherit"];

export function panelSummary(model: SafetyPanelModel): string {
	const policy = model.policy;
	const profile = policy.enabled ? formatProfileName(policy.profile) : "Off";
	const persistence = model.clientZdr ? "ZDR, session only" : "workspace approvals";
	return `${profile} | ${policy.reins.mode} | ${policy.containment.mode} | net ${policy.containment.network} | ${persistence}`;
}

export function profileValue(profile: SafetyProfileName): string {
	return formatProfileName(profile);
}

export function profileOptions(): ChoiceOption[] {
	return SAFETY_PROFILE_CHOICES.map((preset) => ({
		value: preset.name,
		label: preset.label,
		description: `${preset.description} Reins ${preset.reinsMode}; containment ${preset.containmentMode}; network ${preset.network}.`,
	}));
}

export function valueOptions(values: string[]): ChoiceOption[] {
	return values.map((value) => ({ value, label: value }));
}

export function workspaceSummary(path: string): string {
	return basename(path) || path;
}

export function workspaceDetails(policy: EffectiveSafetyPolicy): string[] {
	return [`Workspace root: ${policy.workspaceRoot}`];
}

export function auditDetails(model: SafetyPanelModel): string[] {
	if (model.clientZdr) return ["Audit recording disabled by ZDR", "", "No Safety audit events are written for this session."];
	return [
		`Audit recording ${model.auditRecordingEnabled ? "enabled" : "disabled by configuration"}`,
		"",
		`Directory: ${model.paths.auditDir}`,
	];
}

export function configDetails(model: SafetyPanelModel): string[] {
	const policy = model.policy;
	const paths = policy.configPaths.length > 0 ? policy.configPaths : ["defaults only"];
	return [
		`User config: ${model.paths.userConfigPath}`,
		`Project config: ${model.paths.projectConfigPath}`,
		"",
		"Active sources:",
		...paths,
	];
}

export function writeRoots(policy: EffectiveSafetyPolicy): string[] {
	return policy.containment.mode === "read-only" ? ["disabled by read-only containment"] : policy.containment.filesystem.write;
}

export function writeSummary(policy: EffectiveSafetyPolicy): string {
	if (policy.containment.mode === "read-only") return "disabled";
	return summarizeList(policy.containment.filesystem.write);
}

export function summarizeList(values: string[]): string {
	if (values.length === 0) return "none";
	if (values.length === 1) return values[0] ?? "none";
	return `${values[0]}, +${values.length - 1}`;
}

export function approvalSummary(approvals: string[]): string {
	if (approvals.length === 0) return "none";
	return `${approvals.length} active`;
}

export function configSummary(policy: EffectiveSafetyPolicy): string {
	if (policy.configPaths.length === 0) return "defaults";
	const labels = new Set(policy.configPaths.map((path) => configLabel(path, policy.workspaceRoot)));
	return Array.from(labels).join(" + ");
}

export function detailLines(values: string[]): string[] {
	return values.length > 0 ? values : ["none"];
}

export function deniedCommandLines(policy: EffectiveSafetyPolicy): string[] {
	return detailLines(policy.denyCommandPrefixes.map((prefix) => prefix.join(" ")));
}

function configLabel(path: string, workspaceRoot: string): string {
	const projectPath = relative(workspaceRoot, path);
	if (projectPath === ".pi/safety.json") return "project";
	if (path.endsWith("/safety/config.json")) return "user";
	return "custom";
}
