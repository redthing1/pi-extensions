import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { loadSafetyConfig } from "../../src/config/load.js";
import { readRootsForPolicy, writeRootsForPolicy } from "../../src/containment/filesystem.js";
import { buildLinuxCommand } from "../../src/containment/linux.js";
import { quoteShellArg } from "../../src/containment/shell.js";
import { containmentSupport } from "../../src/containment/support.js";
import { canonicalPath } from "../../src/paths/normalize.js";
import { assert } from "./assert.js";
import type { CheckContext } from "./context.js";
import { runContainedCommand } from "./process.js";
import type { CommandResult } from "../util/process.js";

export async function checkContainment({ agentDir, cwd }: CheckContext): Promise<void> {
	const exploreLoaded = loadSafetyConfig({ agentDir, cwd, enabledOverride: true, profileOverride: "explore" });
	const codeLoaded = loadSafetyConfig({ agentDir, cwd, enabledOverride: true, profileOverride: "code" });
	checkConfiguredRootAliases(agentDir);
	checkMissingConfiguredRoots(codeLoaded.policy);
	checkConfiguredLinuxShell(codeLoaded.policy);
	const support = containmentSupport(exploreLoaded.policy);
	if (!support.available || !support.backend) return;

	const markerPath = join(tmpdir(), `pi-safety-check-marker-${process.pid}`);
	const marker = "PI_SAFETY_CHECK_MARKER_SHOULD_NOT_BE_VISIBLE";
	const protectedMarkerPath = join(cwd, `.pi-safety-check-secret-${process.pid}`);
	const protectedMarker = "PI_SAFETY_CHECK_PROTECTED_SHOULD_NOT_BE_VISIBLE";
	const protectedDir = join(cwd, `.pi-safety-check-secret-dir-${process.pid}`);
	const protectedDirMarkerPath = join(protectedDir, "secret.txt");
	const protectedDirMarker = "PI_SAFETY_CHECK_PROTECTED_DIR_SHOULD_NOT_BE_VISIBLE";
	writeFileSync(markerPath, `${marker}\n`, "utf-8");
	writeFileSync(protectedMarkerPath, `${protectedMarker}\n`, "utf-8");
	mkdirSync(protectedDir);
	writeFileSync(protectedDirMarkerPath, `${protectedDirMarker}\n`, "utf-8");
	try {
		let result = await runContainedCommand("pwd", cwd, exploreLoaded.policy, support.backend);
		assertContained(result, result.output.includes(cwd), "contained pwd should run in cwd");

		result = await runContainedCommand("git status --short", cwd, exploreLoaded.policy, support.backend);
		assertContained(result, result.exitCode === 0, "contained git status should be able to read cwd and temp git config paths");

		result = await runContainedCommand("git log --oneline -1 >/dev/null && echo git-log-ok", cwd, exploreLoaded.policy, support.backend);
		assertContained(result, result.exitCode === 0 && result.output.includes("git-log-ok"), "contained git log should run");

		result = await runContainedCommand("bun -e 'console.log(process.cwd())'", cwd, exploreLoaded.policy, support.backend);
		assertContained(result, result.exitCode === 0 && result.output.includes(cwd), "contained bun should read current directory");

		const protectedPolicy = { ...exploreLoaded.policy, protectedPaths: [protectedMarkerPath] };
		result = await runContainedCommand(`cat ${protectedMarkerPath}`, cwd, protectedPolicy, support.backend);
		assertContained(result, result.exitCode !== 0, "contained cat of protected workspace file should fail");
		assertContained(result, !result.output.includes(protectedMarker), "contained cat of protected workspace file should not leak marker content");

		const protectedDirPolicy = { ...exploreLoaded.policy, protectedPaths: [`${protectedDir}/**`] };
		result = await runContainedCommand(`cat ${protectedDirMarkerPath}`, cwd, protectedDirPolicy, support.backend);
		assertContained(result, result.exitCode !== 0, "contained cat under protected workspace directory should fail");
		assertContained(result, !result.output.includes(protectedDirMarker), "contained cat under protected workspace directory should not leak marker content");

		if (support.backend === "darwin-seatbelt") {
			await checkDarwinUserTempIsolation(cwd, exploreLoaded.policy);
			if (process.env.SDKROOT) {
				result = await runContainedCommand('printf "%s" "$SDKROOT"', cwd, exploreLoaded.policy, support.backend);
				assertContained(result, result.exitCode === 0 && result.output === process.env.SDKROOT, "containment should preserve the explicitly selected SDK");
			}
			result = await runContainedCommand("xcrun --find c++ >/dev/null && c++ --version >/dev/null && echo developer-tools-ok", cwd, exploreLoaded.policy, support.backend);
			assertContained(result, result.exitCode === 0 && result.output.includes("developer-tools-ok"), "contained Darwin developer tools should be able to use xcrun cache paths");
			assertContained(result, !result.output.includes("couldn't create cache file"), "xcrun cache writes should not be denied");

			const sourcePath = join(cwd, `.pi-safety-xcrun-${process.pid}.cpp`);
			const outputPath = join(cwd, `.pi-safety-xcrun-${process.pid}`);
			writeFileSync(sourcePath, "int main() { return 0; }\n", "utf-8");
			try {
				result = await runContainedCommand(
					`c++ ${quoteShellArg(sourcePath)} -o ${quoteShellArg(outputPath)} && ${quoteShellArg(outputPath)} && echo developer-compile-ok`,
					cwd,
					codeLoaded.policy,
					support.backend,
				);
				assertContained(result, result.exitCode === 0 && result.output.includes("developer-compile-ok"), "contained Darwin compiler should be able to update xcrun cache paths");
				assertContained(result, !result.output.includes("couldn't create cache file"), "compiler xcrun cache writes should not be denied");
			} finally {
				rmSync(sourcePath, { force: true });
				rmSync(outputPath, { force: true });
			}
		}

		result = await runContainedCommand(`cat ${markerPath}`, cwd, exploreLoaded.policy, support.backend);
		assertContained(result, result.exitCode !== 0, "contained cat of /tmp marker should fail");
		assertContained(result, !result.output.includes(marker), "contained cat of /tmp marker should not leak marker content");

		await checkNetworkContainment(agentDir, cwd, support.backend);
	} finally {
		rmSync(markerPath, { force: true });
		rmSync(protectedMarkerPath, { force: true });
		rmSync(protectedDir, { recursive: true, force: true });
	}
}

async function checkDarwinUserTempIsolation(
	cwd: string,
	policy: ReturnType<typeof loadSafetyConfig>["policy"],
): Promise<void> {
	const userTemp = realpathSync(
		execFileSync("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], { encoding: "utf8" }).trim(),
	);
	const fixture = mkdtempSync(join(userTemp, "pi-safety-developer-"));
	const markerPath = join(fixture, "marker.txt");
	const marker = "SAFETY_USER_TEMP_MUST_STAY_PRIVATE";
	writeFileSync(markerPath, marker, { mode: 0o600 });
	try {
		const result = await runContainedCommand(`cat ${quoteShellArg(markerPath)}`, cwd, policy, "darwin-seatbelt");
		assertContained(
			result,
			result.exitCode !== 0 && !result.output.includes(marker),
			"xcrun access must not expose unrelated user-temp files",
		);
		const write = await runContainedCommand(
			`touch ${quoteShellArg(join(fixture, "written.txt"))}`,
			cwd,
			policy,
			"darwin-seatbelt",
		);
		assertContained(write, write.exitCode !== 0, "xcrun access must not permit unrelated user-temp writes");
	} finally {
		rmSync(fixture, { recursive: true, force: true });
	}
}

function checkMissingConfiguredRoots(policy: ReturnType<typeof loadSafetyConfig>["policy"]): void {
	const missingRoot = join(tmpdir(), `pi-safety-missing-root-${process.pid}`);
	const configured = {
		...policy,
		containment: {
			...policy.containment,
			filesystem: { read: [...policy.containment.filesystem.read, missingRoot], write: [missingRoot] },
		},
	};
	assert(!readRootsForPolicy(configured, "linux").includes(missingRoot), "missing read roots should not become bind sources");
	assert(!writeRootsForPolicy(configured).includes(missingRoot), "missing write roots should not become bind sources");
}

function checkConfiguredLinuxShell(policy: ReturnType<typeof loadSafetyConfig>["policy"]): void {
	const command = buildLinuxCommand("printf shell-ok", policy, policy.workspaceRoot, "/bin/sh").command;
	assert(command.includes("'/bin/sh' '-c' 'printf shell-ok'"), "Linux containment should preserve the configured inner shell");
}

function checkConfiguredRootAliases(agentDir: string): void {
	const tempCwd = tmpdir();
	const absolute = resolve(tempCwd);
	const real = canonicalPath(absolute);
	if (absolute === real) return;
	const loaded = loadSafetyConfig({ agentDir, cwd: absolute, enabledOverride: true, profileOverride: "explore" });
	const roots = readRootsForPolicy(loaded.policy, process.platform);
	assert(roots.includes(absolute), "containment read roots should include the configured root spelling");
	assert(roots.includes(real), "containment read roots should include the configured root realpath");
}

function assertContained(result: CommandResult, condition: boolean, message: string): asserts condition {
	assert(condition, `${message}; exit=${result.exitCode}; output=${JSON.stringify(result.output)}`);
}

async function checkNetworkContainment(agentDir: string, cwd: string, backend: NonNullable<ReturnType<typeof containmentSupport>["backend"]>): Promise<void> {
	const server = await startLoopbackServer();
	try {
		const address = server.address() as AddressInfo;
		const url = `http://127.0.0.1:${address.port}/`;
		const command = `bun -e "const r=await fetch('${url}'); console.log(await r.text())"`;

		const hostPolicy = loadSafetyConfig({
			agentDir,
			cwd,
			enabledOverride: true,
			profileOverride: "guarded",
			networkOverride: "host",
		}).policy;
		const hostResult = await runContainedCommand(command, cwd, hostPolicy, backend);
		assertContained(hostResult, hostResult.exitCode === 0 && hostResult.output.includes("SAFETY_NETWORK_OK"), "network host should reach loopback server");

		const nonePolicy = loadSafetyConfig({
			agentDir,
			cwd,
			enabledOverride: true,
			profileOverride: "guarded",
			networkOverride: "none",
		}).policy;
		const noneResult = await runContainedCommand(command, cwd, nonePolicy, backend);
		assertContained(noneResult, noneResult.exitCode !== 0 || !noneResult.output.includes("SAFETY_NETWORK_OK"), "network none should not reach loopback server");
	} finally {
		await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
	}
}

function startLoopbackServer(): Promise<Server> {
	const server = createServer((_request, response) => {
		response.writeHead(200, { "content-type": "text/plain" });
		response.end("SAFETY_NETWORK_OK\n");
	});
	return new Promise((resolveServer, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolveServer(server);
		});
	});
}
