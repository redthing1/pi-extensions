import { posix } from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { parseTeleportTarget } from "./target.ts";

export const TELEPORT_MARKER_TYPE = "pi.teleport.workspace.v1";

export interface TeleportMarker {
	protocolVersion: 1;
	destination: string;
	cwd: string;
}

export function hasTeleportMarker(entries: readonly SessionEntry[]): boolean {
	return entries.some(
		(entry) =>
			entry.type === "custom" && entry.customType === TELEPORT_MARKER_TYPE,
	);
}

export function readTeleportMarker(
	entries: readonly SessionEntry[],
): TeleportMarker | undefined {
	let marker: TeleportMarker | undefined;
	for (const entry of entries) {
		if (
			entry.type !== "custom" ||
			entry.customType !== TELEPORT_MARKER_TYPE
		)
			continue;
		const candidate = parseMarker(entry.data);
		if (marker && !markersEqual(marker, candidate)) {
			throw new Error("Session contains conflicting Teleport markers");
		}
		marker = candidate;
	}
	return marker;
}

export function assertMatchingMarker(
	existing: TeleportMarker,
	requested: TeleportMarker,
): void {
	if (!markersEqual(existing, requested)) {
		throw new Error(
			`Session target mismatch: expected ${existing.destination}:${existing.cwd}, received ${requested.destination}:${requested.cwd}`,
		);
	}
}

function parseMarker(value: unknown): TeleportMarker {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("Session contains a malformed Teleport marker");
	}
	const record = value as Record<string, unknown>;
	if (record.protocolVersion !== 1) {
		if (typeof record.protocolVersion === "number") {
			throw new Error(
				`Session uses unsupported Teleport marker version ${record.protocolVersion}`,
			);
		}
		throw new Error("Session contains a malformed Teleport marker");
	}
	if (
		typeof record.destination !== "string" ||
		typeof record.cwd !== "string" ||
		record.cwd.includes("\0") ||
		!posix.isAbsolute(record.cwd)
	) {
		throw new Error("Session contains a malformed Teleport marker");
	}
	let parsedDestination: ReturnType<typeof parseTeleportTarget>;
	try {
		parsedDestination = parseTeleportTarget(record.destination);
	} catch {
		throw new Error("Session contains a malformed Teleport marker");
	}
	if (
		parsedDestination.destination !== record.destination ||
		parsedDestination.requestedPath !== undefined
	) {
		throw new Error("Session contains a malformed Teleport marker");
	}
	return {
		protocolVersion: 1,
		destination: record.destination,
		cwd: record.cwd,
	};
}

function markersEqual(left: TeleportMarker, right: TeleportMarker): boolean {
	return (
		left.protocolVersion === right.protocolVersion &&
		left.destination === right.destination &&
		left.cwd === right.cwd
	);
}
