export function tokenizeShellWords(segment: string): { words: string[]; reliable: boolean; reason?: string } {
	const words: string[] = [];
	let current = "";
	let hasCurrent = false;
	let quote: "'" | "\"" | undefined;
	let escaped = false;

	for (let i = 0; i < segment.length; i++) {
		const char = segment[i];
		if (quote === "'") {
			if (char === "'") {
				quote = undefined;
			} else {
				current += char;
				hasCurrent = true;
			}
			continue;
		}
		if (escaped) {
			current += char;
			hasCurrent = true;
			escaped = false;
			continue;
		}
		if (char === "\\") {
			if (isWindowsPathSeparator(current, segment[i + 1])) {
				current += char;
				hasCurrent = true;
				continue;
			}
			escaped = true;
			continue;
		}
		if (quote) {
			if (char === quote) {
				quote = undefined;
			} else {
				current += char;
				hasCurrent = true;
			}
			continue;
		}
		if (char === "'" || char === "\"") {
			quote = char;
			hasCurrent = true;
			continue;
		}
		if (/\s/.test(char)) {
			if (hasCurrent) {
				words.push(current);
				current = "";
				hasCurrent = false;
			}
			continue;
		}
		current += char;
		hasCurrent = true;
	}
	if (escaped) return { words: [], reliable: false, reason: "dangling escape" };
	if (quote) return { words: [], reliable: false, reason: "unclosed quote" };
	if (hasCurrent) words.push(current);
	return { words, reliable: true };
}

function isWindowsPathSeparator(current: string, next: string | undefined): boolean {
	return /^[A-Za-z]:/u.test(current) || current.startsWith("\\") || (current.length === 0 && next === "\\");
}
