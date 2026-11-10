import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
if (!process.env.PI_CHECKOUT) throw new Error("Set PI_CHECKOUT to the harness source checkout");
const checkout = resolve(process.env.PI_CHECKOUT);
if (!existsSync(join(checkout, "node_modules/typescript/bin/tsc"))) {
	throw new Error("Hydrate the harness's locked dependencies before checking extensions");
}
const fixture = mkdtempSync(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "pi-ext-"));
try {
	for (const dir of ["home", "agent", "workspace", "tmp"]) mkdirSync(join(fixture, dir), { mode: 0o700 });
	const env = {
		PATH: process.env.PATH,
		HOME: join(fixture, "home"),
		TMPDIR: join(fixture, "tmp"),
		XDG_CONFIG_HOME: join(fixture, "home", ".config"),
		PI_CODING_AGENT_DIR: join(fixture, "agent"),
		PI_CHECKOUT: checkout,
		PI_ASK_CHECKOUT: checkout,
		PI_BTW_CHECKOUT: checkout,
		PI_SEARCH_CHECKOUT: checkout,
		PI_BACKGROUND_CHECKOUT: checkout,
		PI_GUARD_TEST_CHECKOUT: checkout,
		PI_OFFLINE: "1",
		HISTFILE: "/dev/null",
		TERM: "xterm-256color",
		LANG: "en_US.UTF-8",
		...(process.env.DEVELOPER_DIR ? { DEVELOPER_DIR: process.env.DEVELOPER_DIR } : {}),
		...(process.env.SDKROOT ? { SDKROOT: process.env.SDKROOT } : {}),
	};
	const run = (args, cwd = root) => {
		const result = spawnSync(process.execPath, args, { cwd, env, stdio: "inherit" });
		if (result.status !== 0) throw new Error(`Check failed (${result.status ?? result.error?.message})`);
	};
	const sources = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		if (["scripts", "test"].includes(entry.name)) return [];
		const file = join(dir, entry.name);
		return entry.isDirectory() ? sources(file) : entry.name.endsWith(".ts") ? [file] : [];
	});
	const config = join(fixture, "tsconfig.json");
	const paths = JSON.parse(readFileSync(join(checkout, "tsconfig.json"), "utf8")).compilerOptions.paths;
	writeFileSync(config, JSON.stringify({
		extends: join(checkout, "tsconfig.json"),
		compilerOptions: {
			noEmit: true,
			module: "ESNext",
			moduleResolution: "Bundler",
			erasableSyntaxOnly: false,
			typeRoots: [join(checkout, "node_modules/@types")],
			paths: {
				...Object.fromEntries(Object.entries(paths).map(([name, entries]) => [name, entries.map((entry) => resolve(checkout, entry))])),
			},
		},
		files: [...sources(join(root, "extensions")), join(checkout, "packages/coding-agent/src/utils/highlight-js.d.ts")],
		include: [],
	}), { mode: 0o600 });
	run([join(checkout, "node_modules/typescript/bin/tsc"), "--project", config]);
	const runtimeConfig = join(fixture, "runtime-tsconfig.json");
	const runtimeOptions = JSON.parse(readFileSync(config, "utf8"));
	runtimeOptions.compilerOptions.paths.typebox = [join(checkout, "packages/coding-agent/node_modules/typebox/build/index.mjs")];
	writeFileSync(runtimeConfig, JSON.stringify(runtimeOptions), { mode: 0o600 });
	env.TSX_TSCONFIG_PATH = runtimeConfig;
	const preload = [
		"--import", join(checkout, "node_modules/tsx/dist/esm/index.mjs"),
		"--import", join(checkout, "packages/coding-agent/src/experimental/source-resolver.ts"),
	];
	for (const file of [
		"scripts/check-package.ts",
		"extensions/shared/scripts/check.ts",
		"extensions/goal/scripts/verify-core.ts",
		"extensions/schedule/scripts/check.ts",
		"extensions/execution-guard/scripts/check.ts",
		"extensions/safety/scripts/check.ts",
		"extensions/teleport/scripts/check.ts",
		"extensions/subagents/scripts/check.ts",
		...readdirSync(join(root, "extensions/compact-horizon/test")).filter((name) => name.endsWith(".test.ts"))
			.map((name) => `extensions/compact-horizon/test/${name}`),
	]) run([...preload, join(root, file)], join(fixture, "workspace"));
	run([join(checkout, "node_modules/vitest/dist/cli.js"), "--run", "--config", join(root, "vitest.config.ts")]);
	if (existsSync(join(fixture, "agent", "sessions"))) throw new Error("Checks persisted sessions unexpectedly");
} finally {
	rmSync(fixture, { recursive: true, force: true });
}
