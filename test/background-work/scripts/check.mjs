import {
	mkdtempSync,
	mkdirSync,
	rmSync,
	writeFileSync,
	readFileSync,
	existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const checkout = process.env.PI_BACKGROUND_CHECKOUT;
if (!checkout)
	throw new Error("PI_BACKGROUND_CHECKOUT must name the Pi checkout");
const root = fileURLToPath(new URL("..", import.meta.url));
const fixture = mkdtempSync(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "pi-background-check-"));
try {
	for (const name of ["home", "agent", "tmp"])
		mkdirSync(join(fixture, name), { mode: 0o700 });
	const env = {
		PATH: process.env.PATH,
		HOME: join(fixture, "home"),
		TMPDIR: join(fixture, "tmp"),
		XDG_CONFIG_HOME: join(fixture, "home", ".config"),
		PI_CODING_AGENT_DIR: join(fixture, "agent"),
		PI_BACKGROUND_CHECKOUT: resolve(checkout),
		...(process.env.PI_BACKGROUND_SSH_CONFIG
			? {
					PI_BACKGROUND_SSH_CONFIG: process.env.PI_BACKGROUND_SSH_CONFIG,
					PI_BACKGROUND_REMOTE_CWD: process.env.PI_BACKGROUND_REMOTE_CWD,
				}
			: {}),
		PI_OFFLINE: "1",
		TERM: "xterm-256color",
		LANG: "en_US.UTF-8",
	};
	if (process.env.PI_BACKGROUND_SSH_CONFIG) {
		mkdirSync(join(env.HOME, ".ssh"), { mode: 0o700 });
		writeFileSync(
			join(env.HOME, ".ssh", "config"),
			readFileSync(process.env.PI_BACKGROUND_SSH_CONFIG),
			{ mode: 0o600 },
		);
	}
	const config = join(fixture, "tsconfig.json");
	writeFileSync(
		config,
		JSON.stringify({
			extends: join(checkout, "tsconfig.json"),
			compilerOptions: {
				noEmit: true,
				module: "ESNext",
				moduleResolution: "Bundler",
				typeRoots: [join(checkout, "node_modules/@types")],
			},
			files: [
				resolve(root, "../../extensions/background-work/index.ts"),
				join(checkout, "packages/coding-agent/src/utils/highlight-js.d.ts"),
			],
			include: [],
		}),
		{ mode: 0o600 },
	);
	// Existing Teleport sources use constructor parameter properties; keep the
	// extension's strict erasable-syntax check separate from that fixture graph.
	const remoteConfig = join(fixture, "remote-tsconfig.json");
	const remoteOptions = JSON.parse(readFileSync(config, "utf8"));
	remoteOptions.compilerOptions.erasableSyntaxOnly = false;
	remoteOptions.files.push(join(root, "scripts/teleport-fixture.ts"));
	writeFileSync(remoteConfig, JSON.stringify(remoteOptions), { mode: 0o600 });
	for (const args of [
		[join(checkout, "node_modules/typescript/bin/tsc"), "--project", config],
		[
			join(checkout, "node_modules/typescript/bin/tsc"),
			"--project",
			remoteConfig,
		],
		[
			join(checkout, "node_modules/vitest/dist/cli.js"),
			"--run",
			"--config",
			join(root, "scripts/vitest.config.mts"),
		],
	]) {
		const result = spawnSync(process.execPath, args, {
			cwd: join(checkout, "packages/coding-agent"),
			env,
			stdio: "inherit",
		});
		if (result.status !== 0)
			throw new Error(
				`Check failed (${result.status ?? result.error?.message})`,
			);
	}
	if (existsSync(join(fixture, "agent", "sessions")))
		throw new Error("Checks persisted sessions");
} finally {
	rmSync(fixture, { recursive: true, force: true });
}
