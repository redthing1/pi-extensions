import { spawn } from "node:child_process";

export interface CommandResult {
	output: string;
	exitCode: number | null;
}

export function runCommand(command: string, args: string[], cwd: string, timeoutMs = 180_000): Promise<CommandResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
		const timeout = setTimeout(() => {
			child.kill("SIGTERM");
			reject(new Error(`${command} timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		let output = "";
		child.stdout.on("data", (data) => (output += data.toString()));
		child.stderr.on("data", (data) => (output += data.toString()));
		child.on("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
		child.on("close", (exitCode) => {
			clearTimeout(timeout);
			resolve({ output, exitCode });
		});
	});
}

export async function runSuccessfulCommand(command: string, args: string[], cwd: string, timeoutMs?: number): Promise<string> {
	const result = await runCommand(command, args, cwd, timeoutMs);
	if (result.exitCode !== 0) {
		throw new Error(`${command} ${args.join(" ")} failed ${result.exitCode}:\n${result.output}`);
	}
	return result.output;
}
