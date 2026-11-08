import { isShellOption } from "./args.js";

const JS_PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const PYTHON_PACKAGE_MANAGERS = new Set(["pip", "pip3", "pipx", "uv", "uvx", "poetry"]);
const PACKAGE_EXEC_SHIMS = new Set(["npx", "bunx", "uvx"]);

const JS_MUTATING_COMMANDS = new Set([
	"add",
	"ci",
	"create",
	"dlx",
	"exec",
	"i",
	"init",
	"install",
	"link",
	"publish",
	"rebuild",
	"remove",
	"uninstall",
	"update",
	"upgrade",
	"x",
]);

const PYTHON_MUTATING_COMMANDS = new Set([
	"add",
	"install",
	"inject",
	"reinstall",
	"remove",
	"sync",
	"uninstall",
	"update",
	"upgrade",
]);

export function packageManagerDangerousReason(program: string, args: string[]): string | undefined {
	if (isVersionOnlyArgs(args)) return undefined;
	if (program === "node" && hasInlineJavaScript(args)) return "inline JavaScript execution";
	if (isPythonProgram(program)) {
		const reason = pythonDangerousReason(args);
		if (reason) return reason;
	}
	if (PACKAGE_EXEC_SHIMS.has(program)) return "package code execution";
	if (JS_PACKAGE_MANAGERS.has(program) && jsPackageManagerIsDangerous(program, args)) {
		return "JavaScript package install or execution";
	}
	if (PYTHON_PACKAGE_MANAGERS.has(program) && pythonPackageManagerIsDangerous(program, args)) {
		return "Python package install or execution";
	}
	return undefined;
}

export function isPackageManagerProgram(program: string): boolean {
	return JS_PACKAGE_MANAGERS.has(program) || PYTHON_PACKAGE_MANAGERS.has(program) || PACKAGE_EXEC_SHIMS.has(program);
}

function hasInlineJavaScript(args: string[]): boolean {
	return args.some((arg) => arg === "-e" || arg === "--eval" || arg === "-p" || arg === "--print") || args[0] === "-";
}

function isVersionOnlyArgs(args: string[]): boolean {
	return args.length > 0 && args.every((arg) => arg === "--version" || arg === "-v" || arg === "-V");
}

export function isPythonProgram(program: string): boolean {
	return program === "python" || program === "python3" || /^python3\.\d+$/.test(program) || program === "py";
}

function pythonDangerousReason(args: string[]): string | undefined {
	if (args.some((arg) => arg === "-c")) return "inline Python execution";
	const module = moduleAfterPythonM(args);
	if (!module) return undefined;
	if (module === "pip" || module === "pip3" || module === "pipx" || module === "uv" || module === "poetry") {
		return packageManagerDangerousReason(module, args.slice(args.indexOf("-m") + 2));
	}
	return undefined;
}

function moduleAfterPythonM(args: string[]): string | undefined {
	const index = args.indexOf("-m");
	if (index === -1) return undefined;
	return args[index + 1];
}

function jsPackageManagerIsDangerous(program: string, args: string[]): boolean {
	const command = commandAfterLeadingOptions(args, packageOptionValueNames(program));
	if (!command) return program === "yarn";
	if (program === "yarn" && command === "dlx") return true;
	return JS_MUTATING_COMMANDS.has(command);
}

function pythonPackageManagerIsDangerous(program: string, args: string[]): boolean {
	if (program === "uvx") return true;
	const command = commandAfterLeadingOptions(args, packageOptionValueNames(program));
	if (!command) return false;
	if (program === "pipx" && command === "run") return true;
	if (program === "uv" && command === "pip") {
		const pipCommand = commandAfterLeadingOptions(args.slice(args.indexOf(command) + 1), packageOptionValueNames("pip"));
		return pipCommand !== undefined && PYTHON_MUTATING_COMMANDS.has(pipCommand);
	}
	if (program === "uv" && command === "tool") {
		const toolCommand = commandAfterLeadingOptions(args.slice(args.indexOf(command) + 1), packageOptionValueNames("uv"));
		return toolCommand === "install" || toolCommand === "run" || toolCommand === "upgrade";
	}
	if (program === "poetry" && command === "self") {
		const selfCommand = commandAfterLeadingOptions(args.slice(args.indexOf(command) + 1), packageOptionValueNames("poetry"));
		return selfCommand === "add" || selfCommand === "update";
	}
	return PYTHON_MUTATING_COMMANDS.has(command);
}

function commandAfterLeadingOptions(args: string[], optionsWithValues: Set<string>): string | undefined {
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--") return args[i + 1];
		if (optionsWithValues.has(arg)) {
			i++;
			continue;
		}
		if (hasInlineOptionValue(arg, optionsWithValues)) continue;
		if (isShellOption(arg)) continue;
		return arg;
	}
	return undefined;
}

function packageOptionValueNames(program: string): Set<string> {
	if (program === "npm") return new Set(["--prefix", "--workspace", "-w", "--cache", "--userconfig"]);
	if (program === "pnpm") return new Set(["--dir", "--filter", "-C", "-F", "--workspace-root"]);
	if (program === "yarn") return new Set(["--cwd"]);
	if (program === "bun") return new Set(["--cwd"]);
	if (program === "pip" || program === "pip3") return new Set(["--cache-dir", "--config-settings", "-C"]);
	if (program === "uv" || program === "uvx") return new Set(["--directory", "--project", "--config-file"]);
	if (program === "pipx") return new Set(["--python", "--spec"]);
	if (program === "poetry") return new Set(["--directory", "-C"]);
	return new Set();
}

function hasInlineOptionValue(arg: string, optionsWithValues: Set<string>): boolean {
	for (const option of optionsWithValues) {
		if (option.startsWith("--") && arg.startsWith(`${option}=`)) return true;
	}
	return false;
}
