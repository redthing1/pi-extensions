import { isRecord } from "../transport/protocol.ts";
import type { WorkerClient } from "../transport/worker-client.ts";
import type { IsolatedWorkspaceRequest, IsolatedWorkspaceLayout } from "../../shared/active-workspace.ts";

export interface WorkspaceEntry {
	name: string;
	kind: "file" | "directory" | "symlink" | "other";
}

export interface WorkspaceMetadata {
	path: string;
	kind: "file" | "directory" | "symlink" | "block" | "character" | "fifo" | "socket" | "other";
	bytes: number;
	mode: number;
	mtimeMs: number;
}

export interface WorkspaceExecResult {
	exitCode: number | null;
	signal: string | null;
	cancelled: boolean;
	fullOutputPath?: string;
}

export interface WorkspaceContextFile {
	path: string;
	content: string;
}

export interface WorkspaceResourceDocument {
	path: string;
	content: string;
	scope: "user" | "project";
}

export type WorkspaceSkillDocument = WorkspaceResourceDocument;
export type WorkspacePromptDocument = WorkspaceResourceDocument;

export class WorkspaceClient {
	constructor(private readonly worker: Pick<WorkerClient, "request">) {}

	async read(path: string): Promise<Buffer> {
		return (await this.worker.request("read", { path }).promise).payload;
	}

	async write(path: string, content: Buffer): Promise<void> {
		await this.worker.request("write", { path }, undefined, content).promise;
	}

	async stat(path: string, follow = false): Promise<WorkspaceMetadata> {
		const response = await this.worker.request("stat", { path, follow }).promise;
		return parseMetadata(response.result);
	}

	async canonicalize(path: string): Promise<string> {
		const response = await this.worker.request("canonicalize", { path }).promise;
		return requirePath(response.result, "path");
	}

	async mime(path: string): Promise<string | null> {
		const response = await this.worker.request("mime", { path }).promise;
		return optionalString(response.result, "mimeType");
	}

	async context(): Promise<WorkspaceContextFile[]> {
		const response = await this.worker.request("context", {}).promise;
		const value: unknown = JSON.parse(response.payload.toString("utf8"));
		if (!Array.isArray(value) || value.length > 256) throw new Error("Worker context payload is malformed");
		let bytes = 0;
		return value.map((file) => {
			if (
				!isRecord(file) ||
				!isRemotePath(file.path) ||
				typeof file.content !== "string" ||
				Buffer.byteLength(file.content) > 256 * 1024
			) {
				throw new Error("Worker context file is malformed");
			}
			bytes += Buffer.byteLength(file.content);
			if (bytes > 1024 * 1024) throw new Error("Worker context exceeds its size limit");
			return { path: file.path, content: file.content };
		});
	}

	async skills(): Promise<WorkspaceSkillDocument[]> {
		return this.resourceDocuments("skills");
	}

	async prompts(): Promise<WorkspacePromptDocument[]> {
		return this.resourceDocuments("prompts");
	}

	private async resourceDocuments(operation: "skills" | "prompts"): Promise<WorkspaceResourceDocument[]> {
		const response = await this.worker.request(operation, {}).promise;
		const value: unknown = JSON.parse(response.payload.toString("utf8"));
		if (!Array.isArray(value) || value.length > 256) throw new Error(`Worker ${operation} payload is malformed`);
		let bytes = 0;
		return value.map((document) => {
			if (
				!isRecord(document) ||
				!isRemotePath(document.path) ||
				typeof document.content !== "string" ||
				Buffer.byteLength(document.content) > 256 * 1024 ||
				(document.scope !== "user" && document.scope !== "project")
			) {
				throw new Error(`Worker ${operation} document is malformed`);
			}
			bytes += Buffer.byteLength(document.content);
			if (bytes > 4 * 1024 * 1024) throw new Error(`Worker ${operation} exceeds its size limit`);
			// Prompt templates are expanded into the local editor. Preserve accepted
			// bytes, but reject controls that could become terminal commands there.
			if (operation === "prompts" && /[\x00-\x08\x0b-\x1f\x7f-\x9f]/u.test(document.content.replace(/\r\n/gu, "\n"))) {
				throw new Error("Worker prompt template contains terminal controls");
			}
			return {
				path: document.path,
				content: document.content,
				scope: document.scope,
			};
		});
	}

	async list(path = ".", maxEntries = 2_000): Promise<{ entries: WorkspaceEntry[]; truncated: boolean }> {
		const response = await this.worker.request("list", { path, maxEntries }).promise;
		const value: unknown = JSON.parse(response.payload.toString("utf8"));
		if (!Array.isArray(value) || value.length > Math.min(Math.max(maxEntries, 1), 10_000))
			throw new Error("Worker list payload is malformed");
		const entries = value.map((entry) => {
			if (
				!isRecord(entry) ||
				typeof entry.name !== "string" ||
				entry.name.length > 4096 ||
				!entry.name ||
				entry.name.includes("/") ||
				entry.name.includes("\0") ||
				entry.name === "." ||
				entry.name === ".." ||
				!isEntryKind(entry.kind)
			) {
				throw new Error("Worker list entry is malformed");
			}
			return { name: entry.name, kind: entry.kind };
		});
		return { entries, truncated: response.result.truncated === true };
	}

	async mkdir(path: string): Promise<void> {
		await this.worker.request("mkdir", { path, recursive: true }).promise;
	}

	async remove(path: string, options: { recursive?: boolean; force?: boolean } = {}): Promise<void> {
		await this.worker.request("remove", {
			path,
			recursive: options.recursive === true,
			force: options.force === true,
		}).promise;
	}

	async rename(from: string, to: string): Promise<void> {
		await this.worker.request("rename", { from, to }).promise;
	}

	async prepareIsolatedWorkspace(
		request: IsolatedWorkspaceRequest & { root: string },
	): Promise<IsolatedWorkspaceLayout> {
		const params: Record<string, unknown> = { ...request };
		const response = await this.worker.request("prepare_isolated_workspace", params).promise;
		const stages = response.result.stages;
		if (!isRecord(stages)) throw new Error("Worker isolated workspace stages are malformed");
		const parsedStages = Object.create(null) as Record<string, string>;
		for (const [name, path] of Object.entries(stages)) {
			if (!isRemotePath(path)) throw new Error("Worker isolated workspace stage path is malformed");
			parsedStages[name] = path;
		}
		return {
			root: requirePath(response.result, "root"),
			base: requirePath(response.result, "base"),
			digest: requireString(response.result, "digest"),
			stages: parsedStages,
		};
	}

	async grep(options: {
		pattern: string;
		path?: string;
		glob?: string;
		ignoreCase?: boolean;
		literal?: boolean;
		context?: number;
	}): Promise<string> {
		return this.grepRequest(options).promise;
	}

	grepRequest(options: {
		pattern: string;
		path?: string;
		glob?: string;
		ignoreCase?: boolean;
		literal?: boolean;
		context?: number;
	}): { id: string; promise: Promise<string> } {
		const request = this.worker.request("grep", options);
		return {
			id: request.id,
			promise: request.promise.then((response) => response.payload.toString("utf8")),
		};
	}

	async find(options: {
		pattern: string;
		path?: string;
		maxResults?: number;
		hidden?: boolean;
		noIgnore?: boolean;
	}): Promise<string[]> {
		const payload = (await this.worker.request("find", options).promise).payload;
		const maximum = Math.min(Math.max(options.maxResults ?? 2_000, 1), 10_000);
		const parts = payload.toString("utf8").split("\0", maximum + 2);
		if (parts.at(-1) === "") parts.pop();
		if (parts.length > maximum || parts.some((path) => !isRemotePath(path)))
			throw new Error("Worker find payload is malformed");
		return parts;
	}

	exec(
		command: string,
		onData?: (stream: "stdout" | "stderr", chunk: Buffer) => void,
		cwd?: string,
	): { id: string; promise: Promise<WorkspaceExecResult> } {
		const request = this.worker.request("exec", { command, cwd }, onData);
		return {
			id: request.id,
			promise: request.promise.then((response) => {
				const fullOutputPath = optionalString(response.result, "fullOutputPath");
				return {
					exitCode: optionalNumber(response.result, "exitCode"),
					signal: optionalString(response.result, "signal"),
					cancelled: response.result.cancelled === true,
					...(fullOutputPath ? { fullOutputPath } : {}),
				};
			}),
		};
	}

	async cancel(requestId: string): Promise<boolean> {
		const response = await this.worker.request("cancel", {
			targetId: requestId,
		}).promise;
		return response.result.accepted === true;
	}
}

function parseMetadata(value: Record<string, unknown>): WorkspaceMetadata {
	const kind = value.kind;
	if (!isMetadataKind(kind)) throw new Error("Worker metadata kind is malformed");
	return {
		path: requirePath(value, "path"),
		kind,
		bytes: requireNumber(value, "bytes"),
		mode: requireNumber(value, "mode"),
		mtimeMs: requireNumber(value, "mtimeMs"),
	};
}

function requireString(value: Record<string, unknown>, key: string): string {
	const field = value[key];
	if (typeof field !== "string") throw new Error(`Worker result ${key} is malformed`);
	return field;
}

function requireNumber(value: Record<string, unknown>, key: string): number {
	const field = value[key];
	if (
		typeof field !== "number" ||
		!Number.isFinite(field) ||
		(key !== "mtimeMs" && (!Number.isSafeInteger(field) || field < 0))
	)
		throw new Error(`Worker result ${key} is malformed`);
	return field;
}

function optionalNumber(value: Record<string, unknown>, key: string): number | null {
	const field = value[key];
	if (field === null) return null;
	if (typeof field !== "number" || !Number.isSafeInteger(field)) throw new Error(`Worker result ${key} is malformed`);
	return field;
}

function optionalString(value: Record<string, unknown>, key: string): string | null {
	const field = value[key];
	if (field === null || field === undefined) return null;
	if (typeof field !== "string") throw new Error(`Worker result ${key} is malformed`);
	return field;
}

function isEntryKind(value: unknown): value is WorkspaceEntry["kind"] {
	return value === "file" || value === "directory" || value === "symlink" || value === "other";
}

function isRemotePath(value: unknown): value is string {
	return typeof value === "string" && value.startsWith("/") && value.length <= 4096 && !value.includes("\0");
}

function requirePath(value: Record<string, unknown>, key: string): string {
	const path = value[key];
	if (!isRemotePath(path)) throw new Error(`Worker result ${key} is malformed`);
	return path;
}

function isMetadataKind(value: unknown): value is WorkspaceMetadata["kind"] {
	return isEntryKind(value) || value === "block" || value === "character" || value === "fifo" || value === "socket";
}
