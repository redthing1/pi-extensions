import type { PathOperation } from "../paths/types.js";

export interface GitPathArgument {
	path: string;
	operation: PathOperation;
	source: string;
}

export interface GitInvocation {
	subcommand?: string;
	subcommandArgs: string[];
	globalPaths: GitPathArgument[];
	unsupportedGlobalOptions: string[];
}

const SAFE_GLOBAL_FLAGS = new Set([
	"--no-pager",
	"--literal-pathspecs",
	"--glob-pathspecs",
	"--noglob-pathspecs",
	"--icase-pathspecs",
	"--no-replace-objects",
]);

const UNSUPPORTED_GLOBAL_OPTIONS_WITH_VALUE = new Set([
	"-c",
	"--config-env",
	"--exec-path",
	"--git-dir",
	"--work-tree",
	"--namespace",
	"--super-prefix",
]);

const UNSUPPORTED_GLOBAL_OPTION_PREFIXES = [
	"-c",
	"--config-env=",
	"--exec-path=",
	"--git-dir=",
	"--work-tree=",
	"--namespace=",
	"--super-prefix=",
];

const READ_ONLY_SUBCOMMANDS = new Set(["blame", "branch", "diff", "grep", "log", "ls-files", "remote", "rev-parse", "show", "status"]);

const OUTPUT_FLAGS = new Set(["-o", "--output"]);

const BRANCH_MUTATING_FLAGS = new Set([
	"-d",
	"-D",
	"-m",
	"-M",
	"-c",
	"-C",
	"--delete",
	"--move",
	"--copy",
	"--force",
	"--set-upstream-to",
	"--unset-upstream",
	"--edit-description",
]);

const BRANCH_READ_FILTER_FLAGS = new Set(["--contains", "--no-contains", "--merged", "--no-merged", "--points-at"]);

export function parseGitInvocation(args: string[]): GitInvocation {
	const invocation: GitInvocation = {
		subcommandArgs: [],
		globalPaths: [],
		unsupportedGlobalOptions: [],
	};

	let index = 0;
	while (index < args.length) {
		const arg = args[index];
		if (!arg) break;

		if (arg === "--") {
			index++;
			break;
		}

		if (arg === "-C") {
			const value = args[index + 1];
			if (!value) {
				invocation.unsupportedGlobalOptions.push("-C without path");
				index++;
			} else {
				invocation.globalPaths.push({ path: value, operation: "list", source: "-C" });
				index += 2;
			}
			continue;
		}

		if (arg.startsWith("-C") && arg.length > 2) {
			invocation.globalPaths.push({ path: arg.slice(2), operation: "list", source: "-C" });
			index++;
			continue;
		}

		if (SAFE_GLOBAL_FLAGS.has(arg)) {
			index++;
			continue;
		}

		const unsupportedValueOption = unsupportedGlobalOptionWithValue(arg);
		if (unsupportedValueOption) {
			invocation.unsupportedGlobalOptions.push(arg);
			index += unsupportedValueOption.consumesNext ? 2 : 1;
			continue;
		}

		if (arg.startsWith("-")) {
			invocation.unsupportedGlobalOptions.push(arg);
			index++;
			continue;
		}

		invocation.subcommand = arg;
		invocation.subcommandArgs = args.slice(index + 1);
		return invocation;
	}

	if (index < args.length) {
		invocation.subcommand = args[index];
		invocation.subcommandArgs = args.slice(index + 1);
	}

	return invocation;
}

export function checkGitReadOnly(args: string[]): { safe: boolean; reason: string } {
	const invocation = parseGitInvocation(args);
	const unsupported = invocation.unsupportedGlobalOptions[0];
	if (unsupported) return { safe: false, reason: `git global option ${unsupported} is not read-only allowlisted` };

	const subcommand = invocation.subcommand;
	if (!subcommand) return { safe: true, reason: "git without subcommand is read-only help output" };
	if (!READ_ONLY_SUBCOMMANDS.has(subcommand)) return { safe: false, reason: `git ${subcommand} is not read-only allowlisted` };
	if (hasOutputFlag(invocation.subcommandArgs)) return { safe: false, reason: `git ${subcommand} output flag can write files` };
	if (subcommand === "branch") return checkGitBranch(invocation.subcommandArgs);
	if (subcommand === "remote") return checkGitRemote(invocation.subcommandArgs);
	return { safe: true, reason: `git ${subcommand} is read-only allowlisted` };
}

export function gitDangerousReason(args: string[]): string | undefined {
	const invocation = parseGitInvocation(args);
	const subcommand = invocation.subcommand;
	if (subcommand === "reset" && invocation.subcommandArgs.includes("--hard")) return "hard git reset";
	if (subcommand === "clean") return "git clean can delete files";
	if (subcommand === "push" && invocation.subcommandArgs.some((arg) => arg === "--force" || arg === "-f")) return "force push";
	return undefined;
}

export function gitPathArguments(args: string[]): GitPathArgument[] {
	const invocation = parseGitInvocation(args);
	const paths = [...invocation.globalPaths];
	if (!invocation.subcommand) return paths;
	for (const path of gitSubcommandPathspecs(invocation.subcommand, invocation.subcommandArgs)) {
		paths.push({ path, operation: "read", source: invocation.subcommand });
	}
	return paths;
}

function unsupportedGlobalOptionWithValue(arg: string): { consumesNext: boolean } | undefined {
	if (UNSUPPORTED_GLOBAL_OPTIONS_WITH_VALUE.has(arg)) return { consumesNext: true };
	if (UNSUPPORTED_GLOBAL_OPTION_PREFIXES.some((prefix) => arg.startsWith(prefix) && arg.length > prefix.length)) {
		return { consumesNext: false };
	}
	return undefined;
}

function hasOutputFlag(args: string[]): boolean {
	return args.some((arg) => OUTPUT_FLAGS.has(arg) || arg.startsWith("--output="));
}

function checkGitBranch(args: string[]): { safe: boolean; reason: string } {
	if (args.some((arg) => BRANCH_MUTATING_FLAGS.has(arg))) return { safe: false, reason: "git branch mutation flag" };
	const positionals = positionalArgs(args, BRANCH_READ_FILTER_FLAGS);
	const hasExplicitListMode = args.includes("--list") || args.includes("-l") || args.includes("-a") || args.includes("-r");
	const hasReadFilter = args.some((arg) => BRANCH_READ_FILTER_FLAGS.has(arg) || startsWithAny(arg, ["--contains=", "--no-contains=", "--merged=", "--no-merged=", "--points-at="]));
	if (positionals.length > 0 && !hasExplicitListMode && !hasReadFilter) {
		return { safe: false, reason: "git branch positional argument can create a branch" };
	}
	return { safe: true, reason: "git branch listing is read-only allowlisted" };
}

function checkGitRemote(args: string[]): { safe: boolean; reason: string } {
	if (args.length === 0 || args.every((arg) => arg === "-v" || arg === "--verbose")) {
		return { safe: true, reason: "git remote listing is read-only allowlisted" };
	}
	if (args[0] === "get-url") return { safe: true, reason: "git remote get-url is read-only allowlisted" };
	return { safe: false, reason: `git remote ${args[0] ?? ""} is not read-only allowlisted` };
}

function gitSubcommandPathspecs(subcommand: string, args: string[]): string[] {
	if (!READ_ONLY_SUBCOMMANDS.has(subcommand)) return [];
	if (subcommand === "remote" || subcommand === "rev-parse") return [];
	const separator = args.indexOf("--");
	if (separator >= 0) return args.slice(separator + 1).filter(isPathspec);
	if (subcommand === "status" || subcommand === "diff" || subcommand === "grep" || subcommand === "ls-files" || subcommand === "blame") {
		return positionalArgs(args, new Set()).filter(isPathspec);
	}
	return [];
}

function positionalArgs(args: string[], flagsWithValues: Set<string>): string[] {
	const positionals: string[] = [];
	let endOfOptions = false;
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (!arg) continue;
		if (!endOfOptions && arg === "--") {
			endOfOptions = true;
			continue;
		}
		if (!endOfOptions && flagsWithValues.has(arg)) {
			index++;
			continue;
		}
		if (!endOfOptions && startsWithAny(arg, Array.from(flagsWithValues).map((flag) => `${flag}=`))) continue;
		if (!endOfOptions && arg.startsWith("-")) continue;
		positionals.push(arg);
	}
	return positionals;
}

function isPathspec(arg: string): boolean {
	return arg.length > 0 && !arg.includes("..");
}

function startsWithAny(value: string, prefixes: string[]): boolean {
	return prefixes.some((prefix) => value.startsWith(prefix));
}
