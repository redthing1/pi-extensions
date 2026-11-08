import { parseCdInvocation } from "./cd.js";
import { checkGitReadOnly } from "./git.js";
import { isPackageManagerProgram, isPythonProgram } from "./package-managers.js";

const SAFE_COMMANDS = new Set([
	"awk",
	"basename",
	"cat",
	"cd",
	"date",
	"diff",
	"dirname",
	"du",
	"echo",
	"fd",
	"file",
	"find",
	"git",
	"grep",
	"head",
	"jq",
	"ls",
	"pwd",
	"rg",
	"sed",
	"sort",
	"tail",
	"tree",
	"uname",
	"uniq",
	"wc",
	"which",
	"whoami",
]);

const SAFE_GIT_SUBCOMMANDS = new Set(["blame", "branch", "diff", "grep", "log", "ls-files", "remote", "rev-parse", "show", "status"]);

export function isKnownReadOnlyCommand(program: string, args: string[]): { safe: boolean; reason: string } {
	if (!SAFE_COMMANDS.has(program)) return { safe: false, reason: `${program} is not a known local read-only command` };
	if (program === "cd") return checkCd(args);
	if (program === "git") return checkGitReadOnly(args);
	if (program === "sed" && args.some((arg) => arg === "-i" || arg.startsWith("-i"))) {
		return { safe: false, reason: "sed -i mutates files" };
	}
	if (program === "find" && args.some((arg) => arg === "-exec" || arg === "-delete" || arg === "-ok")) {
		return { safe: false, reason: "find action can mutate files or execute commands" };
	}
	return { safe: true, reason: "known local read-only command" };
}

export function isVersionOnlyCommand(program: string, args: string[]): boolean {
	if (isPythonModuleVersionOnly(program, args)) return true;
	if (
		program !== "node" &&
		program !== "python" &&
		program !== "python3" &&
		!/^python3\.\d+$/.test(program) &&
		!isPackageManagerProgram(program)
	) {
		return false;
	}
	if (args.length === 0) return false;
	return args.every((arg) => arg === "--version" || arg === "-v" || arg === "-V");
}

function isPythonModuleVersionOnly(program: string, args: string[]): boolean {
	if (!isPythonProgram(program)) return false;
	const moduleIndex = args.indexOf("-m");
	if (moduleIndex === -1) return false;
	const moduleName = args[moduleIndex + 1];
	if (!moduleName || !isPackageManagerProgram(moduleName)) return false;
	const rest = args.slice(moduleIndex + 2);
	return rest.length > 0 && rest.every((arg) => arg === "--version" || arg === "-v" || arg === "-V");
}

function checkCd(args: string[]): { safe: boolean; reason: string } {
	const parsed = parseCdInvocation(args);
	if (!parsed.supported) return { safe: false, reason: parsed.reason };
	return { safe: true, reason: "cd only changes this shell process directory" };
}
