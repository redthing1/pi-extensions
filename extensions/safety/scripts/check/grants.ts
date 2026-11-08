import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyPathAccess } from "../../src/paths/classify.js";
import { SessionGrantStore } from "../../src/reins/grants.js";
import { WorkspaceGrantStore } from "../../src/reins/workspace-grants.js";
import { analyzeShellCommand } from "../../src/shell/classify.js";
import { pathGrantRootsForBlockedPaths } from "../../src/reins/path-access.js";
import { assert } from "./assert.js";
import type { CheckContext } from "./context.js";

export function checkGrants({ cwd, loaded }: CheckContext): void {
	const tempDir = mkdtempSync(join(tmpdir(), "pi-safety-check-"));
	try {
		const grantPath = join(tempDir, "workspace.json");
		const store = new WorkspaceGrantStore(grantPath, cwd);
		store.addCommandPrefix(["bun", "run", "check"], "check script");
		store.addCommandFamily(
			{
				type: "commandFamily",
				family: "cmake.build",
				pathScope: "workspace",
				description: "cmake --build <workspace path> *",
				scopes: ["session", "workspace"],
			},
			"cmake build",
		);

		const reloaded = new WorkspaceGrantStore(grantPath, cwd);
		const coverage = reloaded.coversShell(analyzeShellCommand("bun run check"), cwd);
		assert(coverage !== undefined && coverage.length === 1, "workspace grant should persist and match");

		const cmakeBuildCoverage = reloaded.coversShell(analyzeShellCommand(`cd ${cwd} && cmake --build build-release --parallel`), cwd);
		assert(cmakeBuildCoverage !== undefined && cmakeBuildCoverage.some((grant) => grant.type === "commandFamily"), "cmake build family should match workspace builds");

		const cmakeToolModeCoverage = reloaded.coversShell(analyzeShellCommand("cmake -E env"), cwd);
		assert(cmakeToolModeCoverage === undefined, "cmake family grant should not cover cmake tool mode");

		const cmakeInstallCoverage = reloaded.coversShell(analyzeShellCommand("cmake --install /tmp/build"), cwd);
		assert(cmakeInstallCoverage === undefined, "cmake family grant should not cover installs");

		const cmakeInstallTargetCoverage = reloaded.coversShell(analyzeShellCommand("cmake --build build-release --target install"), cwd);
		assert(cmakeInstallTargetCoverage === undefined, "cmake family grant should not cover install targets");

		const cmakeOutsideCoverage = reloaded.coversShell(analyzeShellCommand("cmake --build /tmp/pi-build"), cwd);
		assert(cmakeOutsideCoverage === undefined, "cmake family grant should not cover outside-workspace build dirs");

		const cmakeGlobCoverage = reloaded.coversShell(analyzeShellCommand("cmake --build build-*"), cwd);
		assert(cmakeGlobCoverage === undefined, "cmake family grant should not cover globbed build dirs");

		const cmakeMissingBuildDirCoverage = reloaded.coversShell(analyzeShellCommand("cmake --build --parallel"), cwd);
		assert(cmakeMissingBuildDirCoverage === undefined, "cmake family grant should not cover missing build dirs");

		const dangerousCoverage = reloaded.coversShell(analyzeShellCommand("bun run check && rm -rf ~"), cwd);
		assert(dangerousCoverage === undefined, "workspace grant should not cover dangerous compound command");

		const session = new SessionGrantStore(cwd);
		const downloads = classifyPathAccess(loaded.policy, "list", "~/Downloads");
		session.addPathAccess(
			{
				type: "pathAccess",
				roots: [downloads.absolutePath],
				operations: ["list"],
				sensitivity: "privacy",
				description: "list ~/Downloads",
				scopes: ["session"],
			},
			"privacy approval",
		);
		const pathCoverage = session.coversPaths([downloads]);
		assert(pathCoverage !== undefined && pathCoverage.length === 1, "session path grant should cover privacy path");

		const secret = classifyPathAccess(loaded.policy, "read", "~/.zsh_history");
		assert(session.coversPaths([secret]) === undefined, "session path grants should not cover secret paths");

		const notesDir = join(tempDir, "notes");
		const notesFile = join(notesDir, "a.txt");
		const secondNotesFile = join(notesDir, "b.txt");
		mkdirSync(notesDir);
		writeFileSync(notesFile, "a\n", "utf-8");
		writeFileSync(secondNotesFile, "b\n", "utf-8");
		const normalRead = classifyPathAccess(loaded.policy, "read", notesFile);
		const normalRoot = realpathSync(notesDir);
		const directoryWrite = classifyPathAccess(loaded.policy, "write", notesDir);
		assert(
			pathGrantRootsForBlockedPaths([directoryWrite]).join(",") === normalRoot,
			"a write-capable child cwd should grant the existing directory itself",
		);
		const nonCanonicalRoot = join(notesDir, "..", "notes");
		const sessionPathGrant = session.addPathAccess(
			{
				type: "pathAccess",
				roots: [nonCanonicalRoot],
				operations: ["read"],
				sensitivity: "normal",
				description: `read ${nonCanonicalRoot}`,
				scopes: ["session", "workspace"],
			},
			"normal path approval",
		);
		assert(sessionPathGrant.roots.includes(normalRoot), "session path grants should normalize root spellings");
		assert(session.coversPaths([normalRead])?.length === 1, "session path grant should cover normal outside paths");

		const workspacePathGrant = store.addPathAccess(
			{
				type: "pathAccess",
				roots: [nonCanonicalRoot],
				operations: ["read"],
				sensitivity: "normal",
				description: `read ${nonCanonicalRoot}`,
				scopes: ["session", "workspace"],
			},
			"normal workspace path approval",
		);
		assert(workspacePathGrant?.type === "pathAccess", "workspace store should persist normal path grants");
		assert(workspacePathGrant.roots.includes(normalRoot), "workspace path grants should normalize root spellings");
		const workspacePrivacyPathGrant = store.addPathAccess(
			{
				type: "pathAccess",
				roots: [downloads.absolutePath],
				operations: ["list"],
				sensitivity: "privacy",
				description: "list ~/Downloads",
				scopes: ["session"],
			},
			"privacy workspace path approval",
		);
		assert(workspacePrivacyPathGrant === undefined, "workspace store should reject privacy path grants");

		const reloadedPathStore = new WorkspaceGrantStore(grantPath, cwd);
		const secondNormalRead = classifyPathAccess(loaded.policy, "read", secondNotesFile);
		assert(
			reloadedPathStore.coversPaths([secondNormalRead])?.length === 1,
			"workspace path grant should persist and cover sibling files under the granted directory",
		);
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
}
