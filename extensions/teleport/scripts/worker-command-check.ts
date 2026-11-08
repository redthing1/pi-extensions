import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { quotePosix } from "../transport/master.ts";
import { workerCommand } from "../transport/worker-command.ts";
import { WorkerClient } from "../transport/worker-client.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-teleport-runtime-check-")));
const args = ["worker 'quoted'.mjs", "nonce", "relative 'workspace'", "cleanup\n$`dir"] as const;
const input = "worker protocol input\n";
let checks = 0;
let handshakes = 0;
const runtimes = new Map(
	["node", "bun"].map((runtime) => {
		const result = spawnSync(runtime, ["-p", "process.execPath"], { encoding: "utf8" });
		return [runtime, result.status === 0 ? result.stdout.trim() : undefined];
	}),
);

try {
	for (const shell of ["/bin/bash", "/bin/zsh"]) {
		if (!existsSync(shell)) continue;
		for (const stage of ["path", "login", "interactive", "missing"] as const) {
			for (const runtime of ["node", "bun"]) {
				const home = join(root, `${shell.split("/").at(-1)}-${stage}-${runtime}`);
				const bin = join(home, "runtime bin");
				const empty = join(home, "empty");
				const cwd = join(home, "original 'cwd'");
				for (const path of [bin, empty, cwd]) mkdirSync(path, { recursive: true });
				// Use shell builtins so the fixture cannot discover a host runtime.
				const runtimeScript = `#!/bin/sh\nprintf '%s\\n' ${quotePosix(runtime)} "$PWD" "$PATH" "$@"\nIFS= read -r line\nprintf '%s\\n' "$line"\nexit "\${WORKER_EXIT:-0}"\n`;
				writeFileSync(join(bin, runtime), runtimeScript, { mode: 0o700 });
				if (runtime === "node") {
					writeFileSync(join(bin, "bun"), "#!/bin/sh\necho wrong-runtime; exit 99\n", { mode: 0o700 });
				}
				const startup = (name: string, expose: boolean) =>
					`printf '%s\\n' ${quotePosix(`${name} startup noise`)}\nIFS= read -r ignored || :\ncd /\nexport PATH=${quotePosix(expose ? bin : empty)}\n`;
				writeFileSync(join(home, "login.rc"), startup("login", stage === "login"));
				writeFileSync(join(home, ".bashrc"), startup("interactive", stage === "interactive"));
				writeFileSync(join(home, ".zshenv"), `export PATH=${quotePosix(empty)}\n`);
				writeFileSync(join(home, ".zprofile"), '. "$HOME/login.rc"\n');
				writeFileSync(join(home, ".zshrc"), '. "$HOME/.bashrc"\n');
				const shellWrapper = join(home, "shell");
				// Disable global startup files and read only this fixture's files.
				writeFileSync(
					shellWrapper,
					shell.endsWith("zsh")
						? `#!/bin/sh\nexec ${shell} -d "$@"\n`
						: `#!/bin/sh\nif [ "$1" = -lc ]; then . "$HOME/login.rc"; fi\nexec ${shell} --noprofile --rcfile "$HOME/.bashrc" "$@"\n`,
					{ mode: 0o700 },
				);
				const env = {
					HOME: home,
					ZDOTDIR: home,
					SHELL: shellWrapper,
					PATH: stage === "path" ? bin : empty,
					HISTFILE: "/dev/null",
					LC_ALL: "C",
				};
				for (const exitCode of stage === "missing" ? [127] : [0, 42, 127]) {
					const result = spawnSync("/bin/sh", ["-c", workerCommand(...args)], {
						cwd,
						env: { ...env, WORKER_EXIT: String(exitCode) },
						input,
						encoding: "utf8",
						timeout: 5_000,
					});
					assert.ifError(result.error);
					assert.equal(result.status, exitCode, `${shell} ${stage} ${runtime}: ${result.stderr}`);
					if (stage === "missing") {
						assert.equal(result.stdout, "");
						assert.match(result.stderr, /Teleport requires Node.js or Bun/);
					} else {
						assert.equal(result.stdout, [runtime, cwd, bin, ...args, input.trimEnd(), ""].join("\n"));
						if (stage === "path") assert.equal(result.stderr, "");
						else assert.match(result.stderr, /login startup noise/);
						if (stage === "interactive") assert.match(result.stderr, /interactive startup noise/);
					}
					checks++;
				}
				const executable = runtimes.get(runtime);
				if (executable && (stage === "login" || stage === "interactive")) {
					rmSync(join(bin, runtime));
					symlinkSync(executable, join(bin, runtime));
					const cleanup = join(home, "worker scratch");
					mkdirSync(cleanup);
					const worker = join(cleanup, "worker.mjs");
					cpSync(new URL("../worker/", import.meta.url), cleanup, { recursive: true });
					writeFileSync(join(cleanup, ".owner"), "test-nonce", { mode: 0o600 });
					const child = spawn("/bin/sh", ["-c", workerCommand(worker, "test-nonce", ".", cleanup)], {
						cwd,
						env,
						stdio: ["pipe", "pipe", "pipe"],
					});
					let stderr = "";
					child.stderr.on("data", (chunk: Buffer) => {
						stderr += chunk.toString();
					});
					const client = new WorkerClient(child, "test-nonce");
					try {
						assert.equal((await client.ready()).cwd, cwd);
						await client.request("ping", {}).promise;
					} catch (error) {
						throw new Error(`${shell} ${stage} ${runtime}: ${stderr}`, { cause: error });
					} finally {
						await client.close();
					}
					assert.equal(existsSync(cleanup), false);
					handshakes++;
				}
			}
		}
	}
	console.log(`teleport worker command checks passed (${checks} cases, ${handshakes} real worker handshakes)`);
} finally {
	rmSync(root, { recursive: true, force: true });
}
