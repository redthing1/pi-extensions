import type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions } from "@earendil-works/pi-tui";
import { safeTerminalLabel } from "@earendil-works/pi-tui";
import type { WorkspaceClient, WorkspaceEntry } from "./workspace/client.ts";

const PATH_DELIMITERS = new Set([" ", "\t", '"', "'", "="]);

export function createRemoteAutocompleteProvider(
	current: AutocompleteProvider,
	getWorkspace: () => Pick<WorkspaceClient, "list"> | undefined,
): AutocompleteProvider {
	return {
		triggerCharacters: current.triggerCharacters,
		async getSuggestions(lines, cursorLine, cursorCol, options) {
			const workspace = getWorkspace();
			const textBeforeCursor = (lines[cursorLine] ?? "").slice(0, cursorCol);
			const prefix = isSlashCommand(textBeforeCursor)
				? null
				: extractPathPrefix(textBeforeCursor, options.force === true);
			const suggestions =
				prefix === null
					? await current.getSuggestions(lines, cursorLine, cursorCol, options)
					: workspace
						? await remoteSuggestions(workspace, prefix, options.signal)
						: null;
			if (workspace !== getWorkspace()) return null;
			if (!suggestions) return null;
			const items = suggestions.items
				.filter((item) => !/[\x00-\x1f\x7f-\x9f]/u.test(item.value))
				.map((item) => ({
					...item,
					label: safeTerminalLabel(item.label),
					description: item.description === undefined ? undefined : safeTerminalLabel(item.description),
				}));
			return items.length ? { ...suggestions, items } : null;
		},
		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		},
		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			const textBeforeCursor = (lines[cursorLine] ?? "").slice(0, cursorCol);
			if (!isSlashCommand(textBeforeCursor)) return true;
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	};
}

async function remoteSuggestions(
	workspace: Pick<WorkspaceClient, "list">,
	prefix: string,
	signal: AbortSignal,
): Promise<AutocompleteSuggestions | null> {
	const { rawPrefix, atPrefix, quoted } = parsePrefix(prefix);
	const separator = rawPrefix.lastIndexOf("/");
	const directoryPrefix = separator === -1 ? "" : rawPrefix.slice(0, separator + 1);
	const query = separator === -1 ? rawPrefix : rawPrefix.slice(separator + 1);
	const directory = directoryPrefix || ".";

	try {
		const listing = await workspace.list(directory, 500);
		if (signal.aborted) return null;
		const matches = listing.entries
			.filter((entry) => !/[\x00-\x1f\x7f-\x9f]/u.test(entry.name))
			.filter((entry) => entry.name.toLowerCase().includes(query.toLowerCase()))
			.sort(compareEntries)
			.slice(0, 20)
			.map((entry) => completionItem(entry, directoryPrefix, atPrefix, quoted));
		return matches.length === 0 ? null : { items: matches, prefix };
	} catch {
		return null;
	}
}

function completionItem(
	entry: WorkspaceEntry,
	directoryPrefix: string,
	atPrefix: boolean,
	quoted: boolean,
): AutocompleteItem {
	const directory = entry.kind === "directory";
	const path = `${directoryPrefix}${entry.name}${directory ? "/" : ""}`;
	const quote = quoted || /\s/u.test(path);
	return {
		value: `${atPrefix ? "@" : ""}${quote ? `"${path}"` : path}`,
		label: `${entry.name}${directory ? "/" : ""}`,
		description: path,
	};
}

function compareEntries(left: WorkspaceEntry, right: WorkspaceEntry): number {
	const leftDirectory = left.kind === "directory";
	const rightDirectory = right.kind === "directory";
	if (leftDirectory !== rightDirectory) return leftDirectory ? -1 : 1;
	return left.name.localeCompare(right.name);
}

function parsePrefix(prefix: string): {
	rawPrefix: string;
	atPrefix: boolean;
	quoted: boolean;
} {
	const atPrefix = prefix.startsWith("@");
	const withoutAt = atPrefix ? prefix.slice(1) : prefix;
	const quoted = withoutAt.startsWith('"');
	return {
		rawPrefix: quoted ? withoutAt.slice(1) : withoutAt,
		atPrefix,
		quoted,
	};
}

function extractPathPrefix(text: string, force: boolean): string | null {
	const quoteStart = text.lastIndexOf('"');
	if (quoteStart !== -1 && text.slice(0, quoteStart).split('"').length % 2 === 1) {
		const atStart = quoteStart > 0 && text[quoteStart - 1] === "@";
		return text.slice(atStart ? quoteStart - 1 : quoteStart);
	}

	let delimiter = -1;
	for (let index = text.length - 1; index >= 0; index -= 1) {
		if (PATH_DELIMITERS.has(text[index] ?? "")) {
			delimiter = index;
			break;
		}
	}
	const prefix = text.slice(delimiter + 1);
	if (prefix.startsWith("@") || force) return prefix;
	if (prefix.includes("/") || prefix.startsWith(".")) return prefix;
	return prefix === "" && text.endsWith(" ") ? prefix : null;
}

function isSlashCommand(text: string): boolean {
	return text.trimStart().startsWith("/");
}
