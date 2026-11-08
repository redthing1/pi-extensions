import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSafetyConfig } from "../src/config/load.js";
import { checkAuthorizationFlow } from "./check/authorization-flow.js";
import { checkConfig } from "./check/config.js";
import { checkContainment } from "./check/containment.js";
import { checkControllerSessionSettings } from "./check/controller.js";
import { checkGrants } from "./check/grants.js";
import { checkNumberShortcuts } from "./check/number-shortcuts.js";
import { checkProfiles } from "./check/profiles.js";
import { checkReins } from "./check/reins.js";
import { checkShellClassifier } from "./check/shell.js";
import { checkToolClassifier } from "./check/tools.js";
import { checkChildContext } from "./check/child-context.js";

async function main(): Promise<void> {
	const fixture = realpathSync(mkdtempSync(join(tmpdir(), "pi-safety-check-")));
	try {
		const agentDir = join(fixture, "agent");
		const cwd = join(fixture, "workspace");
		mkdirSync(agentDir);
		mkdirSync(cwd);
		execFileSync("git", ["init", "--quiet", cwd]);
		execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "--allow-empty", "-m", "Synthetic fixture"], { cwd });
		const loaded = loadSafetyConfig({ agentDir, cwd, enabledOverride: true });
		const context = { agentDir, cwd, loaded };

		checkProfiles();
		checkConfig(context);
		checkNumberShortcuts();
		checkShellClassifier(context);
		checkToolClassifier();
		checkReins(context);
		await checkAuthorizationFlow(context);
		checkGrants(context);
		checkControllerSessionSettings(context);
		await checkContainment(context);
		await checkChildContext();

		console.log("safety check: ok");
	} finally {
		rmSync(fixture, { recursive: true, force: true });
	}
}

await main();
