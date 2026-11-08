import { posix, win32 } from "node:path";
import { resolvePathTarget } from "../safety/src/shell/catastrophic-targets.ts";
import { parseCdInvocation } from "../safety/src/shell/cd.ts";
import { parseFindInvocation } from "../safety/src/shell/find.ts";
import { normalizeInvocation } from "../safety/src/shell/invocation.ts";
import { tokenizeShellWords } from "../safety/src/shell/lexer.ts";
import { nestedShellCommand } from "../safety/src/shell/nested-shell.ts";
import { parseShellRedirections } from "../safety/src/shell/redirections.ts";
import { splitShellSegments } from "../safety/src/shell/segments.ts";
import { literalCommandSubstitutions } from "../safety/src/shell/substitutions.ts";
import type { GuardContext, GuardViolation } from "./policy.ts";

export function inspectTraversal(roots: readonly string[], context: GuardContext): GuardViolation | undefined {
	for (const root of roots) {
		const resolved = resolvePathTarget(root, context);
		if (!resolved) continue;
		const paths = context.pathStyle === "win32" ? win32 : posix;
		if (resolved === paths.parse(resolved).root || /^\/mnt\/[a-z]\/?$/iu.test(resolved)) {
			return {
				category: "reckless",
				rule: "root-traversal",
				reason: `unbounded recursive traversal of filesystem root ${resolved}`,
			};
		}
	}
	return undefined;
}

export function recklessViolation(command: string, context: GuardContext, depth = 0): GuardViolation | undefined {
	if (depth > 4) return undefined; // The catastrophic classifier owns nesting limits.
	const split = splitShellSegments(command);
	if (!split.reliable) return undefined;
	let current = context;
	for (const segment of split.segments) {
		const redirected = parseShellRedirections(segment.raw);
		if (!redirected.reliable) continue;
		for (const substitution of literalCommandSubstitutions(redirected.command).commands) {
			const violation = recklessViolation(substitution, current, depth + 1);
			if (violation) return violation;
		}
		const tokens = tokenizeShellWords(redirected.command);
		if (!tokens.reliable) continue;
		const words = [...tokens.words];
		while (words[0] && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(words[0])) words.shift();
		if (!words[0]) continue;
		const invocation = normalizeInvocation(words[0], words.slice(1));
		let invocationContext = current;
		for (const directory of invocation.directories) {
			const cwd = resolvePathTarget(directory, invocationContext);
			if (cwd) invocationContext = { ...invocationContext, cwd };
		}
		const { program, args } = invocation;
		const nested = nestedShellCommand(program, args);
		if (nested) {
			const shell = nested.program === "pwsh" || nested.program === "powershell" ? "powershell" : current.shell;
			const violation = recklessViolation(nested.command, { ...invocationContext, shell }, depth + 1);
			if (violation) return violation;
		}
		if (program === "cd") {
			const cd = parseCdInvocation(args);
			const cwd = cd.supported && cd.target ? resolvePathTarget(cd.target, current) : undefined;
			if (cwd) current = { ...current, cwd };
			continue;
		}
		const traversal = traversalRoots(program, args, current.shell);
		if (!traversal) continue;
		const cwd = traversal.base ? resolvePathTarget(traversal.base, invocationContext) : invocationContext.cwd;
		const violation = inspectTraversal(traversal.roots, { ...invocationContext, cwd: cwd ?? invocationContext.cwd });
		if (violation) return violation;
	}
	return undefined;
}

interface Traversal {
	roots: string[];
	base?: string;
}

// Only value-taking options are listed. All other options are flags.
const SEARCH_VALUES = [
	"-e",
	"--regexp",
	"-f",
	"--file",
	"-m",
	"--max-count",
	"-A",
	"-B",
	"-C",
	"--after-context",
	"--before-context",
	"--context",
	"--include",
	"--exclude",
	"--exclude-dir",
	"--exclude-from",
	"--binary-files",
	"-d",
	"--directories",
	"-D",
	"--devices",
];
const RG_VALUES = [
	...SEARCH_VALUES,
	"--color",
	"-g",
	"--glob",
	"--iglob",
	"-t",
	"--type",
	"-T",
	"--type-not",
	"--type-add",
	"--type-clear",
	"--max-depth",
	"--max-filesize",
	"-j",
	"--threads",
	"-E",
	"--encoding",
	"--ignore-file",
	"--colors",
	"--engine",
	"--sort",
	"--sortr",
];
const FD_VALUES = [
	"-d",
	"--max-depth",
	"--min-depth",
	"-t",
	"--type",
	"-e",
	"--extension",
	"-E",
	"--exclude",
	"-S",
	"--size",
	"-j",
	"--threads",
	"--base-directory",
	"--search-path",
	"--ignore-file",
	"--changed-within",
	"--changed-before",
	"--owner",
	"--format",
	"-c",
	"--color",
];

function traversalRoots(program: string, args: string[], shell: GuardContext["shell"]): Traversal | undefined {
	if (["get-childitem", "gci"].includes(program) || (shell === "powershell" && ["dir", "ls"].includes(program))) {
		const parsed = parseArguments(
			args.map((arg) => (arg.startsWith("-") ? arg.toLowerCase() : arg)),
			["-path", "-literalpath", "-depth", "-filter", "-include", "-exclude"],
			{ namedFlags: ["-recurse"] },
		);
		if ((!hasFlag(parsed, ["-recurse"]) && !parsed.options.has("-depth")) || shallow(parsed, ["-depth"])) return;
		const roots = [...values(parsed, "-path"), ...values(parsed, "-literalpath"), ...parsed.operands];
		return { roots: roots.length ? roots : ["."] };
	}
	if (program === "find") {
		const find = parseFindInvocation(args);
		return find.shallow ? undefined : { roots: find.roots };
	}
	if (program === "fd" || program === "fdfind") {
		const parsed = parseArguments(args, FD_VALUES, { stopAt: ["-x", "--exec", "-X", "--exec-batch"] });
		if (shallow(parsed, ["-d", "--max-depth"])) return;
		const roots = [...values(parsed, "--search-path"), ...parsed.operands.slice(1)];
		return { roots: roots.length ? roots : ["."], base: values(parsed, "--base-directory").at(-1) };
	}
	if (program === "rg" || program === "grep") {
		const parsed = parseArguments(args, program === "rg" ? RG_VALUES : SEARCH_VALUES);
		if (
			program === "grep" &&
			!hasFlag(parsed, ["-r", "-R", "--recursive", "--dereference-recursive"]) &&
			!["-d", "--directories"].some((key) => values(parsed, key).includes("recurse"))
		)
			return;
		if (program === "rg" && shallow(parsed, ["--max-depth"])) return;
		const explicitPattern = hasFlag(parsed, ["-e", "--regexp", "-f", "--file"]);
		const roots = parsed.operands.slice(explicitPattern || hasFlag(parsed, ["--files"]) ? 0 : 1);
		return { roots: roots.length ? roots : ["."] };
	}
	if (program === "du" || program === "ls" || program === "tree") {
		const valueOptions =
			program === "tree"
				? ["-L", "-P", "-I", "-o", "--filelimit", "--sort", "--charset"]
				: program === "du"
					? ["-d", "--max-depth", "-B", "--block-size", "-t", "--threshold", "--exclude", "-X", "--exclude-from"]
					: [
							"-I",
							"--ignore",
							"--block-size",
							"--time-style",
							"--sort",
							"--format",
							"--width",
							"--tabsize",
							"--indicator-style",
						];
		const parsed = parseArguments(args, valueOptions);
		if (program === "ls" && !hasFlag(parsed, ["-R", "--recursive"])) return;
		if (program === "tree" && shallow(parsed, ["-L"])) return;
		return { roots: parsed.operands.length ? parsed.operands : ["."] };
	}
	return undefined;
}

interface ParsedArguments {
	operands: string[];
	options: Map<string, string[]>;
}

function parseArguments(
	args: readonly string[],
	valueOptions: readonly string[],
	options: { stopAt?: readonly string[]; namedFlags?: readonly string[] } = {},
): ParsedArguments {
	const parsed: ParsedArguments = { operands: [], options: new Map() };
	const takesValue = new Set(valueOptions);
	const add = (key: string, value = "") => parsed.options.set(key, [...(parsed.options.get(key) ?? []), value]);
	let optionsDone = false;
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (optionsDone || arg === "-" || !arg.startsWith("-")) {
			parsed.operands.push(arg);
			continue;
		}
		if (arg === "--") {
			optionsDone = true;
			continue;
		}
		if (options.stopAt?.includes(arg)) break;
		const equals = arg.indexOf("=");
		const key = equals === -1 ? arg : arg.slice(0, equals);
		if (takesValue.has(key)) {
			add(key, equals === -1 ? (args[++index] ?? "") : arg.slice(equals + 1));
			continue;
		}
		if (arg.startsWith("--") || options.namedFlags?.includes(arg)) {
			add(key);
			continue;
		}
		for (let letter = 1; letter < arg.length; letter++) {
			const short = "-" + arg[letter];
			if (takesValue.has(short)) {
				add(short, arg.slice(letter + 1) || args[++index] || "");
				break;
			}
			add(short);
		}
	}
	return parsed;
}

function values(parsed: ParsedArguments, key: string): string[] {
	return parsed.options.get(key) ?? [];
}
function hasFlag(parsed: ParsedArguments, keys: readonly string[]): boolean {
	return keys.some((key) => parsed.options.has(key));
}
function shallow(parsed: ParsedArguments, keys: readonly string[]): boolean {
	const depths = keys.flatMap((key) => values(parsed, key));
	return depths.length > 0 && depths.every((depth) => /^(?:0|1)$/u.test(depth));
}
