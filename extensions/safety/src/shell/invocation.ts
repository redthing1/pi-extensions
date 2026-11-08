import { isShellOption } from "./args.js";

interface InvocationWords {
	program: string;
	args: string[];
	directories?: string[];
}

export interface ShellInvocation extends InvocationWords {
	depthExceeded: boolean;
	directories: string[];
}

export function normalizeInvocation(program: string, args: string[]): ShellInvocation {
	let current: InvocationWords = { program: baseProgram(program), args };
	const directories: string[] = [];
	for (let i = 0; i < 8; i++) {
		const next = unwrapOnce(current.program, current.args);
		if (!next) return { ...current, directories, depthExceeded: false };
		directories.push(...(next.directories ?? []));
		current = next;
	}
	return { ...current, directories, depthExceeded: Boolean(unwrapOnce(current.program, current.args)) };
}

export function baseProgram(value: string): string {
	const name = value.split(/[\\/]/u).pop() ?? value;
	return name.toLowerCase().replace(/\.(?:cmd|com|exe)$/u, "");
}

function unwrapOnce(program: string, args: string[]): InvocationWords | undefined {
	if (program === "then" || program === "do" || program === "else" || program === "{") {
		return invocationFromWords(args);
	}
	if (program === "sudo" || program === "doas" || program === "pkexec") {
		return commandAfterWrapperOptions(args, wrapperOptionsWithValues(program));
	}
	if (program === "command") {
		if (args[0] === "-v" || args[0] === "-V") return undefined;
		return commandAfterWrapperOptions(args, new Set());
	}
	if (program === "env") {
		return commandAfterEnv(args);
	}
	if (program === "busybox" || program === "toybox") {
		return commandAfterWrapperOptions(args, new Set());
	}
	return undefined;
}

function commandAfterWrapperOptions(args: string[], optionsWithValues: Set<string>): InvocationWords | undefined {
	const directories: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--") return withDirectories(invocationFromWords(args.slice(i + 1)), directories);
		if (optionsWithValues.has(arg)) {
			if ((arg === "-D" || arg === "--chdir") && args[i + 1]) directories.push(args[i + 1]);
			i++;
			continue;
		}
		if (arg.startsWith("--chdir=")) directories.push(arg.slice("--chdir=".length));
		if (optionsWithValues.has("-D") && arg.startsWith("-D") && arg.length > 2) directories.push(arg.slice(2));
		if (hasInlineOptionValue(arg, optionsWithValues)) continue;
		if (isShellOption(arg)) continue;
		return withDirectories(invocationFromWords(args.slice(i)), directories);
	}
	return undefined;
}

function commandAfterEnv(args: string[]): InvocationWords | undefined {
	const directories: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--") return withDirectories(invocationFromWords(args.slice(i + 1)), directories);
		if (arg === "-u" || arg === "--unset" || arg === "-C" || arg === "--chdir") {
			if ((arg === "-C" || arg === "--chdir") && args[i + 1]) directories.push(args[i + 1]);
			i++;
			continue;
		}
		if (arg === "-S" || arg === "--split-string") return undefined;
		if (arg.startsWith("-C") && arg.length > 2) directories.push(arg.slice(2));
		if (arg.startsWith("--chdir=")) directories.push(arg.slice("--chdir=".length));
		if (isShellOption(arg) || isEnvAssignment(arg)) continue;
		return withDirectories(invocationFromWords(args.slice(i)), directories);
	}
	return undefined;
}

function withDirectories(invocation: InvocationWords | undefined, directories: string[]): InvocationWords | undefined {
	return invocation ? { ...invocation, directories } : undefined;
}

function invocationFromWords(words: string[]): InvocationWords | undefined {
	const program = words[0];
	if (!program) return undefined;
	return { program: baseProgram(program), args: words.slice(1) };
}

function wrapperOptionsWithValues(program: string): Set<string> {
	if (program === "sudo") {
		return new Set([
			"-C",
			"-D",
			"-g",
			"-h",
			"-p",
			"-T",
			"-u",
			"--chdir",
			"--group",
			"--host",
			"--prompt",
			"--user",
		]);
	}
	if (program === "doas") return new Set(["-u"]);
	if (program === "pkexec") return new Set(["--user"]);
	return new Set();
}

function hasInlineOptionValue(arg: string, optionsWithValues: Set<string>): boolean {
	for (const option of optionsWithValues) {
		if (option.startsWith("--") && arg.startsWith(`${option}=`)) return true;
	}
	return false;
}

function isEnvAssignment(value: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9_]*=/.test(value);
}
