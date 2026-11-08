import type { EffectiveSafetyPolicy } from "../config/types.js";
import { formatProfileName, profilePreset } from "../profiles/presets.js";

export interface StatusTheme {
	fg(color: string, text: string): string;
}

export function safetyStatusLine(policy: EffectiveSafetyPolicy): string | undefined {
	if (!policy.enabled) return undefined;
	return `Safety: ${formatProfileName(policy.profile)} | ${modeSummary(policy)}`;
}

export function themedSafetyStatusLine(policy: EffectiveSafetyPolicy, theme: StatusTheme | undefined): string | undefined {
	const line = safetyStatusLine(policy);
	if (!line || !theme) return line;
	return `${theme.fg("accent", `Safety: ${formatProfileName(policy.profile)}`)} ${theme.fg("dim", "|")} ${theme.fg("dim", modeSummary(policy))}`;
}

export function formatPolicyStatus(policy: EffectiveSafetyPolicy): string {
	const configLines = policy.configPaths.length > 0 ? policy.configPaths.map((path) => `  - ${path}`) : ["  - defaults only"];
	const warningLines = policy.warnings.length > 0 ? policy.warnings.map((warning) => `  - ${warning}`) : ["  - none"];
	return [
		`Safety: ${policy.enabled ? formatProfileName(policy.profile) : "off"}`,
		`Workspace: ${policy.workspaceRoot}`,
		`Reins: ${policy.reins.mode}`,
		`Containment: ${policy.containment.mode}, network ${policy.containment.network}, env ${policy.containment.environment}`,
		`Filesystem: read ${policy.containment.filesystem.read.join(", ")}, write ${policy.containment.filesystem.write.join(", ")}`,
		`Protected paths: ${policy.protectedPaths.length}`,
		`Deny command prefixes: ${policy.denyCommandPrefixes.length}`,
		"Config:",
		...configLines,
		"Warnings:",
		...warningLines,
	].join("\n");
}

function modeSummary(policy: EffectiveSafetyPolicy): string {
	return profilePreset(policy.profile)?.statusSummary ?? `${policy.reins.mode}, ${policy.containment.mode}, net ${policy.containment.network}`;
}
