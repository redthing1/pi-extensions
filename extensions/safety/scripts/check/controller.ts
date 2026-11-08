import { loadSafetyConfig } from "../../src/config/load.js";
import { SafetyController } from "../../src/controller/controller.js";
import {
	setPolicyContainmentMode,
	setPolicyEnvironmentMode,
	setPolicyNetworkMode,
	setPolicyReinsMode,
} from "../../src/config/session-settings.js";
import { assert } from "./assert.js";
import type { CheckContext } from "./context.js";

export function checkControllerSessionSettings({ agentDir, cwd }: CheckContext): void {
	const { policy } = loadSafetyConfig({ agentDir, cwd, enabledOverride: true });

	setPolicyReinsMode(policy, "off");
	setPolicyContainmentMode(policy, "off");
	setPolicyNetworkMode(policy, "host");
	setPolicyEnvironmentMode(policy, "inherit");
	const offProfile = policy.profile;
	assert(offProfile === "off", "manual off settings should infer off profile");
	assert(!policy.enabled, "manual off settings should disable Safety");

	setPolicyReinsMode(policy, "guarded");
	const watchProfile = policy.profile;
	assert(watchProfile === "watch", "manual guarded Reins without containment should infer watch profile");
	assert(policy.enabled, "manual watch settings should enable Safety");

	setPolicyReinsMode(policy, "read-only");
	const customProfile = policy.profile;
	assert(customProfile === "custom", "manual non-preset settings should infer custom profile");
	assert(policy.enabled, "manual non-off settings should enable Safety");

	const active = SafetyController.create({
		agentDir,
		cwd,
		clientZdr: false,
		enabledOverride: true,
		profileOverride: "watch",
	});
	active.setNetworkMode("none");
	active.setEnabled(false);
	const rebuilt = SafetyController.create({
		agentDir,
		cwd,
		clientZdr: false,
		enabledOverride: true,
		profileOverride: "code",
		sessionSettings: active.sessionSettingsSnapshot(),
	});
	assert(
		!rebuilt.policy().enabled,
		"rebuilding a controller should preserve the live disabled state",
	);
	assert(
		rebuilt.policy().containment.network === "none",
		"rebuilding a controller should preserve live session settings",
	);
}
