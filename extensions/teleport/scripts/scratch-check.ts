import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MasterConnection } from "../transport/master.ts";
import { RemoteScratch, WORKER_ASSETS } from "../transport/scratch.ts";

const root = await mkdtemp(join(tmpdir(), "pi-worker-install-"));
const source = join(root, "source 'quoted'");
await mkdir(source);
for (const name of WORKER_ASSETS) {
	await writeFile(join(source, name), `// ${name}\nexport const text = "' $() \u0060 unicode: 雪";`);
}
let commands = 0;
const master = {
	async run(command: string) {
		commands++;
		const result = spawnSync("/bin/sh", ["-c", command], { encoding: "utf8" });
		assert.ifError(result.error);
		return { code: result.status, stdout: result.stdout, stderr: result.stderr };
	},
} as unknown as MasterConnection;

try {
	for (const collision of [undefined, "file", "symlink"] as const) {
		const scratch = new RemoteScratch(master, randomBytes(16).toString("hex"));
		try {
			await scratch.create();
			const existing = join(scratch.path, "paths.mjs");
			const sentinel = join(root, "sentinel");
			if (collision) {
				await writeFile(sentinel, "preserve me");
				if (collision === "symlink") await symlink(sentinel, existing);
				else await writeFile(existing, "existing file");
			}
			const before = commands;
			const installed = scratch.installWorker(join(source, "worker.mjs"));
			if (collision) {
				await assert.rejects(installed, /Worker upload failed/);
				assert.equal(await readFile(sentinel, "utf8"), "preserve me");
				assert.equal(await readFile(existing, "utf8"), collision === "file" ? "existing file" : "preserve me");
				await assert.rejects(stat(join(scratch.path, "files.mjs")), { code: "ENOENT" });
			} else {
				await installed;
				for (const name of WORKER_ASSETS) {
					assert.deepEqual(await readFile(join(scratch.path, name)), await readFile(join(source, name)));
					assert.equal((await stat(join(scratch.path, name))).mode & 0o777, 0o600);
				}
			}
			assert.equal(commands - before, 1, "worker installation uses one SSH operation");
		} finally {
			await scratch.remove();
			await assert.rejects(stat(scratch.path), { code: "ENOENT" });
		}
	}
	console.log(
		"teleport worker installation: exact bytes, private permissions, exclusive writes, and owned cleanup passed",
	);
} finally {
	await rm(root, { recursive: true, force: true });
}
