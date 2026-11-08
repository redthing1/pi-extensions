import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SafetyController } from "../controller/controller.js";
import type { SaveSessionApprovalsResult } from "../reins/approval-manager.js";
import { SAFETY_PROFILE_CHOICES } from "../profiles/presets.js";
import { SafetyPanel } from "../ui/panel.js";

export interface SafetyCommandContext {
	controller: SafetyController;
	ctx: ExtensionCommandContext;
	updateStatus: (ctx: ExtensionCommandContext) => void;
}

export async function handleSafetyCommand(args: string, command: SafetyCommandContext): Promise<void> {
	const trimmed = args.trim();
	if (trimmed === "") {
		await openSafetyPanel(command);
		return;
	}
	if (trimmed === "status") {
		command.ctx.ui.notify(command.controller.statusText(), "info");
		return;
	}
	if (trimmed === "explain") {
		command.ctx.ui.notify(command.controller.explainText(), "info");
		return;
	}
	if (trimmed === "approvals") {
		command.ctx.ui.notify(command.controller.approvalsText(), "info");
		return;
	}
	if (trimmed === "forget") {
		await forgetApproval(command);
		return;
	}
	if (trimmed === "audit") {
		command.ctx.ui.notify(command.controller.auditStatusText(), "info");
		return;
	}
	if (trimmed === "profile") {
		await chooseProfile(command);
		return;
	}
	if (trimmed.startsWith("profile ")) {
		setProfile(command, trimmed.slice("profile ".length).trim());
		return;
	}
	command.ctx.ui.notify("Usage: /safety [status|profile|explain|approvals|forget|audit]", "info");
}

async function openSafetyPanel(command: SafetyCommandContext): Promise<void> {
	if (!command.ctx.hasUI) {
		command.ctx.ui.notify(command.controller.statusText(), "info");
		return;
	}
	await command.ctx.ui.custom<void>(
		(_tui, theme, keybindings, done) =>
			new SafetyPanel(
				theme,
				keybindings,
				() => ({
					policy: command.controller.policy(),
					paths: command.controller.paths(),
					clientZdr: command.controller.isClientZdr(),
					auditRecordingEnabled: command.controller.auditRecordingEnabled(),
					approvals: command.controller.approvalChoices(),
					saveableSessionApprovals: command.controller.saveableSessionApprovals(),
					containmentSupport: command.controller.containmentSupportText(),
				}),
				{
					onEnabledChange: (enabled) => {
						command.controller.setEnabled(enabled);
						command.updateStatus(command.ctx);
					},
					onProfileChange: (profile) => {
						setProfile(command, profile);
					},
					onReinsModeChange: (mode) => {
						command.controller.setReinsMode(mode);
						command.updateStatus(command.ctx);
					},
					onContainmentModeChange: (mode) => {
						command.controller.setContainmentMode(mode);
						command.updateStatus(command.ctx);
					},
					onNetworkChange: (network) => {
						command.controller.setNetworkMode(network);
						command.updateStatus(command.ctx);
					},
					onEnvironmentChange: (environment) => {
						command.controller.setEnvironmentMode(environment);
						command.updateStatus(command.ctx);
					},
					onForgetApproval: (choice) => {
						command.ctx.ui.notify(command.controller.forgetApproval(choice) ? `Forgot ${choice}` : `Could not forget ${choice}`, "info");
					},
					onSaveSessionApprovals: () => {
						const result = command.controller.saveSessionApprovalsToWorkspace();
						command.ctx.ui.notify(saveApprovalsMessage(result), result.kind === "unavailable" ? "warning" : "info");
					},
					onCancel: () => done(undefined),
				},
			),
	);
}

async function forgetApproval(command: SafetyCommandContext): Promise<void> {
	const choices = command.controller.approvalChoices();
	if (choices.length === 0) {
		command.ctx.ui.notify("Safety has no approvals to forget.", "info");
		return;
	}
	const choice = await command.ctx.ui.select("Forget Safety approval", choices);
	if (!choice) return;
	command.ctx.ui.notify(command.controller.forgetApproval(choice) ? `Forgot ${choice}` : `Could not forget ${choice}`, "info");
}

async function chooseProfile(command: SafetyCommandContext): Promise<void> {
	const labels = SAFETY_PROFILE_CHOICES.map((preset) => `${preset.label} - ${preset.description}`);
	const choice = await command.ctx.ui.select("Safety profile", labels);
	if (!choice) return;
	const index = labels.indexOf(choice);
	const preset = SAFETY_PROFILE_CHOICES[index];
	if (!preset) return;
	setProfile(command, preset.name);
}

function setProfile(command: SafetyCommandContext, profile: string): void {
	const result = command.controller.setProfile(profile);
	if (result.ok) {
		command.updateStatus(command.ctx);
		command.ctx.ui.notify(`Safety profile: ${result.profile}`, "info");
	} else {
		command.ctx.ui.notify(result.reason, "error");
	}
}

function saveApprovalsMessage(result: SaveSessionApprovalsResult): string {
	if (result.kind === "unavailable") return "Workspace approval persistence is disabled in ZDR mode.";
	if (result.count === 0) return "No new session approvals can be saved to this workspace.";
	return `Saved ${result.count} session approval${result.count === 1 ? "" : "s"} to this workspace.`;
}
