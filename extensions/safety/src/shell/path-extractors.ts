import type { PathOperation } from "../paths/types.js";
import { isPathLikeShellArg, isShellOption, optionConsumesNext, valueAfterEquals } from "./args.js";
import { parseCdInvocation } from "./cd.js";
import { gitPathArguments } from "./git.js";
import type { ShellPathReference } from "./path-references.js";
import { rsyncLocalPathOperands } from "./rsync.js";

export function extractCommandPathReferences(program: string, args: string[], segment: string): ShellPathReference[] {
	switch (program) {
		case "cat":
		case "head":
		case "tail":
		case "file":
		case "wc":
			return positionalArgs(args, optionValueNames(program)).map((path) => ({ path, operation: "read", segment }));
		case "sed":
		case "awk":
			return positionalArgs(args, optionValueNames(program)).slice(1).map((path) => ({ path, operation: "read", segment }));
		case "ls":
		case "tree":
			return positionalArgs(args, optionValueNames(program)).map((path) => ({ path, operation: "list", segment }));
		case "find":
			return findRootArgs(args).map((path) => ({ path, operation: "list", segment }));
		case "cd":
			return cdPathArgs(args, segment);
		case "grep":
		case "rg":
			return grepPathArgs(args).map((path) => ({ path, operation: "read", segment }));
		case "curl":
			return curlPathArgs(args, segment);
		case "git":
			return gitPathArguments(args).map((path) => ({ path: path.path, operation: path.operation, segment }));
		case "cp":
		case "mv":
			return copyMovePathArgs(args, segment);
		case "rsync":
			return rsyncPathArgs(args, segment);
		case "tar":
			return tarPathArgs(args, segment);
		case "tee":
			return positionalArgs(args, optionValueNames(program)).map((path) => ({ path, operation: "write", segment }));
		case "cc":
		case "c++":
		case "clang":
		case "clang++":
		case "gcc":
		case "g++":
			return compilerPathArgs(args, segment);
		case "npm":
		case "pnpm":
		case "yarn":
		case "bun":
		case "uv":
		case "uvx":
		case "pip":
		case "pip3":
		case "poetry":
			return packageManagerPathArgs(program, args, segment);
		default:
			return [];
	}
}

function curlPathArgs(args: string[], segment: string): ShellPathReference[] {
	const references: ShellPathReference[] = [];
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (arg === "-o" || arg === "--output") {
			const path = args[++i];
			if (path && isPathLikeShellArg(path)) references.push({ path, operation: "write", segment });
			continue;
		}
		if (arg.startsWith("--output=")) {
			const path = valueAfterEquals(arg);
			if (path && isPathLikeShellArg(path)) references.push({ path, operation: "write", segment });
			continue;
		}
		if (arg.startsWith("-o") && arg.length > 2) {
			const path = arg.slice(2);
			if (isPathLikeShellArg(path)) references.push({ path, operation: "write", segment });
		}
	}
	return references;
}

function cdPathArgs(args: string[], segment: string): ShellPathReference[] {
	const parsed = parseCdInvocation(args);
	return parsed.supported && parsed.target ? [{ path: parsed.target, operation: "list", segment }] : [];
}

function grepPathArgs(args: string[]): string[] {
	const positional = positionalArgs(args, optionValueNames("grep"));
	if (positional.length <= 1) return [];
	return positional.slice(1);
}

function copyMovePathArgs(args: string[], segment: string): ShellPathReference[] {
	const parsed = copyMoveOperands(args);
	const references: ShellPathReference[] = [];
	if (parsed.targetDirectory) references.push({ path: parsed.targetDirectory, operation: "write", segment });
	if (parsed.operands.length < 2) return references;
	const sources = parsed.operands.slice(0, -1);
	const destination = parsed.operands[parsed.operands.length - 1];
	references.push(...sources.map((path) => ({ path, operation: "read" as const, segment })));
	if (destination) references.push({ path: destination, operation: "write", segment });
	return references;
}

function copyMoveOperands(args: string[]): { operands: string[]; targetDirectory?: string } {
	const operands: string[] = [];
	let targetDirectory: string | undefined;
	let optionsDone = false;
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (!optionsDone && arg === "--") {
			optionsDone = true;
			continue;
		}
		if (!optionsDone && (arg === "-t" || arg === "--target-directory")) {
			targetDirectory = args[++i];
			continue;
		}
		if (!optionsDone && arg.startsWith("--target-directory=")) {
			targetDirectory = valueAfterEquals(arg);
			continue;
		}
		if (!optionsDone && isShellOption(arg)) continue;
		if (isPathLikeShellArg(arg)) operands.push(arg);
	}
	return { operands, targetDirectory };
}

function rsyncPathArgs(args: string[], segment: string): ShellPathReference[] {
	const operands = rsyncLocalPathOperands(args);
	if (operands.length === 0) return [];
	if (operands.length === 1) return [{ path: operands[0]!, operation: "read", segment }];
	return [
		...operands.slice(0, -1).map((path) => ({ path, operation: "read" as const, segment })),
		{ path: operands[operands.length - 1]!, operation: "write", segment },
	];
}

function tarPathArgs(args: string[], segment: string): ShellPathReference[] {
	const parsed = parseTarArgs(args);
	const references: ShellPathReference[] = [];
	if (!parsed.mode) return references;
	if (parsed.mode === "create") {
		if (parsed.archive) references.push({ path: parsed.archive, operation: "write", segment });
		references.push(...parsed.operands.map((path) => ({ path, operation: "read" as const, segment })));
		return references;
	}
	if (parsed.mode === "extract") {
		if (parsed.archive) references.push({ path: parsed.archive, operation: "read", segment });
		references.push({ path: parsed.directory ?? ".", operation: "write", segment });
	}
	return references;
}

function parseTarArgs(args: string[]): { mode?: "create" | "extract"; archive?: string; directory?: string; operands: string[] } {
	let mode: "create" | "extract" | undefined;
	let archive: string | undefined;
	let directory: string | undefined;
	const operands: string[] = [];
	let optionsDone = false;
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (!optionsDone && arg === "--") {
			optionsDone = true;
			continue;
		}
		if (!optionsDone && arg === "-f") {
			archive = args[++i];
			continue;
		}
		if (!optionsDone && arg === "-C") {
			directory = args[++i];
			continue;
		}
		if (!optionsDone && arg.startsWith("--file=")) {
			archive = valueAfterEquals(arg);
			continue;
		}
		if (!optionsDone && arg.startsWith("--directory=")) {
			directory = valueAfterEquals(arg);
			continue;
		}
		if (!optionsDone && (arg === "--create" || arg === "-c")) {
			mode = "create";
			continue;
		}
		if (!optionsDone && (arg === "--extract" || arg === "-x")) {
			mode = "extract";
			continue;
		}
		if (!optionsDone && /^-[^-]/.test(arg)) {
			const flags = arg.slice(1);
			if (flags.includes("c")) mode = "create";
			if (flags.includes("x")) mode = "extract";
			if (flags.includes("f")) {
				const rest = flags.slice(flags.indexOf("f") + 1);
				archive = rest.length > 0 ? rest : args[++i];
			}
			continue;
		}
		if (!optionsDone && isShellOption(arg)) continue;
		if (isPathLikeShellArg(arg)) operands.push(arg);
	}
	return { mode, archive, directory, operands };
}

function compilerPathArgs(args: string[], segment: string): ShellPathReference[] {
	const references: ShellPathReference[] = [];
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (arg === "-o") {
			const target = args[++i];
			if (target && isPathLikeShellArg(target)) references.push({ path: target, operation: "write", segment });
			continue;
		}
		if (arg.startsWith("-o") && arg.length > 2) {
			const target = arg.slice(2);
			if (isPathLikeShellArg(target)) references.push({ path: target, operation: "write", segment });
		}
	}
	return references;
}

function packageManagerPathArgs(program: string, args: string[], segment: string): ShellPathReference[] {
	const references: ShellPathReference[] = [];
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		const inline = inlinePackagePathOption(program, arg);
		if (inline) {
			references.push({ path: inline.path, operation: inline.operation, segment });
			continue;
		}
		const operation = packagePathOptionOperation(program, arg);
		if (!operation) continue;
		const path = args[++i];
		if (path && isPathLikeShellArg(path)) references.push({ path, operation, segment });
	}
	return references;
}

function inlinePackagePathOption(program: string, arg: string): { path: string; operation: PathOperation } | undefined {
	for (const option of packagePathOptions(program)) {
		if (option.name.startsWith("--") && arg.startsWith(`${option.name}=`)) {
			const path = valueAfterEquals(arg);
			return path ? { path, operation: option.operation } : undefined;
		}
	}
	return undefined;
}

function packagePathOptionOperation(program: string, arg: string): PathOperation | undefined {
	const option = packagePathOptions(program).find((candidate) => candidate.name === arg);
	return option?.operation;
}

function packagePathOptions(program: string): Array<{ name: string; operation: PathOperation }> {
	switch (program) {
		case "npm":
			return [
				{ name: "--prefix", operation: "list" },
				{ name: "--userconfig", operation: "read" },
				{ name: "--cache", operation: "write" },
			];
		case "pnpm":
			return [
				{ name: "-C", operation: "list" },
				{ name: "--dir", operation: "list" },
				{ name: "--store-dir", operation: "write" },
			];
		case "yarn":
		case "bun":
			return [{ name: "--cwd", operation: "list" }];
		case "uv":
		case "uvx":
			return [
				{ name: "--directory", operation: "list" },
				{ name: "--project", operation: "list" },
				{ name: "--config-file", operation: "read" },
				{ name: "--cache-dir", operation: "write" },
			];
		case "pip":
		case "pip3":
			return [{ name: "--cache-dir", operation: "write" }];
		case "poetry":
			return [
				{ name: "-C", operation: "list" },
				{ name: "--directory", operation: "list" },
			];
		default:
			return [];
	}
}

function findRootArgs(args: string[]): string[] {
	const roots: string[] = [];
	for (const arg of args) {
		if (arg === "--") continue;
		if (arg === "!" || arg === "(" || arg === ")" || arg.startsWith("-")) break;
		if (isPathLikeShellArg(arg)) roots.push(arg);
	}
	return roots;
}

function positionalArgs(args: string[], optionsWithValues: Set<string>): string[] {
	const out: string[] = [];
	let optionsDone = false;
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (!optionsDone && arg === "--") {
			optionsDone = true;
			continue;
		}
		if (!optionsDone && optionConsumesNext(arg, optionsWithValues)) {
			i += 1;
			continue;
		}
		if (!optionsDone && isShellOption(arg)) continue;
		if (isPathLikeShellArg(arg)) out.push(arg);
	}
	return out;
}

function optionValueNames(program: string): Set<string> {
	switch (program) {
		case "head":
		case "tail":
			return new Set(["-n", "-c", "--lines", "--bytes"]);
		case "grep":
		case "rg":
			return new Set([
				"-A",
				"-B",
				"-C",
				"-e",
				"-f",
				"-g",
				"-m",
				"--after-context",
				"--before-context",
				"--context",
				"--glob",
				"--max-count",
				"--regexp",
				"--file",
			]);
		case "ls":
			return new Set(["--block-size", "--color", "--format", "--hide", "--ignore", "--quoting-style", "--sort", "--time-style"]);
		case "sed":
			return new Set(["-e", "-f", "--expression", "--file"]);
		case "awk":
			return new Set(["-f", "-F", "-v"]);
		case "tee":
			return new Set(["--output-error"]);
		default:
			return new Set();
	}
}
