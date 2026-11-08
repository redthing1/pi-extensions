export interface LiteralCommandSubstitutions {
	commands: string[];
	reliable: boolean;
}

export function literalCommandSubstitutions(command: string): LiteralCommandSubstitutions {
	const commands: string[] = [];
	let quote: "'" | "\"" | undefined;
	let escaped = false;

	for (let index = 0; index < command.length; index++) {
		const char = command[index];
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
		if (char === "'") {
			if (!quote) quote = char;
			continue;
		}
		if (char === "\"") {
			quote = quote === char ? undefined : quote ?? char;
			continue;
		}
		if (char === "`") {
			const end = closingBacktick(command, index + 1);
			if (end === -1) return { commands, reliable: false };
			commands.push(command.slice(index + 1, end));
			index = end;
			continue;
		}
		if (char !== "$" || command[index + 1] !== "(" || command[index + 2] === "(") continue;

		const end = closingCommandSubstitution(command, index + 2);
		if (end === -1) return { commands, reliable: false };
		commands.push(command.slice(index + 2, end));
		index = end;
	}

	return { commands, reliable: true };
}

function closingBacktick(command: string, start: number): number {
	let escaped = false;
	for (let index = start; index < command.length; index++) {
		const char = command[index];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (char === "\\") {
			escaped = true;
			continue;
		}
		if (char === "`") return index;
	}
	return -1;
}

function closingCommandSubstitution(command: string, start: number): number {
	let depth = 1;
	let quote: "'" | "\"" | undefined;
	let escaped = false;

	for (let index = start; index < command.length; index++) {
		const char = command[index];
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
		if (char === "'") {
			if (!quote) quote = char;
			continue;
		}
		if (char === "\"") {
			quote = quote === char ? undefined : quote ?? char;
			continue;
		}
		if (quote === "\"") continue;
		if (char === "(") depth++;
		if (char === ")" && --depth === 0) return index;
	}
	return -1;
}
