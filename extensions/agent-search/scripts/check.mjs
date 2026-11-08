import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const checkout = process.env.PI_SEARCH_CHECKOUT;
if (!checkout) throw new Error("Set PI_SEARCH_CHECKOUT to the Pi source checkout");
const root = fileURLToPath(new URL("..", import.meta.url));
const fixture = mkdtempSync(join(tmpdir(), "pi-search-check-"));
chmodSync(fixture, 0o700);
try {
	for (const name of ["home", "agent", "tmp"]) mkdirSync(join(fixture, name), { mode: 0o700 });
	const env = {
		PATH: process.env.PATH,
		HOME: join(fixture, "home"),
		TMPDIR: join(fixture, "tmp"),
		XDG_CONFIG_HOME: join(fixture, "home", ".config"),
		PI_CODING_AGENT_DIR: join(fixture, "agent"),
		PI_SEARCH_CHECKOUT: resolve(checkout),
		PI_SEARCH_DOCKER_IMAGE: process.env.PI_SEARCH_DOCKER_IMAGE,
		PI_OFFLINE: "1",
		TERM: "xterm-256color",
		LANG: "en_US.UTF-8",
	};
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
				join(root, "index.ts"),
				join(root, "scripts/faux-provider.ts"),
				join(checkout, "packages/coding-agent/src/utils/highlight-js.d.ts"),
			],
			include: [],
		}),
		{ mode: 0o600 },
	);
	for (const args of [
		[join(checkout, "node_modules/typescript/bin/tsc"), "--project", config],
		[
			join(checkout, "node_modules/vitest/dist/cli.js"),
			"--run",
			"--config",
			join(root, "scripts/vitest.config.mts"),
			...process.argv.slice(2),
		],
	]) {
		const result = spawnSync(process.execPath, args, {
			cwd: join(checkout, "packages/coding-agent"),
			env,
			stdio: "inherit",
		});
		if (result.status !== 0) throw new Error(`Check failed (${result.status ?? result.error?.message})`);
	}
	if (existsSync(join(fixture, "agent", "sessions"))) throw new Error("Checks persisted sessions");
} finally {
	rmSync(fixture, { recursive: true, force: true });
}
