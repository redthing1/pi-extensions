import { homedir } from "node:os";
import { join } from "node:path";
import { loadSafetyConfig } from "../../src/config/load.js";
import { applyProjectTightening, mergeUserConfig } from "../../src/config/merge.js";
import { classifyPathAccess } from "../../src/paths/classify.js";
import { safetyStatusLine } from "../../src/ui/status.js";
import { assert } from "./assert.js";
import type { CheckContext } from "./context.js";

export function checkConfig({ agentDir, loaded }: CheckContext): void {
	assert(loaded.policy.enabled, "enabled override should enable Safety");
	assert(loaded.policy.profile === "code", "default profile should be code");
	assert(loaded.policy.containment.network === "none", "default network should be none");
	assert(loaded.policy.containment.filesystem.read.includes(join(agentDir, "skills")), "global pi skills should be readable");
	assert(loaded.policy.containment.filesystem.read.includes(join(homedir(), ".agents", "skills")), "global agent skills should be readable");
	assert(!loaded.policy.containment.filesystem.write.includes(join(agentDir, "skills")), "global pi skills should not be writable");
	assert(!loaded.policy.containment.filesystem.write.includes(join(homedir(), ".agents", "skills")), "global agent skills should not be writable");
	assert(loaded.workspaceStatePath.includes("/safety/workspaces/"), "workspace state path should be user-owned");

	const userConfig = mergeUserConfig({ profile: "explore" }, false);
	assert(userConfig.profile === "explore", "user profile should apply");
	assert(userConfig.reins.mode === "read-only", "explore should set read-only Reins");

	const watchConfig = mergeUserConfig({ profile: "watch" }, false);
	assert(watchConfig.profile === "watch", "watch profile should apply");
	assert(watchConfig.reins.mode === "guarded", "watch should ask through guarded Reins");
	assert(watchConfig.containment.mode === "off", "watch should not use containment");
	assert(watchConfig.containment.network === "host", "watch should keep host networking");

	const custom = loadSafetyConfig({
		agentDir,
		cwd: loaded.policy.workspaceRoot,
		enabledOverride: true,
		profileOverride: "watch",
		reinsModeOverride: "off",
		containmentModeOverride: "workspace-write",
		networkOverride: "none",
	});
	assert(custom.policy.profile === "custom", "CLI mode overrides should infer a custom profile");
	assert(
		safetyStatusLine(custom.policy) === "Safety: Custom | off, workspace-write, net none",
		"status should describe effective CLI overrides",
	);

	const tightened = applyProjectTightening(userConfig, {
		require: { network: "none" },
		protect: { paths: ["private/**"] },
		deny: { commandPrefixes: [["git", "push", "--force"]] },
	});
	assert(tightened.containment.network === "none", "project config can require network none");
	assert(tightened.protectedPaths.includes("private/**"), "project config can add protected paths");
	assert(tightened.denyCommandPrefixes.length === 1, "project config can add deny prefixes");

	const syntheticPrivateName = ".pi-safety-synthetic-private";
	const syntheticPrivatePath = join(homedir(), syntheticPrivateName);
	const protectedPolicy = { ...loaded.policy, protectedPaths: [syntheticPrivatePath] };
	for (const spelling of [
		`~/${syntheticPrivateName}`,
		`~//${syntheticPrivateName}`,
		`$HOME//${syntheticPrivateName}`,
		`\${HOME}//${syntheticPrivateName}`,
	]) {
		const access = classifyPathAccess(protectedPolicy, "read", spelling);
		assert(access.absolutePath === syntheticPrivatePath, `${spelling} should canonicalize inside HOME`);
		assert(access.protected && !access.allowed, `${spelling} should remain protected after canonicalization`);
	}
}
