import {
	mkdtempSync,
	mkdirSync,
	rmSync,
	writeFileSync,
	existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const checkout = process.env.PI_ASK_CHECKOUT;
if (!checkout) throw Error("Set PI_ASK_CHECKOUT to an existing Pi checkout");
const root = fileURLToPath(new URL("..", import.meta.url));
const fixture = mkdtempSync(join(tmpdir(), "pi-ask-check-"));
try {
	for (const name of ["home", "agent", "tmp"])
		mkdirSync(join(fixture, name), { mode: 0o700 });
	const env = {
		PATH: process.env.PATH,
		HOME: join(fixture, "home"),
		TMPDIR: join(fixture, "tmp"),
		XDG_CONFIG_HOME: join(fixture, "home", ".config"),
		PI_CODING_AGENT_DIR: join(fixture, "agent"),
		PI_ASK_CHECKOUT: resolve(checkout),
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
		],
	]) {
		const result = spawnSync(process.execPath, args, {
			cwd: join(checkout, "packages/coding-agent"),
			env,
			stdio: "inherit",
		});
		if (result.status !== 0)
			throw Error(`Check failed (${result.status ?? result.error?.message})`);
	}
	if (existsSync(join(fixture, "agent", "sessions")))
		throw Error("Checks persisted sessions");
} finally {
	rmSync(fixture, { recursive: true, force: true });
}
