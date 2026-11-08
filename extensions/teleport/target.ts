export interface TeleportTarget {
	destination: string;
	requestedPath: string | undefined;
}

export function teleportStartupPath(target: TeleportTarget): string {
	return target.requestedPath || ".";
}

export function parseTeleportTarget(value: string): TeleportTarget {
	if (value.length === 0) throw new Error("Teleport target is empty");
	const hostPortion = value.includes("@") ? value.slice(value.lastIndexOf("@") + 1) : value;
	if (!hostPortion.startsWith("[") && (hostPortion.match(/:/g)?.length ?? 0) >= 2 && /^[0-9a-f:.]+$/i.test(hostPortion)) {
		throw new Error("IPv6 destinations must be enclosed in brackets");
	}

	let bracketDepth = 0;
	let separator = -1;
	for (let index = 0; index < value.length; index += 1) {
		const character = value[index];
		if (character === "[") {
			if (bracketDepth !== 0) throw new Error("Teleport target has nested brackets");
			bracketDepth = 1;
			continue;
		}
		if (character === "]") {
			if (bracketDepth !== 1) throw new Error("Teleport target has an unmatched closing bracket");
			bracketDepth = 0;
			continue;
		}
		if (character === ":" && bracketDepth === 0) {
			separator = index;
			break;
		}
	}

	if (bracketDepth !== 0) throw new Error("Teleport target has an unmatched opening bracket");

	const destination = separator === -1 ? value : value.slice(0, separator);
	if (destination.length === 0) throw new Error("Teleport destination is empty");
	if (destination.startsWith("-")) throw new Error("Teleport destination cannot begin with '-'");
	if (/\s/.test(destination)) throw new Error("Teleport destination cannot contain whitespace");

	return {
		destination,
		requestedPath: separator === -1 ? undefined : value.slice(separator + 1),
	};
}
