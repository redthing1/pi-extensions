import type { HeredocSpec, ShellRedirection } from "./types.js";

export interface RedirectionParseResult {
	command: string;
	redirections: ShellRedirection[];
	reliable: boolean;
	reason?: string;
}

interface WordResult {
	value: string;
	end: number;
	quoted: boolean;
	reliable: boolean;
	reason?: string;
}

interface RedirectionStart {
	index: number;
	operator: string;
}

const WRITE_OPERATORS = new Set([">", ">>", ">|", "<>", "&>", "&>>"]);
const READ_OPERATORS = new Set(["<"]);
const FD_OPERATORS = new Set([">&", "<&"]);

export function parseShellRedirections(raw: string): RedirectionParseResult {
	const commandLine = commandLineForRedirections(raw);
	const redirections: ShellRedirection[] = [];
	let command = "";
	let quote: "'" | "\"" | undefined;
	let escaped = false;

	for (let i = 0; i < commandLine.length; i++) {
		const char = commandLine[i];

		if (quote === "'") {
			command += char;
			if (char === quote) quote = undefined;
			continue;
		}
		if (escaped) {
			command += char;
			escaped = false;
			continue;
		}
		if (char === "\\") {
			command += char;
			escaped = true;
			continue;
		}
		if (quote) {
			command += char;
			if (char === quote) quote = undefined;
			continue;
		}
		if (char === "'" || char === "\"") {
			command += char;
			quote = char;
			continue;
		}

		const redirection = redirectionStartAt(commandLine, i);
		if (!redirection) {
			command += char;
			continue;
		}
		if (redirection.operator === "<<<") {
			return unreliable("here-string redirection is unsupported");
		}

		const targetStart = skipWhitespace(commandLine, redirection.index + redirection.operator.length);
		const target = readShellWord(commandLine, targetStart);
		if (!target.reliable) return unreliable(target.reason ?? "could not parse redirection target");
		if (!target.value) return unreliable("redirection missing target");

		redirections.push(toShellRedirection(redirection.operator, target));
		command += " ";
		i = target.end - 1;
	}

	if (escaped) return unreliable("dangling escape");
	if (quote) return unreliable("unclosed quote");
	return { command: command.trim(), redirections, reliable: true };
}

export function heredocsInCommandLine(commandLine: string): HeredocSpec[] {
	const parsed = parseShellRedirections(commandLine);
	if (!parsed.reliable) return [];
	return parsed.redirections.flatMap((redirection) => (redirection.heredoc ? [redirection.heredoc] : []));
}

function toShellRedirection(operator: string, target: WordResult): ShellRedirection {
	if (operator === "<<" || operator === "<<-") {
		return {
			operator,
			target: target.value,
			heredoc: {
				delimiter: target.value,
				stripTabs: operator === "<<-",
				expands: !target.quoted,
			},
		};
	}
	if (FD_OPERATORS.has(operator) && isFdTarget(target.value)) return { operator, target: target.value };
	if (operator === ">&") return { operator, target: target.value, operation: "write" };
	if (operator === "<&") return { operator, target: target.value, operation: "read" };
	if (WRITE_OPERATORS.has(operator)) return { operator, target: target.value, operation: "write" };
	if (READ_OPERATORS.has(operator)) return { operator, target: target.value, operation: "read" };
	return { operator, target: target.value };
}

function commandLineForRedirections(raw: string): string {
	const newline = raw.indexOf("\n");
	if (newline === -1) return raw;
	const firstLine = raw.slice(0, newline);
	return hasHeredocRedirection(firstLine) ? firstLine : raw;
}

function hasHeredocRedirection(commandLine: string): boolean {
	let quote: "'" | "\"" | undefined;
	let escaped = false;
	for (let i = 0; i < commandLine.length; i++) {
		const char = commandLine[i];
		if (quote === "'") {
			if (char === quote) quote = undefined;
			continue;
		}
		if (escaped) {
			escaped = false;
			continue;
		}
		if (char === "\\") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (char === quote) quote = undefined;
			continue;
		}
		if (char === "'" || char === "\"") {
			quote = char;
			continue;
		}
		const redirection = redirectionStartAt(commandLine, i);
		if (redirection?.operator === "<<" || redirection?.operator === "<<-") return true;
	}
	return false;
}

function redirectionStartAt(input: string, index: number): RedirectionStart | undefined {
	const direct = operatorAt(input, index);
	if (direct) return { index, operator: direct };

	if (!isDigit(input[index])) return undefined;
	let end = index + 1;
	while (isDigit(input[end])) end++;
	const operator = operatorAt(input, end);
	return operator ? { index: end, operator } : undefined;
}

function operatorAt(input: string, index: number): string | undefined {
	const rest = input.slice(index);
	if (rest.startsWith("<<<")) return "<<<";
	if (rest.startsWith("<<-")) return "<<-";
	if (rest.startsWith("<<")) return "<<";
	if (rest.startsWith("&>>")) return "&>>";
	if (rest.startsWith("&>")) return "&>";
	if (rest.startsWith(">>")) return ">>";
	if (rest.startsWith(">|")) return ">|";
	if (rest.startsWith("<>")) return "<>";
	if (rest.startsWith(">&")) return ">&";
	if (rest.startsWith("<&")) return "<&";
	if (rest.startsWith(">")) return ">";
	if (rest.startsWith("<")) return "<";
	return undefined;
}

function readShellWord(input: string, start: number): WordResult {
	if (start >= input.length) return { value: "", end: start, quoted: false, reliable: true };

	let value = "";
	let quote: "'" | "\"" | undefined;
	let escaped = false;
	let quoted = false;

	for (let i = start; i < input.length; i++) {
		const char = input[i];
		if (quote === "'") {
			if (char === quote) {
				quote = undefined;
				continue;
			}
			value += char;
			continue;
		}
		if (escaped) {
			value += char;
			escaped = false;
			continue;
		}
		if (char === "\\") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (char === quote) {
				quote = undefined;
				continue;
			}
			value += char;
			continue;
		}
		if (char === "'" || char === "\"") {
			quote = char;
			quoted = true;
			continue;
		}
		if (/\s/.test(char)) return { value, end: i, quoted, reliable: true };
		value += char;
	}

	if (escaped) return { value: "", end: input.length, quoted, reliable: false, reason: "dangling escape" };
	if (quote) return { value: "", end: input.length, quoted, reliable: false, reason: "unclosed quote" };
	return { value, end: input.length, quoted, reliable: true };
}

function skipWhitespace(input: string, start: number): number {
	let index = start;
	while (/\s/.test(input[index] ?? "")) index++;
	return index;
}

function isFdTarget(value: string): boolean {
	return value === "-" || /^\d+$/.test(value);
}

function isDigit(value: string | undefined): boolean {
	return Boolean(value && value >= "0" && value <= "9");
}

function unreliable(reason: string): RedirectionParseResult {
	return { command: "", redirections: [], reliable: false, reason };
}
