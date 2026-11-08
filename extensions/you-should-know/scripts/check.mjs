import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const checkout = process.env.PI_BTW_CHECKOUT;
if (!checkout) throw new Error("Set PI_BTW_CHECKOUT to the Pi source checkout");
const root = fileURLToPath(new URL("..", import.meta.url));
const fixture = mkdtempSync(join(tmpdir(), "pi-btw-check-"));
try {
	for (const dir of ["home", "agent", "workspace", "tmp"]) mkdirSync(join(fixture, dir), { mode: 0o700 });
	const env = {
		PATH: process.env.PATH,
		HOME: join(fixture, "home"),
		TMPDIR: join(fixture, "tmp"),
		XDG_CONFIG_HOME: join(fixture, "home", ".config"),
		PI_CODING_AGENT_DIR: join(fixture, "agent"),
		PI_BTW_CHECKOUT: resolve(checkout),
		PI_OFFLINE: "1",
		TERM: "xterm-256color",
		LANG: "en_US.UTF-8",
	};
	const config = join(fixture, "tsconfig.json");
	const adapters = join(fixture, "adapters.json");
	writeFileSync(config, JSON.stringify({
		extends: join(checkout, "tsconfig.json"),
		compilerOptions: { noEmit: true, typeRoots: [join(checkout, "node_modules/@types")] },
		files: [join(root, "index.ts"), join(checkout, "packages/coding-agent/src/utils/highlight-js.d.ts")],
		include: [],
	}), { mode: 0o600 });
	// Existing provider extensions use bundler loading and predate erasable-only syntax.
	writeFileSync(adapters, JSON.stringify({
		extends: config,
		compilerOptions: { module: "ESNext", moduleResolution: "Bundler", erasableSyntaxOnly: false },
		files: [join(root, "../vllm-router/stream.ts"), join(root, "../llamacpp-router/stream.ts"), join(checkout, "packages/coding-agent/src/utils/highlight-js.d.ts")],
	}), { mode: 0o600 });
	for (const args of [
		[join(checkout, "node_modules/typescript/bin/tsc"), "--project", config],
		[join(checkout, "node_modules/typescript/bin/tsc"), "--project", adapters],
		[join(checkout, "node_modules/vitest/dist/cli.js"), "--run", "--config", join(root, "scripts/vitest.config.ts")],
	]) {
		const result = spawnSync(process.execPath, args, { cwd: root, env, stdio: "inherit" });
		if (result.status !== 0) throw new Error(`Check failed (${result.status ?? result.error?.message})`);
	}
	if (existsSync(join(fixture, "agent", "sessions"))) throw new Error("Checks persisted sessions unexpectedly");
} finally {
	rmSync(fixture, { recursive: true, force: true });
}
