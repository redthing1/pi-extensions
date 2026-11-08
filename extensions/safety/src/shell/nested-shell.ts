import { tokenizeShellWords } from "./lexer.js";
import { parseShellRedirections } from "./redirections.js";
import { splitShellSegments } from "./segments.js";

const SHELLS_WITH_COMMAND_TEXT = new Set(["bash", "sh", "zsh", "fish"]);
const POWERSHELLS = new Set(["powershell", "pwsh"]);

export interface NestedShellCommand {
	command: string;
	program: string;
}

export interface LiteralNestedShellCommands {
	program: string;
	commands: string[][];
}

export function nestedShellCommand(program: string, args: string[]): NestedShellCommand | undefined {
	if (SHELLS_WITH_COMMAND_TEXT.has(program)) return shellCommandText(program, args);
	if (program === "cmd") return commandAfterOption(program, args, "/c");
	if (POWERSHELLS.has(program)) {
		return commandAfterOption(program, args, "-c") ?? commandAfterOption(program, args, "-command");
	}
	if (program === "trap" && args.length > 1) return { program, command: args[0] };
	if (program === "eval" && args.length > 0) return { program, command: args.join(" ") };
	return undefined;
}

function commandAfterOption(program: string, args: string[], option: string): NestedShellCommand | undefined {
	const index = args.findIndex((arg) => arg.toLowerCase() === option);
	const command = index === -1 ? undefined : args.slice(index + 1).join(" ");
	return command ? { program, command } : undefined;
}

export function literalNestedShellCommands(program: string, args: string[]): LiteralNestedShellCommands | undefined {
	const nested = nestedShellCommand(program, args);
	if (!nested) return undefined;
	return { program: nested.program, commands: literalShellCommandWords(nested.command) };
}

function shellCommandText(program: string, args: string[]): NestedShellCommand | undefined {
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (arg === "--") continue;
		if (arg === "-c") return commandFromNextArg(program, args, i);
		if (arg.startsWith("-") && !arg.startsWith("--")) {
			const command = commandFromShortOptionCluster(program, arg, args, i);
			if (command) return command;
			if (shortOptionConsumesNext(arg)) i += 1;
			continue;
		}
		if (longOptionConsumesNext(arg)) i += 1;
	}
	return undefined;
}

function commandFromNextArg(program: string, args: string[], optionIndex: number): NestedShellCommand | undefined {
	const command = args[optionIndex + 1];
	return command ? { program, command } : undefined;
}

function commandFromShortOptionCluster(program: string, arg: string, args: string[], optionIndex: number): NestedShellCommand | undefined {
	const flags = arg.slice(1);
	const commandFlag = flags.indexOf("c");
	if (commandFlag === -1) return undefined;
	const inlineCommand = flags.slice(commandFlag + 1);
	return inlineCommand.length > 0 ? { program, command: inlineCommand } : commandFromNextArg(program, args, optionIndex);
}

function shortOptionConsumesNext(arg: string): boolean {
	return arg === "-o" || arg === "-O";
}

function longOptionConsumesNext(arg: string): boolean {
	if (!arg.startsWith("--") || arg.includes("=")) return false;
	return arg === "--init-file" || arg === "--rcfile" || arg === "--login-shell";
}

function literalShellCommandWords(command: string): string[][] {
	const split = splitShellSegments(command.trim());
	if (!split.reliable) return [];

	const commands: string[][] = [];
	for (const segment of split.segments) {
		const redirections = parseShellRedirections(segment.raw);
		if (!redirections.reliable) continue;
		const tokenized = tokenizeShellWords(redirections.command);
		if (!tokenized.reliable) continue;
		const words = stripEnvAssignments(tokenized.words);
		if (words.length > 0) commands.push(words);
	}
	return commands;
}

function stripEnvAssignments(words: string[]): string[] {
	const out = [...words];
	while (out[0] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(out[0])) out.shift();
	return out;
}
