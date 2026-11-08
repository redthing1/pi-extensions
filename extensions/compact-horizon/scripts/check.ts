import { mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const piMonoRoot = process.env.PI_MONO_ROOT;
if (!piMonoRoot) throw new Error("Set PI_MONO_ROOT to the Pi source checkout before running this check.");
const outdir = mkdtempSync(join(tmpdir(), "pi-compact-horizon-check-"));
process.on("exit", () => rmSync(outdir, { recursive: true, force: true }));

function run(command: string[], cwd: string): void {
	const result = Bun.spawnSync(command, { cwd, stdout: "pipe", stderr: "pipe" });
	process.stdout.write(result.stdout.toString());
	process.stderr.write(result.stderr.toString());
	if (result.exitCode !== 0) process.exit(result.exitCode);
}

run(
	[
		"bun",
		"build",
		`${root}/index.ts`,
		"--target=node",
		"--outdir",
		outdir,
		"--external",
		"@earendil-works/pi-ai",
		"--external",
		"@earendil-works/pi-coding-agent",
		"--external",
		"@earendil-works/pi-agent-core",
	],
	root,
);

const sourceFiles = [...new Bun.Glob("**/*.ts").scanSync({ cwd: root, absolute: true })].filter(
	(path) => !path.includes("/scripts/"),
);
sourceFiles.push(`${piMonoRoot}/packages/coding-agent/src/utils/highlight-js.d.ts`);
const tsconfigPath = join(outdir, "tsconfig.json");
await Bun.write(
	tsconfigPath,
	JSON.stringify({
		extends: `${piMonoRoot}/tsconfig.json`,
		compilerOptions: { noEmit: true, typeRoots: [`${piMonoRoot}/node_modules/@types`] },
		files: sourceFiles,
		include: [],
	}),
);
try {
	run([`${piMonoRoot}/node_modules/.bin/tsc`, "--project", tsconfigPath], piMonoRoot);
} finally {
	unlinkSync(tsconfigPath);
}

const testFiles = [...new Bun.Glob("test/*.test.ts").scanSync({ cwd: root, absolute: true })].sort();
for (const testFile of testFiles) {
	run(["bun", "run", "--no-install", "--tsconfig-override=tsconfig.json", testFile], piMonoRoot);
	console.log(`Passed ${testFile}`);
}
