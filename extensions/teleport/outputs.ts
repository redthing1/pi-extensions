import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReadToolDefinition, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { WorkspaceClient } from "./workspace/client.ts";

const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const MAX_OUTPUTS = 256;
const REFERENCE = /^pi-output:[a-f0-9]{32}$/u;
const parameters = Type.Object({
	reference: Type.String({ description: "The exact pi-output: reference returned by a tool" }),
	offset: Type.Optional(
		Type.Integer({ minimum: 1, description: "Starting line, or starting byte for base64 (1-indexed)" }),
	),
	limit: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum lines, or bytes for base64" })),
	encoding: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("base64")])),
	release: Type.Optional(
		Type.Boolean({ description: "Delete this saved output after reading it, when no longer needed" }),
	),
});

type OutputLocation =
	| { kind: "local"; path: string; bytes: number }
	| { kind: "remote"; path: string; workspace: WorkspaceClient; owner: RemoteOutputs };

export interface RemoteOutputs {
	registerRemote(path: string): Promise<string>;
	invalidate(): void;
}

/** Only tool outputs registered by this live extension instance can be retrieved. */
export class SessionOutputs {
	private directory: Promise<string> | undefined;
	private readonly files = new Map<string, OutputLocation>();
	private bytes = 0;
	private closed = false;
	private closePromise: Promise<void> | undefined;
	private readonly pending = new Set<Promise<unknown>>();
	private readonly releases = new Map<string, Promise<void>>();
	private readonly temporaryRoot: string;

	constructor(temporaryRoot = tmpdir()) {
		this.temporaryRoot = temporaryRoot;
	}

	attachRemote(workspace: WorkspaceClient, directory: string): RemoteOutputs {
		if (this.closed || !/^\/tmp\/pi-teleport-[a-f0-9]{32}$/u.test(directory))
			throw new Error("Invalid remote output owner");
		let active = true;
		const owner: RemoteOutputs = {
			registerRemote: async (path) => {
				if (
					!path.startsWith(`${directory}/`) ||
					!/^output-r[1-9][0-9]{0,15}\.log$/u.test(path.slice(directory.length + 1))
				)
					throw new Error("Worker returned an invalid output location");
				if (!active || this.closed || this.files.size >= MAX_OUTPUTS) {
					await workspace.remove(path, { force: true });
					throw new Error("Session outputs are unavailable");
				}
				const reference = `pi-output:${randomBytes(16).toString("hex")}`;
				this.files.set(reference, { kind: "remote", path, workspace, owner });
				return reference;
			},
			invalidate: () => {
				active = false;
				for (const [reference, location] of this.files) {
					if (location.kind === "remote" && location.owner === owner) this.files.delete(reference);
				}
			},
		};
		return owner;
	}

	async save(prefix: string, extension: string, data: string | Uint8Array): Promise<string> {
		if (this.closed) throw new Error("Session outputs are unavailable");
		if (!/^[a-zA-Z0-9_-]+$/u.test(prefix) || !/^\.[a-zA-Z0-9]+$/u.test(extension))
			throw new Error("Invalid output file name");
		const size = typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
		if (size > MAX_OUTPUT_BYTES || this.bytes + size > MAX_TOTAL_BYTES || this.files.size >= MAX_OUTPUTS)
			throw new Error("Session output storage limit exceeded");
		const reference = `pi-output:${randomBytes(16).toString("hex")}`;
		this.bytes += size;
		let cleanupIncomplete = false;
		// Reserve before the first await so concurrent writers share the same budget.
		this.files.set(reference, { kind: "local", path: "", bytes: size });
		const write = (async () => {
			this.directory ??= mkdtemp(join(this.temporaryRoot, "pi-teleport-output-"));
			const directory = await this.directory;
			const path = join(directory, `${reference.slice(10)}${extension}`);
			const file = await open(path, "wx", 0o600);
			try {
				try {
					await file.writeFile(data);
				} finally {
					await file.close();
				}
			} catch (error) {
				try {
					await rm(path, { force: true });
				} catch {
					cleanupIncomplete = true;
				}
				throw error;
			}
			this.files.set(reference, { kind: "local", path, bytes: size });
			return reference;
		})();
		this.pending.add(write);
		try {
			return await write;
		} catch {
			this.files.delete(reference);
			this.bytes -= size;
			throw new Error(
				`Unable to save the session output${cleanupIncomplete ? "; temporary cleanup was incomplete" : ""}`,
			);
		} finally {
			this.pending.delete(write);
		}
	}

	private resolve(reference: string): OutputLocation {
		if (this.closed || !REFERENCE.test(reference)) throw new Error("Unknown or expired session output reference");
		const location = this.files.get(reference);
		if (!location?.path) throw new Error("Unknown or expired session output reference");
		return location;
	}

	private async read(reference: string, headerOnly = false): Promise<Buffer> {
		const location = this.resolve(reference);
		if (location.kind === "remote") return location.workspace.read(location.path);
		try {
			const file = await open(location.path, constants.O_RDONLY | constants.O_NOFOLLOW);
			try {
				const metadata = await file.stat();
				if (!metadata.isFile() || metadata.size > MAX_OUTPUT_BYTES) throw new Error("Invalid session output");
				if (headerOnly) {
					const header = Buffer.alloc(16);
					const { bytesRead } = await file.read(header, 0, header.length, 0);
					return header.subarray(0, bytesRead);
				}
				const bytes = await file.readFile();
				if (bytes.length > MAX_OUTPUT_BYTES) throw new Error("Invalid session output");
				return bytes;
			} finally {
				await file.close();
			}
		} catch {
			throw new Error("Session output is unavailable");
		}
	}

	async release(reference: string): Promise<void> {
		const pending = this.releases.get(reference);
		if (pending) return pending;
		const location = this.resolve(reference);
		const release = (async () => {
			if (location.kind === "remote") await location.workspace.remove(location.path);
			else {
				await rm(location.path);
				this.bytes -= location.bytes;
			}
			this.files.delete(reference);
		})();
		this.releases.set(reference, release);
		this.pending.add(release);
		try {
			await release;
		} finally {
			this.releases.delete(reference);
			this.pending.delete(release);
		}
	}

	register(pi: Pick<ExtensionAPI, "registerTool">): void {
		const thisStore = this;
		const read = createReadToolDefinition("/", {
			operations: {
				resolvePath: (reference) => {
					this.resolve(reference);
					return reference;
				},
				access: async (reference) => {
					const location = this.resolve(reference);
					try {
						if (location.kind === "local") {
							if (!(await lstat(location.path)).isFile()) throw new Error();
						} else if ((await location.workspace.stat(location.path)).kind !== "file") throw new Error();
					} catch {
						throw new Error("Session output is unavailable");
					}
				},
				readFile: (path) => this.read(path),
				detectImageMimeType: async (path) => {
					const location = this.resolve(path);
					if (location.kind === "remote") return location.workspace.mime(location.path);
					const bytes = await this.read(path, true);
					if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
					if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
					if (/^GIF8[79]a/u.test(bytes.subarray(0, 6).toString("ascii"))) return "image/gif";
					if (bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP")
						return "image/webp";
					if (bytes.subarray(0, 2).toString() === "BM") return "image/bmp";
					return undefined;
				},
			},
		});
		pi.registerTool({
			...read,
			prepareArguments: undefined,
			name: "read_output",
			label: "read_output",
			parameters,
			description:
				"Read a registered tool output using its pi-output: reference. Local results stay on the client and remote results stay on their worker. This cannot read arbitrary paths. Text and images use offset/limit like read; encoding=base64 returns at most 32KB of binary bytes. Set release=true only when the saved output is no longer needed.",
			promptSnippet: "Retrieve saved tool output by its pi-output: reference",
			promptGuidelines: ["Use read_output for pi-output: references; use read for remote workspace files."],
			renderCall: undefined,
			renderResult: undefined,
			async execute(id, { reference, offset, limit, encoding, release }, signal, onUpdate, ctx) {
				if (encoding !== "base64") {
					const result = await read.execute(id, { path: reference, offset, limit }, signal, onUpdate, ctx);
					if (signal?.aborted) throw new Error("Operation aborted");
					if (result.details?.truncation?.firstLineExceedsLimit) {
						result.content = [
							{
								type: "text",
								text: "Saved output line exceeds the text limit. Use encoding=base64 with byte offset/limit to retrieve it in chunks.",
							},
						];
					}
					if (release) await thisStore.release(reference);
					return result;
				}
				if (signal?.aborted) throw new Error("Operation aborted");
				const start = offset ?? 1;
				const count = limit ?? 32768;
				if (!Number.isSafeInteger(start) || start < 1 || !Number.isSafeInteger(count) || count < 1 || count > 32768)
					throw new Error("Invalid output byte range");
				const bytes = await thisStore.read(reference);
				if (signal?.aborted) throw new Error("Operation aborted");
				if (start > Math.max(1, bytes.length)) throw new Error("Output byte offset is beyond the end");
				const end = Math.min(start - 1 + count, bytes.length);
				const content = bytes.subarray(start - 1, end).toString("base64");
				if (release) await thisStore.release(reference);
				return { content: [{ type: "text", text: content }], structuredContent: content, details: undefined };
			},
		});
	}

	close(): Promise<void> {
		this.closed = true;
		this.closePromise ??= (async () => {
			await Promise.allSettled([...this.pending]);
			this.files.clear();
			if (this.directory) await rm(await this.directory, { recursive: true, force: true });
		})();
		return this.closePromise;
	}
}
