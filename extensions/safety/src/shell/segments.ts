import { heredocsInCommandLine } from "./redirections.js";
import type { HeredocSpec, ShellSeparator } from "./types.js";

export interface SplitSegment {
	raw: string;
	separatorBefore?: ShellSeparator;
}

export function splitShellSegments(command: string): { segments: SplitSegment[]; reliable: boolean; reason?: string } {
	const segments: SplitSegment[] = [];
	let current = "";
	let quote: "'" | "\"" | undefined;
	let escaped = false;
	let separatorBefore: ShellSeparator | undefined;

	for (let i = 0; i < command.length; i++) {
		const char = command[i];
		const next = command[i + 1];
		if (quote === "'") {
			current += char;
			if (char === quote) quote = undefined;
			continue;
		}
		if (escaped) {
			current += char;
			escaped = false;
			continue;
		}
		if (char === "\\") {
			current += char;
			escaped = true;
			continue;
		}
		if (quote) {
			current += char;
			if (char === quote) quote = undefined;
			continue;
		}
		if (char === "'" || char === "\"") {
			current += char;
			quote = char;
			continue;
		}
		if (char === "\n") {
			const heredocs = heredocsInCommandLine(current);
			if (heredocs.length > 0) {
				const consumed = consumeHeredocs(command, i + 1, heredocs);
				if (!consumed.reliable) return { segments: [], reliable: false, reason: consumed.reason };
				current += char + consumed.text;
				pushCurrent(segments, current, separatorBefore);
				current = "";
				separatorBefore = ";";
				i = consumed.end - 1;
				continue;
			}
			pushCurrent(segments, current, separatorBefore);
			current = "";
			separatorBefore = ";";
			continue;
		}
		const separator: ShellSeparator | undefined =
			char === "&" && next === "&"
				? "&&"
				: char === "&"
					? "&"
					: char === "|" && next === "|"
						? "||"
						: char === "|"
							? "|"
							: char === ";"
								? ";"
								: undefined;
		if (separator) {
			pushCurrent(segments, current, separatorBefore);
			current = "";
			separatorBefore = separator;
			if (separator.length === 2) i++;
			continue;
		}
		current += char;
	}

	if (escaped) return { segments: [], reliable: false, reason: "dangling escape" };
	if (quote) return { segments: [], reliable: false, reason: "unclosed quote" };
	pushCurrent(segments, current, separatorBefore);
	return { segments, reliable: true };
}

export function hasUnquotedShellFeature(command: string): string | undefined {
	let quote: "'" | "\"" | undefined;
	let escaped = false;
	for (let i = 0; i < command.length; i++) {
		const char = command[i];
		const next = command[i + 1];
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
		if (quote === "\"" && char === quote) {
			quote = undefined;
			continue;
		}
		if (char === "`") return "command substitution";
		if (char === "$" && next === "(") return "command substitution";
		if (char === "$") {
			const expansion = shellExpansionFeature(command, i);
			if (expansion.unsupported) return expansion.reason;
			i = expansion.end;
			continue;
		}
		if (quote === "\"") continue;
		if (char === "'" || char === "\"") {
			quote = char;
			continue;
		}
	}
	if (escaped) return "dangling escape";
	if (quote) return "unclosed quote";
	return undefined;
}

function consumeHeredocs(command: string, start: number, heredocs: HeredocSpec[]): { text: string; end: number; reliable: boolean; reason?: string } {
	let text = "";
	let index = start;
	for (const heredoc of heredocs) {
		const consumed = consumeSingleHeredoc(command, index, heredoc);
		if (!consumed.reliable) return consumed;
		text += consumed.text;
		index = consumed.end;
	}
	return { text, end: index, reliable: true };
}

function consumeSingleHeredoc(command: string, start: number, heredoc: HeredocSpec): { text: string; end: number; reliable: boolean; reason?: string } {
	let index = start;
	while (index <= command.length) {
		const nextNewline = command.indexOf("\n", index);
		const lineEnd = nextNewline === -1 ? command.length : nextNewline;
		const line = command.slice(index, lineEnd);
		const marker = heredoc.stripTabs ? line.replace(/^\t+/, "") : line;
		const end = nextNewline === -1 ? lineEnd : lineEnd + 1;
		const text = command.slice(start, end);
		if (marker === heredoc.delimiter) return { text, end, reliable: true };
		if (nextNewline === -1) break;
		index = nextNewline + 1;
	}
	return { text: "", end: command.length, reliable: false, reason: "unterminated heredoc" };
}

function shellExpansionFeature(command: string, index: number): { unsupported: boolean; reason?: string; end: number } {
	const next = command[index + 1];
	if (!next) return { unsupported: false, end: index };
	if (next === "'" || next === "\"") return { unsupported: true, reason: "dollar quote", end: index + 1 };
	if (next === "{") {
		const endBrace = command.indexOf("}", index + 2);
		if (endBrace === -1) return { unsupported: true, reason: "unclosed parameter expansion", end: index + 1 };
		const name = command.slice(index + 2, endBrace);
		return name === "HOME"
			? { unsupported: false, end: endBrace }
			: { unsupported: true, reason: "parameter expansion", end: endBrace };
	}
	if (/[A-Za-z_]/.test(next)) {
		let end = index + 2;
		while (/[A-Za-z0-9_]/.test(command[end] ?? "")) end++;
		const name = command.slice(index + 1, end);
		return name === "HOME"
			? { unsupported: false, end: end - 1 }
			: { unsupported: true, reason: "parameter expansion", end: end - 1 };
	}
	if (/[0-9@*#?$!-]/.test(next)) return { unsupported: true, reason: "parameter expansion", end: index + 1 };
	return { unsupported: false, end: index };
}

function pushCurrent(segments: SplitSegment[], current: string, separatorBefore: ShellSeparator | undefined): void {
	const raw = current.trim();
	if (raw.length > 0) segments.push({ raw, separatorBefore });
}
