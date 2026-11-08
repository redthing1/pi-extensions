const root = new URL("..", import.meta.url).pathname;
const outdir = "/tmp/pi-goal-extension-check";

await run(["rm", "-rf", outdir]);
await run([
	"bun",
	"build",
	`${root}/index.ts`,
	"--target=node",
	"--outdir",
	outdir,
	"--external",
	"@earendil-works/pi-ai",
	"--external",
	"@earendil-works/pi-tui",
	"--external",
	"@earendil-works/pi-coding-agent",
	"--external",
	"@earendil-works/pi-agent-core",
]);
await lintSources();

async function run(cmd: string[]): Promise<void> {
	const result = Bun.spawnSync(cmd, {
		cwd: root,
		stdout: "pipe",
		stderr: "pipe",
	});
	process.stdout.write(result.stdout.toString());
	process.stderr.write(result.stderr.toString());
	if (!result.success) process.exit(result.exitCode);
}

async function lintSources(): Promise<void> {
	const glob = new Bun.Glob("**/*.ts");
	const failures: string[] = [];
	for (const path of glob.scanSync({ cwd: root })) {
		if (path.startsWith("scripts/")) continue;
		const text = await Bun.file(`${root}/${path}`).text();
		if (/\bawait\s+import\s*\(/.test(text) || /[^.]\bimport\s*\(/.test(text)) {
			failures.push(`${path}: inline imports are not allowed`);
		}
		if (hasAnyType(stripComments(text))) {
			failures.push(`${path}: avoid any types`);
		}
	}
	if (failures.length > 0) {
		for (const failure of failures) console.error(failure);
		process.exit(1);
	}
}

function stripComments(text: string): string {
	return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function hasAnyType(text: string): boolean {
	return /:\s*any\b/.test(text) || /\bas\s+any\b/.test(text) || /<\s*any\s*>/.test(text) || /\bany\[\]/.test(text);
}
