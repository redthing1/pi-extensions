import { createReadStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, posix } from "node:path";
import type { WorkspaceChildOperations } from "../../shared/active-workspace.ts";
import { parseTeleportTarget } from "../target.ts";
import type { MasterConnection } from "../transport/master.ts";

const HANDOFF_FD_ENV = "PI_ACTIVE_WORKSPACE_HANDOFF_FD";
const MAX_HANDOFF_BYTES = 64 * 1024;

export interface TeleportHandoff {
	destination: string;
	cwd: string;
	socketPath: string;
}

export function consumeChildHandoff():
	| {
			present: false;
	  }
	| {
			present: true;
			value: Promise<TeleportHandoff>;
	  } {
	const descriptor = process.env[HANDOFF_FD_ENV];
	delete process.env[HANDOFF_FD_ENV];
	if (descriptor === undefined) return { present: false };

	const fd = parseHandoffFd(descriptor);
	return {
		present: true,
		value:
			fd === undefined ? Promise.reject(new Error("Teleport child handoff descriptor is invalid")) : readHandoff(fd),
	};
}

export function createChildWorkspaceOperations(
	master: MasterConnection,
	extensionPath: string,
): WorkspaceChildOperations {
	return {
		async prepareChild(request) {
			const handoff = master.handoff();
			const payload: TeleportHandoff = { ...handoff, cwd: request.cwd };
			const hostCwd = await mkdtemp(join(tmpdir(), "pi-teleport-child-"));
			return {
				args: [
					"--no-extensions",
					"--no-skills",
					"--no-prompt-templates",
					"--no-context-files",
					"--extension",
					extensionPath,
				],
				hostCwd,
				env: { [HANDOFF_FD_ENV]: "3" },
				writeHandoff(stream) {
					stream.end(JSON.stringify(payload));
				},
				dispose: () => rm(hostCwd, { recursive: true, force: true }),
			};
		},
	};
}

function parseHandoffFd(value: string): number | undefined {
	if (!/^[0-9]+$/u.test(value)) return undefined;
	const fd = Number(value);
	return Number.isSafeInteger(fd) && fd >= 3 ? fd : undefined;
}

async function readHandoff(fd: number): Promise<TeleportHandoff> {
	const chunks: Buffer[] = [];
	let bytes = 0;
	for await (const chunk of createReadStream("", { fd, autoClose: true })) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		bytes += buffer.length;
		if (bytes > MAX_HANDOFF_BYTES) throw new Error("Teleport child handoff exceeds size limit");
		chunks.push(buffer);
	}

	let value: unknown;
	try {
		value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw new Error("Teleport child handoff is malformed");
	}
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error("Teleport child handoff is malformed");

	const record = value as Record<string, unknown>;
	if (
		typeof record.destination !== "string" ||
		typeof record.cwd !== "string" ||
		!posix.isAbsolute(record.cwd) ||
		typeof record.socketPath !== "string" ||
		!isAbsolute(record.socketPath)
	) {
		throw new Error("Teleport child handoff is malformed");
	}
	const destination = parseTeleportTarget(record.destination);
	if (destination.destination !== record.destination || destination.requestedPath !== undefined) {
		throw new Error("Teleport child handoff is malformed");
	}
	return {
		destination: record.destination,
		cwd: record.cwd,
		socketPath: record.socketPath,
	};
}
