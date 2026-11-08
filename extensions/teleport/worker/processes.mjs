import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { join } from "node:path";
import { finished } from "node:stream/promises";
import { rm } from "node:fs/promises";
import { FRAME, MAX_PAYLOAD_BYTES } from "./protocol.mjs";
const MAX_DISPLAY_BYTES = 50 * 1024;
const MAX_DISPLAY_LINES = 2000;
const COMMAND_TERM_GRACE_MS = 1000;
const COMMAND_KILL_GRACE_MS = 250;

export function createProcessOperations({
	cwd,
	shellPath,
	cleanupDirectory,
	resolveRemotePath,
	writeFrame,
	writeStreamingFrame,
	rgPath,
	fdPath,
}) {
	const activeCommands = new Map();
	async function runCaptured(id, executable, args, requestCwd) {
		return new Promise((resolveProcess, rejectProcess) => {
			const child = spawn(executable, args, {
				cwd: requestCwd,
				detached: true,
				env: process.env,
				stdio: ["ignore", "pipe", "pipe"],
			});
			const state = { child, cancelled: false, killTimer: undefined };
			activeCommands.set(id, state);
			const stdout = [];
			const stderr = [];
			let stdoutBytes = 0;
			let stderrBytes = 0;
			let exceeded = false;
			child.stdout.on("data", (chunk) => {
				stdoutBytes += chunk.length;
				if (stdoutBytes > MAX_PAYLOAD_BYTES) {
					exceeded = true;
					terminateCommand(state);
					return;
				}
				stdout.push(chunk);
			});
			child.stderr.on("data", (chunk) => {
				stderrBytes += chunk.length;
				if (stderrBytes <= 64 * 1024) stderr.push(chunk);
			});
			child.once("error", (error) => {
				activeCommands.delete(id);
				rejectProcess(error);
			});
			child.once("close", (exitCode, signal) => {
				if (state.killTimer && !state.cancelled) clearTimeout(state.killTimer);
				activeCommands.delete(id);
				if (state.cancelled) {
					rejectProcess(Object.assign(new Error("operation aborted"), { code: "ABORTED" }));
					return;
				}
				if (exceeded) {
					rejectProcess(Object.assign(new Error("process output exceeds worker limit"), { code: "LIMIT_EXCEEDED" }));
					return;
				}
				resolveProcess({
					exitCode,
					signal,
					stdout: Buffer.concat(stdout),
					stderr: Buffer.concat(stderr).toString("utf8"),
				});
			});
		});
	}

	async function executeCommand(id, params) {
		if (typeof params.command !== "string") throw new Error("exec command must be a string");
		const shell = typeof params.shell === "string" ? params.shell : shellPath;
		if (!shell) throw Object.assign(new Error("no supported remote shell is available"), { code: "UNSUPPORTED" });
		const commandCwd = typeof params.cwd === "string" ? resolveRemotePath(params.cwd) : cwd;
		const child = spawn(shell, ["-c", params.command], {
			cwd: commandCwd,
			detached: true,
			env: process.env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const state = { child, cancelled: false, killTimer: undefined };
		const output = createCommandOutputCapture(id);
		activeCommands.set(id, state);
		const stdoutPump = pumpCommandOutput(child.stdout, "stdout", id, output);
		const stderrPump = pumpCommandOutput(child.stderr, "stderr", id, output);
		void stdoutPump.catch(() => terminateCommand(state));
		void stderrPump.catch(() => terminateCommand(state));

		await new Promise((resolveChild, rejectChild) => {
			let spawnFailed = false;
			child.once("error", (error) => {
				spawnFailed = true;
				if (state.killTimer) clearTimeout(state.killTimer);
				activeCommands.delete(id);
				rejectChild(error);
			});
			child.once("close", async (exitCode, signal) => {
				if (spawnFailed) return;
				if (state.killTimer && !state.cancelled) clearTimeout(state.killTimer);
				activeCommands.delete(id);
				try {
					await Promise.all([stdoutPump, stderrPump]);
					let fullOutputPath = await output.finish();
					if (state.cancelled && fullOutputPath) {
						await rm(fullOutputPath, { force: true });
						fullOutputPath = undefined;
					}
					writeFrame(FRAME.result, { id, result: { exitCode, signal, cancelled: state.cancelled, fullOutputPath } });
					resolveChild();
				} catch (error) {
					try {
						await output.discard();
					} catch {
						rejectChild(new Error("Command failed and its temporary output could not be removed", { cause: error }));
						return;
					}
					rejectChild(error);
				}
			});
		});
	}

	async function pumpCommandOutput(source, streamName, id, output) {
		for await (const chunk of source) {
			await output.append(chunk);
			await writeStreamingFrame(FRAME.data, { id, stream: streamName }, chunk);
		}
	}

	function createCommandOutputCapture(id) {
		let buffered = [];
		let stream;
		let streamError;
		let path;
		let totalBytes = 0;
		let totalLines = 0;
		let writeChain = Promise.resolve();

		return {
			append(chunk) {
				writeChain = writeChain.then(async () => {
					totalBytes += chunk.length;
					if (totalBytes > MAX_PAYLOAD_BYTES)
						throw Object.assign(new Error("saved command output exceeds 32MB limit"), { code: "LIMIT_EXCEEDED" });
					for (const byte of chunk) {
						if (byte === 0x0a) totalLines += 1;
					}
					if (!stream && (totalBytes > MAX_DISPLAY_BYTES || totalLines > MAX_DISPLAY_LINES)) {
						path = join(cleanupDirectory, `output-${id.replaceAll(/[^a-zA-Z0-9_-]/g, "_")}.log`);
						stream = createWriteStream(path, { flags: "wx", mode: 0o600 });
						stream.on("error", (error) => {
							streamError = error;
						});
						for (const previous of buffered) await writeToStream(stream, previous);
						buffered = [];
					}
					if (stream) await writeToStream(stream, chunk);
					else buffered.push(Buffer.from(chunk));
				});
				return writeChain;
			},
			async finish() {
				await writeChain;
				if (!stream) return undefined;
				if (streamError) throw streamError;
				stream.end();
				await finished(stream);
				return path;
			},
			async discard() {
				if (stream) {
					stream.destroy();
					await finished(stream).catch(() => {});
				}
				if (path) await rm(path, { force: true });
			},
		};
	}

	async function writeToStream(stream, chunk) {
		await new Promise((resolveWrite, rejectWrite) => {
			stream.write(chunk, (error) => {
				if (error) rejectWrite(error);
				else resolveWrite();
			});
		});
	}

	function cancelCommand(targetId) {
		const state = activeCommands.get(targetId);
		if (!state || state.child.pid === undefined) return false;
		state.cancelled = true;
		return terminateCommand(state);
	}

	function terminateCommand(state) {
		if (!signalCommand(state, "SIGTERM")) return false;
		if (state.killTimer) return true;
		state.killTimer = setTimeout(() => {
			signalCommand(state, "SIGKILL");
			state.killTimer = undefined;
		}, COMMAND_TERM_GRACE_MS);
		state.killTimer.unref();
		return true;
	}

	function signalCommand(state, signal) {
		if (state.child.pid === undefined) return false;
		try {
			process.kill(-state.child.pid, signal);
			return true;
		} catch {
			return false;
		}
	}

	async function stopActiveCommands() {
		const states = [...activeCommands.values()];
		if (states.length === 0) return;
		for (const state of states) {
			state.cancelled = true;
			signalCommand(state, "SIGTERM");
			if (state.killTimer) clearTimeout(state.killTimer);
		}
		await delay(COMMAND_TERM_GRACE_MS);
		for (const state of states) {
			signalCommand(state, "SIGKILL");
		}
		await delay(COMMAND_KILL_GRACE_MS);
	}

	function delay(milliseconds) {
		return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
	}

	async function search(id, op, params) {
		switch (op) {
			case "grep": {
				if (!rgPath) throw Object.assign(new Error("ripgrep is unavailable"), { code: "UNSUPPORTED" });
				if (typeof params.pattern !== "string") throw new Error("grep pattern must be a string");
				const path = resolveRemotePath(params.path ?? ".");
				const args = ["--json", "--color=never", "--line-number", "--column"];
				if (params.ignoreCase === true) args.push("--ignore-case");
				if (params.literal === true) args.push("--fixed-strings");
				if (typeof params.glob === "string") args.push("--glob", params.glob);
				if (Number.isInteger(params.context) && params.context > 0) {
					args.push("--context", String(Math.min(params.context, 100)));
				}
				args.push("--", params.pattern, path);
				const result = await runCaptured(id, rgPath, args, cwd);
				if (result.exitCode !== 0 && result.exitCode !== 1) throw new Error(`ripgrep failed: ${result.stderr.trim()}`);
				writeFrame(FRAME.result, { id, result: { exitCode: result.exitCode, path } }, result.stdout);
				return;
			}
			case "find": {
				if (!fdPath) throw Object.assign(new Error("fd is unavailable"), { code: "UNSUPPORTED" });
				const pattern = typeof params.pattern === "string" && params.pattern.length > 0 ? params.pattern : "*";
				const path = resolveRemotePath(params.path ?? ".");
				const maximum = Number.isInteger(params.maxResults) ? Math.min(Math.max(params.maxResults, 1), 10_000) : 2_000;
				const args = ["--color=never", "--glob", "--print0", "--max-results", String(maximum)];
				if (params.hidden === true) args.push("--hidden");
				if (params.noIgnore === true) args.push("--no-ignore");
				args.push("--", pattern, path);
				const result = await runCaptured(id, fdPath, args, cwd);
				if (result.exitCode !== 0) throw new Error(`fd failed: ${result.stderr.trim()}`);
				writeFrame(FRAME.result, { id, result: { exitCode: result.exitCode, path, maximum } }, result.stdout);
				return;
			}
		}
	}

	return { search, executeCommand, cancelCommand, stopActiveCommands };
}
