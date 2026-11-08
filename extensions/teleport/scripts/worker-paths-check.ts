import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
export async function checkWorkerPaths(): Promise<void> {
	const { firstExecutable } = await import(new URL("../worker/paths.mjs", import.meta.url).href);
	const root = await mkdtemp(join(tmpdir(), "pi-teleport-path-contract-"));
	const originalPath = process.env.PATH;
	try {
		const bin = join(root, "bin");
		await mkdir(bin);
		await writeFile(join(bin, "fixture"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
		await mkdir(join(root, "fixture"));
		process.env.PATH = `${root}:${bin}`;
		assert.equal(await firstExecutable(["fixture"]), join(bin, "fixture"));
		assert.equal(await firstExecutable([join(root, "fixture"), join(bin, "fixture")]), join(bin, "fixture"));
		assert.equal(await firstExecutable(["missing-fixture"]), undefined);
		console.log("teleport worker executable checks passed: PATH resolution, fallbacks, and directory refusal");
	} finally {
		if (originalPath === undefined) delete process.env.PATH;
		else process.env.PATH = originalPath;
		await rm(root, { recursive: true, force: true });
	}
}
