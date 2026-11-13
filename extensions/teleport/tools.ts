import { posix } from "node:path";
import {
	type BashOperations,
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	DEFAULT_MAX_BYTES,
	type ExtensionAPI,
	formatSize,
	type GrepToolDetails,
	type GrepToolInput,
	ShellExecutionError,
	truncateHead,
	truncateLine,
} from "@earendil-works/pi-coding-agent";
import { isRecord } from "./transport/protocol.ts";
import { WorkerRequestError } from "./transport/worker-client.ts";
import type { WorkspaceClient, WorkspaceEntry, WorkspaceMetadata } from "./workspace/client.ts";
import { RemoteMutationQueue } from "./workspace/mutation-queue.ts";
import { resolveWorkspacePath, type WorkspaceLocation } from "./workspace/path.ts";
import type { RemoteOutputs } from "./outputs.ts";

const CONTROL_PLANE_TOOLS = new Set([
	"create_goal",
	"get_goal",
	"intercom_list",
	"intercom_send",
	"question",
	"read_output",
	"request_plan_input",
	"submit_plan",
	"update_goal",
	"web_fetch",
	"web_search",
]);

export const WORKSPACE_TOOL_NAMES = new Set(["bash", "edit", "find", "grep", "ls", "read", "write"]);

export function isTeleportClientTool(name: string): boolean {
	return CONTROL_PLANE_TOOLS.has(name);
}

export function isTeleportToolAllowed(name: string, compatibleTools: ReadonlySet<string>): boolean {
	return WORKSPACE_TOOL_NAMES.has(name) || CONTROL_PLANE_TOOLS.has(name) || compatibleTools.has(name);
}

export function registerRemoteTools(
	pi: Pick<ExtensionAPI, "registerTool">,
	workspace: WorkspaceClient,
	location: WorkspaceLocation,
	outputs: RemoteOutputs,
): void {
	const mutations = new RemoteMutationQueue(workspace);
	const pathOperations = {
		resolvePath: (path: string) => resolveWorkspacePath(path, location),
	};
	const readOperations = {
		...pathOperations,
		access: async (path: string) => {
			const metadata = await workspace.stat(path, true);
			if (metadata.kind !== "file") throw new Error(`Not a regular file: ${path}`);
		},
		detectImageMimeType: (path: string) => workspace.mime(path),
		readFile: (path: string) => workspace.read(path),
	};
	const writeOperations = {
		...pathOperations,
		mkdir: (path: string) => workspace.mkdir(path),
		mutationQueue: mutations.run,
		writeFile: (path: string, content: string) => workspace.write(path, Buffer.from(content, "utf8")),
	};

	const edit = createEditToolDefinition(location.cwd, {
		operations: {
			...pathOperations,
			access: readOperations.access,
			mutationQueue: mutations.run,
			readFile: readOperations.readFile,
			writeFile: writeOperations.writeFile,
		},
	});

	pi.registerTool(createReadToolDefinition(location.cwd, { operations: readOperations }));
	pi.registerTool(createWriteToolDefinition(location.cwd, { operations: writeOperations }));
	pi.registerTool({ ...edit, renderCall: undefined });
	pi.registerTool(createRemoteLsTool(workspace, location, pathOperations));
	pi.registerTool(createRemoteGrepTool(workspace, location));
	pi.registerTool(createRemoteFindTool(workspace, location, pathOperations));
	pi.registerTool(
		createBashToolDefinition(location.cwd, {
			operations: createRemoteBashOperations(workspace, location, outputs),
			exposeSessionEnvironment: false,
		}),
	);
}

export function createRemoteBashOperations(
	workspace: WorkspaceClient,
	location: WorkspaceLocation,
	outputs: RemoteOutputs,
): BashOperations {
	return {
		context: { ...location, pathStyle: "posix" },
		managesFullOutput: true,
		exec: async (command, _cwd, { onData, signal, timeout }) => {
			if (signal?.aborted) throw new Error("aborted");
			if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0)) {
				throw new Error("Invalid timeout: must be a finite number of seconds");
			}

			const request = workspace.exec(command, (_stream, chunk) => onData(chunk), { timeout });
			let timedOut = false;
			let stopping: ReturnType<typeof setTimeout> | undefined;
			const cancel = (): void => {
				if (stopping) return;
				stopping = setTimeout(() => {
					workspace.invalidate(new Error("Teleport command termination could not be confirmed"));
				}, 5000);
				void workspace.cancel(request.id).catch((error) => {
					workspace.invalidate(error instanceof Error ? error : new Error(String(error)));
				});
			};
			const timeoutHandle =
				timeout === undefined
					? undefined
					: setTimeout(
							() => {
								timedOut = true;
								cancel();
							},
							Math.min(timeout * 1000, 2_147_483_647),
						);
			signal?.addEventListener("abort", cancel, { once: true });
			if (signal?.aborted) cancel();

			try {
				const result = await request.promise;
				const fullOutputPath = result.fullOutputPath ? await outputs.registerRemote(result.fullOutputPath) : undefined;
				let diagnostic: string | undefined;
				if (signal?.aborted) diagnostic = "aborted";
				else if (timedOut || result.timedOut) diagnostic = `timeout:${timeout}`;
				else if (result.cancelled) diagnostic = "aborted";
				if (diagnostic) throw new ShellExecutionError(diagnostic, "", diagnostic, fullOutputPath);
				return {
					exitCode: result.exitCode,
					fullOutputPath,
				};
			} finally {
				if (stopping) clearTimeout(stopping);
				if (timeoutHandle) clearTimeout(timeoutHandle);
				signal?.removeEventListener("abort", cancel);
			}
		},
	};
}

function createRemoteLsTool(
	workspace: WorkspaceClient,
	location: WorkspaceLocation,
	pathOperations: { resolvePath(path: string): string },
) {
	const metadata = new Map<string, WorkspaceMetadata>();
	const entries = new Map<string, WorkspaceEntry>();
	return createLsToolDefinition(location.cwd, {
		operations: {
			...pathOperations,
			exists: async (path) => {
				try {
					metadata.set(path, await workspace.stat(path, true));
					return true;
				} catch (error) {
					if (error instanceof WorkerRequestError && error.code === "NOT_FOUND") return false;
					throw error;
				}
			},
			stat: async (path) => {
				const cachedMetadata = metadata.get(path);
				const cachedEntry = entries.get(path);
				const kind = cachedMetadata?.kind ?? cachedEntry?.kind ?? (await workspace.stat(path, true)).kind;
				return { isDirectory: () => kind === "directory" };
			},
			readdir: async (path) => {
				const listing = await workspace.list(path, 10_000);
				for (const entry of listing.entries) entries.set(posix.join(path, entry.name), entry);
				return listing.entries.map((entry) => entry.name);
			},
		},
	});
}

function createRemoteFindTool(
	workspace: WorkspaceClient,
	location: WorkspaceLocation,
	pathOperations: { resolvePath(path: string): string },
) {
	return createFindToolDefinition(location.cwd, {
		operations: {
			...pathOperations,
			exists: async (path) => {
				try {
					await workspace.stat(path, true);
					return true;
				} catch (error) {
					if (error instanceof WorkerRequestError && error.code === "NOT_FOUND") return false;
					throw error;
				}
			},
			glob: (pattern, path, options) =>
				workspace.find({
					pattern,
					path,
					maxResults: options.limit,
					hidden: true,
				}),
		},
	});
}

function createRemoteGrepTool(workspace: WorkspaceClient, location: WorkspaceLocation) {
	const definition = createGrepToolDefinition(location.cwd);
	return {
		...definition,
		async execute(_toolCallId: string, input: GrepToolInput, signal?: AbortSignal) {
			const searchPath = resolveWorkspacePath(input.path || ".", location);
			let searchMetadata: WorkspaceMetadata;
			try {
				searchMetadata = await workspace.stat(searchPath, true);
			} catch (error) {
				if (error instanceof WorkerRequestError && error.code === "NOT_FOUND") {
					throw new Error(`Path not found: ${searchPath}`);
				}
				throw error;
			}

			const request = workspace.grepRequest({
				pattern: input.pattern,
				path: searchPath,
				glob: input.glob,
				ignoreCase: input.ignoreCase,
				literal: input.literal,
				context: input.context,
			});
			const cancel = (): void => {
				void workspace.cancel(request.id).catch(() => {});
			};
			if (signal?.aborted) cancel();
			else signal?.addEventListener("abort", cancel, { once: true });

			let raw: string;
			try {
				raw = await request.promise;
			} catch (error) {
				if (signal?.aborted || (error instanceof WorkerRequestError && error.code === "ABORTED")) {
					throw new Error("Operation aborted");
				}
				throw error;
			} finally {
				signal?.removeEventListener("abort", cancel);
			}

			const limit = Math.max(1, input.limit ?? 100);
			const lines: string[] = [];
			let matches = 0;
			let linesTruncated = false;
			for (const line of raw.split("\n")) {
				if (!line) continue;
				const formatted = formatGrepEvent(line, searchPath, searchMetadata.kind === "directory");
				if (!formatted) continue;
				if (formatted.match) {
					matches += 1;
					if (matches > limit) break;
				}
				const truncated = truncateLine(formatted.text);
				linesTruncated ||= truncated.wasTruncated;
				lines.push(truncated.text);
			}

			if (matches === 0)
				return {
					content: [{ type: "text" as const, text: "No matches found" }],
					details: undefined,
				};
			const truncation = truncateHead(lines.join("\n"), {
				maxLines: Number.MAX_SAFE_INTEGER,
			});
			const details: GrepToolDetails = {};
			const notices: string[] = [];
			if (matches > limit) {
				details.matchLimitReached = limit;
				notices.push(`${limit} matches limit reached`);
			}
			if (truncation.truncated) {
				details.truncation = truncation;
				notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
			}
			if (linesTruncated) {
				details.linesTruncated = true;
				notices.push("some lines truncated");
			}
			const notice = notices.length > 0 ? `\n\n[${notices.join(". ")}]` : "";
			return {
				content: [{ type: "text" as const, text: `${truncation.content}${notice}` }],
				details: notices.length > 0 ? details : undefined,
			};
		},
	};
}

function formatGrepEvent(
	line: string,
	searchPath: string,
	searchIsDirectory: boolean,
): { text: string; match: boolean } | undefined {
	let event: unknown;
	try {
		event = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (!isRecord(event) || (event.type !== "match" && event.type !== "context") || !isRecord(event.data))
		return undefined;
	const data = event.data;
	if (!isRecord(data.path) || typeof data.path.text !== "string" || typeof data.line_number !== "number")
		return undefined;
	if (!isRecord(data.lines) || typeof data.lines.text !== "string") return undefined;
	const displayPath = searchIsDirectory
		? posix.relative(searchPath, data.path.text) || posix.basename(data.path.text)
		: posix.basename(data.path.text);
	const content = data.lines.text.replace(/\r?\n$/, "").replaceAll("\r", "");
	const match = event.type === "match";
	return {
		text: `${displayPath}${match ? ":" : "-"}${data.line_number}${match ? ":" : "-"} ${content}`,
		match,
	};
}
