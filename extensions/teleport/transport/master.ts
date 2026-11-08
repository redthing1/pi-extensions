import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	assertSafeMasterConfiguration,
	SSH_RESTRICTIONS,
	sshEnvironment,
	sshOptions,
	writeConnectionConfiguration,
} from "./policy.ts";
const MASTER_START_TIMEOUT_MS = 15_000;
const SSH_OPERATION_TIMEOUT_MS = 15_000;
const SSH_CLOSE_TIMEOUT_MS = 2_000;
const DIAGNOSTIC_BYTES = 8_192;

export interface MasterOptions {
	destination: string;
	sshConfigPath?: string;
	borrowedSocketPath?: string;
}

export interface MasterHandoff {
	destination: string;
	socketPath: string;
}

export class MasterConnection {
	private process: ChildProcess | undefined;
	private directory: string | undefined;
	private socketPath: string | undefined;
	private configurationPath: string | undefined;

	constructor(private readonly options: MasterOptions) {}

	async start(): Promise<void> {
		if (this.process || this.socketPath) throw new Error("SSH master is already started");
		try {
			if (this.options.borrowedSocketPath) {
				this.socketPath = this.options.borrowedSocketPath;
				const check = await this.check();
				if (check.ok) return;
				this.socketPath = undefined;
				throw new Error(`Borrowed SSH master is unavailable: ${check.output}`);
			}
			this.directory = await mkdtemp(join(tmpdir(), "pi-t-"));
			this.configurationPath = await writeConnectionConfiguration(this.directory, this.options.sshConfigPath);
			const configuration = await runSsh(
				[...this.configArgs(), "-G", ...sshOptions(SSH_RESTRICTIONS), this.options.destination],
				SSH_OPERATION_TIMEOUT_MS,
				256 * 1024,
			);
			if (configuration.code !== 0) throw new Error(`SSH configuration failed: ${configuration.stderr.trim()}`);
			assertSafeMasterConfiguration(configuration.stdout);
			this.socketPath = join(this.directory, "c");
			const args = [
				...this.configArgs(),
				"-M",
				"-N",
				"-T",
				"-S",
				this.socketPath,
				"-o",
				"ControlMaster=yes",
				"-o",
				"ControlPersist=no",
				...sshOptions(SSH_RESTRICTIONS),
				this.options.destination,
			];
			const child = spawn("ssh", args, {
				stdio: ["ignore", "pipe", "pipe"],
				env: sshEnvironment(),
			});
			this.process = child;
			child.stdout?.resume();
			let spawnError: Error | undefined;
			let stderr = "";
			child.once("error", (error) => {
				spawnError = error;
			});
			child.stderr?.on("data", (chunk: Buffer) => {
				stderr = appendDiagnostic(stderr, chunk);
			});

			const deadline = Date.now() + MASTER_START_TIMEOUT_MS;
			while (Date.now() < deadline) {
				if (spawnError) {
					throw new Error(`Unable to start system ssh: ${spawnError.message}`);
				}
				if (hasExited(child)) {
					throw new Error(`SSH master exited during startup: ${stderr.trim()}`);
				}
				if ((await this.check()).ok) return;
				await new Promise((resolveWait) => setTimeout(resolveWait, 50));
			}
			throw new Error(`Timed out waiting for SSH master: ${stderr.trim()}`);
		} catch (error) {
			await this.close();
			throw error;
		}
	}

	async check(): Promise<{ ok: boolean; output: string }> {
		if (!this.socketPath) return { ok: false, output: "not started" };
		const result = await runSsh(
			["-F", "/dev/null", "-S", this.socketPath, "-O", "check", this.options.destination],
			SSH_CLOSE_TIMEOUT_MS,
		);
		return { ok: result.code === 0, output: `${result.stdout}${result.stderr}`.trim() };
	}

	async upload(localPath: string, remotePath: string): Promise<void> {
		const content = await readFile(localPath);
		const command = `umask 077; set -C; cat > ${quotePosix(remotePath)}`;
		const result = await this.run(command, content);
		if (result.code !== 0) throw new Error(`Worker upload failed: ${result.stderr.trim()}`);
	}

	async run(
		command: string,
		input?: Buffer,
		timeoutMs = SSH_OPERATION_TIMEOUT_MS,
	): Promise<{ code: number | null; stdout: string; stderr: string }> {
		const child = this.spawnChannel(command);
		const result = collectProcess(child, timeoutMs);
		child.stdin.end(input);
		return result;
	}

	spawnChannel(remoteCommand: string): ChildProcessWithoutNullStreams {
		if (!this.socketPath) throw new Error("SSH master is not started");
		const args = [
			"-F",
			"/dev/null",
			"-T",
			"-S",
			this.socketPath,
			"-o",
			"ControlMaster=no",
			"-o",
			"ProxyCommand=/usr/bin/false",
			...sshOptions(SSH_RESTRICTIONS),
			this.options.destination,
			remoteCommand,
		];
		return spawn("ssh", args, { stdio: ["pipe", "pipe", "pipe"], env: sshEnvironment() });
	}

	handoff(): MasterHandoff {
		if (!this.socketPath) throw new Error("SSH master is not started");
		return {
			destination: this.options.destination,
			socketPath: this.socketPath,
		};
	}

	async close(): Promise<void> {
		const socketPath = this.socketPath;
		const directory = this.directory;
		const masterProcess = this.process;
		this.socketPath = undefined;
		this.directory = undefined;
		this.configurationPath = undefined;
		this.process = undefined;
		if (socketPath && !this.options.borrowedSocketPath) {
			try {
				await runSsh(
					["-F", "/dev/null", "-S", socketPath, "-O", "exit", this.options.destination],
					SSH_CLOSE_TIMEOUT_MS,
				);
			} catch {
				// The master or local control socket may already be gone.
			}
		}
		if (masterProcess && !hasExited(masterProcess)) {
			await terminateProcess(masterProcess, SSH_CLOSE_TIMEOUT_MS);
		}
		if (directory) await rm(directory, { recursive: true, force: true });
	}

	private configArgs(): string[] {
		if (!this.configurationPath) throw new Error("SSH configuration is not initialized");
		return ["-F", this.configurationPath];
	}
}

export function quotePosix(value: string): string {
	if (value.includes("\0")) throw new Error("Cannot quote NUL");
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function runSsh(
	args: string[],
	timeoutMs: number,
	stdoutLimit = DIAGNOSTIC_BYTES,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return collectProcess(
		spawn("ssh", args, { stdio: ["ignore", "pipe", "pipe"], env: sshEnvironment() }),
		timeoutMs,
		stdoutLimit,
	);
}

async function collectProcess(
	process: ChildProcess,
	timeoutMs: number,
	stdoutLimit = DIAGNOSTIC_BYTES,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
	let stdout = "";
	let stderr = "";
	let stdoutBytes = 0;
	process.stdout?.on("data", (chunk: Buffer) => {
		stdoutBytes += chunk.length;
		if (stdoutBytes <= stdoutLimit) stdout += chunk.toString("utf8");
	});
	process.stderr?.on("data", (chunk: Buffer) => {
		stderr = appendDiagnostic(stderr, chunk);
	});
	const result = await new Promise<{ code: number | null }>((resolveProcess, rejectProcess) => {
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const finish = (action: () => void): void => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			action();
		};
		timer = setTimeout(() => {
			finish(() => {
				void terminateProcess(process, SSH_CLOSE_TIMEOUT_MS);
				rejectProcess(new Error("SSH helper timed out"));
			});
		}, timeoutMs);
		process.once("error", (error) => finish(() => rejectProcess(error)));
		process.stdin?.on("error", (error) => {
			void terminateProcess(process, SSH_CLOSE_TIMEOUT_MS);
			finish(() => rejectProcess(error));
		});
		process.once("close", (code) => finish(() => resolveProcess({ code })));
	});
	if (stdoutBytes > stdoutLimit) throw new Error("SSH response exceeds the safety limit");
	return { ...result, stdout, stderr };
}

async function terminateProcess(process: ChildProcess, timeoutMs: number): Promise<void> {
	if (hasExited(process)) return;
	const closed = new Promise<void>((resolveClosed) => {
		process.once("close", () => resolveClosed());
	});
	process.kill("SIGTERM");
	if (await waitFor(closed, timeoutMs)) return;
	process.kill("SIGKILL");
	await waitFor(closed, timeoutMs);
}

async function waitFor(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timedOut = new Promise<false>((resolveTimeout) => {
		timer = setTimeout(() => resolveTimeout(false), timeoutMs);
	});
	const completed = await Promise.race([promise.then(() => true), timedOut]);
	if (timer) clearTimeout(timer);
	return completed;
}

function appendDiagnostic(current: string, chunk: Buffer): string {
	return `${current}${chunk.toString("utf8")}`.slice(-DIAGNOSTIC_BYTES);
}

function hasExited(process: ChildProcess): boolean {
	return process.exitCode !== null || process.signalCode !== null;
}
