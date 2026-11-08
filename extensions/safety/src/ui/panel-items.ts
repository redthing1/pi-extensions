import type { Component, SettingItem, SettingsList } from "@earendil-works/pi-tui";
import type { ChoiceOption, SafetyPanelModel } from "./panel-types.js";
import {
	approvalSummary,
	auditDetails,
	configDetails,
	configSummary,
	CONTAINMENT_VALUES,
	deniedCommandLines,
	detailLines,
	ENVIRONMENT_VALUES,
	NETWORK_VALUES,
	profileOptions,
	profileValue,
	REINS_VALUES,
	summarizeList,
	valueOptions,
	workspaceDetails,
	workspaceSummary,
	writeRoots,
	writeSummary,
} from "./panel-format.js";

export interface SafetyPanelViews {
	detail(title: string, lines: string[], done: () => void): Component;
	choice(title: string, choices: ChoiceOption[], done: (selectedValue?: string) => void, initialValue?: string): Component;
}

export function safetyPanelItems(model: SafetyPanelModel, views: SafetyPanelViews): SettingItem[] {
	const policy = model.policy;
	return [
		{
			id: "enabled",
			label: "Enabled",
			description: "Enable or disable Safety for this session. This does not write config files.",
			currentValue: String(policy.enabled),
			values: ["true", "false"],
		},
		{
			id: "profile",
			label: "Profile",
			description: "Choose the high-level Safety posture.",
			currentValue: profileValue(policy.profile),
			submenu: (_currentValue, done) => views.choice("Profile", profileOptions(), done, policy.profile),
		},
		{
			id: "workspace",
			label: "Workspace",
			description: model.clientZdr
				? "Workspace root used for path policy; persistent approvals and audit are disabled by ZDR."
				: "Workspace root used for path policy, audit context, and workspace approvals.",
			currentValue: workspaceSummary(policy.workspaceRoot),
			submenu: (_currentValue, done) => views.detail("Workspace", workspaceDetails(policy), done),
		},
		{
			id: "reins",
			label: "Reins",
			description: "Permission decision mode for tools and commands. Changing this makes the profile custom unless it matches a preset.",
			currentValue: policy.reins.mode,
			values: REINS_VALUES,
		},
		{
			id: "containment",
			label: "Containment",
			description: "OS-backed sandbox mode for shell execution. Changing this makes the profile custom unless it matches a preset.",
			currentValue: policy.containment.mode,
			values: CONTAINMENT_VALUES,
		},
		{
			id: "network",
			label: "Network",
			description: "Network posture for contained shell commands.",
			currentValue: policy.containment.network,
			values: NETWORK_VALUES,
		},
		{
			id: "environment",
			label: "Environment",
			description: "Environment variables visible to contained shell commands.",
			currentValue: policy.containment.environment,
			values: ENVIRONMENT_VALUES,
		},
		{
			id: "read-roots",
			label: "Read roots",
			description: "Filesystem roots readable by containment and Reins path policy.",
			currentValue: summarizeList(policy.containment.filesystem.read),
			submenu: (_currentValue, done) => views.detail("Read roots", detailLines(policy.containment.filesystem.read), done),
		},
		{
			id: "write-roots",
			label: "Write roots",
			description: "Filesystem roots writable in workspace-write containment.",
			currentValue: writeSummary(policy),
			submenu: (_currentValue, done) => views.detail("Write roots", detailLines(writeRoots(policy)), done),
		},
		{
			id: "protected",
			label: "Protected paths",
			description: "Sensitive paths blocked even when their parent is otherwise allowed.",
			currentValue: `${policy.protectedPaths.length} rules`,
			submenu: (_currentValue, done) => views.detail("Protected paths", detailLines(policy.protectedPaths), done),
		},
		{
			id: "deny-prefixes",
			label: "Denied commands",
			description: "Command prefixes blocked before approval or containment.",
			currentValue: `${policy.denyCommandPrefixes.length} prefixes`,
			submenu: (_currentValue, done) => views.detail("Denied command prefixes", deniedCommandLines(policy), done),
		},
		{
			id: "approvals",
			label: "Approvals",
			description: model.clientZdr
				? "In-memory approvals for this session; open to forget one."
				: "Session and workspace approvals; open to forget one.",
			currentValue: approvalSummary(model.approvals),
			submenu: (_currentValue, done) => views.choice("Forget approval", valueOptions(model.approvals), done),
		},
		model.clientZdr
			? {
					id: "save-approvals",
					label: "Save approvals",
					description: "Workspace approval persistence is disabled in ZDR mode.",
					currentValue: "disabled by ZDR",
					submenu: (_currentValue, done) =>
						views.detail("Save approvals", ["Workspace approval persistence is disabled in ZDR mode."], done),
				}
			: {
					id: "save-approvals",
					label: "Save approvals",
					description: "Copy eligible session approvals to this workspace on this machine.",
					currentValue: saveableApprovalsSummary(model.saveableSessionApprovals),
					values: ["save"],
				},
		{
			id: "containment-support",
			label: "Sandbox backend",
			description: "Host backend available for containment.",
			currentValue: model.containmentSupport,
			submenu: (_currentValue, done) => views.detail("Sandbox backend", [model.containmentSupport], done),
		},
		{
			id: "audit",
			label: "Audit",
			description: "Audit status and log location.",
			currentValue: model.clientZdr ? "disabled by ZDR" : model.auditRecordingEnabled ? "enabled" : "disabled",
			submenu: (_currentValue, done) => views.detail("Audit", auditDetails(model), done),
		},
		{
			id: "config",
			label: "Config",
			description: "Config sources used to build the effective policy.",
			currentValue: configSummary(policy),
			submenu: (_currentValue, done) => views.detail("Config", configDetails(model), done),
		},
		{
			id: "warnings",
			label: "Warnings",
			description: "Config or support warnings discovered while loading Safety.",
			currentValue: `${policy.warnings.length}`,
			submenu: (_currentValue, done) => views.detail("Warnings", detailLines(policy.warnings), done),
		},
		{ id: "close", label: "Close", description: "Close the Safety panel.", currentValue: "", values: ["close"] },
	];
}

export function updateSafetyPanelValues(settingsList: SettingsList, model: SafetyPanelModel): void {
	const policy = model.policy;
	settingsList.updateValue("enabled", String(policy.enabled));
	settingsList.updateValue("profile", profileValue(policy.profile));
	settingsList.updateValue("workspace", workspaceSummary(policy.workspaceRoot));
	settingsList.updateValue("reins", policy.reins.mode);
	settingsList.updateValue("containment", policy.containment.mode);
	settingsList.updateValue("network", policy.containment.network);
	settingsList.updateValue("environment", policy.containment.environment);
	settingsList.updateValue("read-roots", summarizeList(policy.containment.filesystem.read));
	settingsList.updateValue("write-roots", writeSummary(policy));
	settingsList.updateValue("protected", `${policy.protectedPaths.length} rules`);
	settingsList.updateValue("deny-prefixes", `${policy.denyCommandPrefixes.length} prefixes`);
	settingsList.updateValue("approvals", approvalSummary(model.approvals));
	settingsList.updateValue("save-approvals", model.clientZdr ? "disabled by ZDR" : saveableApprovalsSummary(model.saveableSessionApprovals));
	settingsList.updateValue("containment-support", model.containmentSupport);
	settingsList.updateValue("audit", model.clientZdr ? "disabled by ZDR" : model.auditRecordingEnabled ? "enabled" : "disabled");
	settingsList.updateValue("config", configSummary(policy));
	settingsList.updateValue("warnings", `${policy.warnings.length}`);
}

function saveableApprovalsSummary(count: number | undefined): string {
	if (count === undefined) return "disabled";
	return count === 0 ? "none" : `${count} new`;
}
