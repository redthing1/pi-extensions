import { posix } from "node:path";
import type {
	ActiveWorkspace,
	WorkspaceChildOperations,
	WorkspaceFileOperations,
	WorkspaceIdentity,
} from "../../shared/active-workspace.ts";
import { WorkerRequestError } from "../transport/worker-client.ts";
import type { WorkspaceClient } from "./client.ts";
import { RemoteMutationQueue } from "./mutation-queue.ts";
import { resolveWorkspacePath, type WorkspaceLocation } from "./path.ts";

export interface TeleportWorkspaceProvider {
	workspace: ActiveWorkspace;
	compatibleTools: ReadonlySet<string>;
	invalidate(): void;
}

export function createWorkspaceProvider(options: {
	client: WorkspaceClient;
	identity: WorkspaceIdentity & { home: string };
	children: WorkspaceChildOperations;
}): TeleportWorkspaceProvider {
	const compatibleTools = new Set<string>();
	let active = true;
	const assertActive = (): void => {
		if (!active) throw new Error("Teleport workspace is unavailable");
	};
	return {
		workspace: {
			identity: options.identity,
			files: createWorkspaceFileOperations(options.client, options.identity),
			children: {
				async prepareChild(request) {
					assertActive();
					return options.children.prepareChild(request);
				},
			},
			isolation: {
				async prepare(request) {
					assertActive();
					for (const segment of [request.namespace, request.date, request.id]) {
						if (!/^[a-zA-Z0-9_.-]+$/u.test(segment) || segment === "." || segment === "..") {
							throw new Error(`Invalid isolated workspace path segment: ${segment}`);
						}
					}
					const prepared = await options.client.prepareIsolatedWorkspace({
						...request,
						root: posix.join(
							options.identity.home,
							".pi",
							"workspaces",
							request.namespace,
							request.date,
							request.id,
						),
					});
					return {
						...prepared,
						dispose: request.retention === "ephemeral"
							? () => options.client.remove(prepared.root, { recursive: true, force: true })
							: async () => undefined,
					};
				},
			},
			registerCompatibleTool(name) {
				assertActive();
				compatibleTools.add(name);
			},
			assertActive,
		},
		compatibleTools,
		invalidate() {
			active = false;
		},
	};
}

export function createWorkspaceFileOperations(
	workspace: WorkspaceClient,
	location: WorkspaceLocation,
): WorkspaceFileOperations {
	const mutations = new RemoteMutationQueue(workspace);
	return {
		resolveEntry: (path) =>
			resolveEntry(workspace, resolveWorkspacePath(path, location)),
		async canonicalize(path) {
			const absolute = resolveWorkspacePath(path, location);
			try {
				return await workspace.canonicalize(absolute);
			} catch (error) {
				if (
					!(error instanceof WorkerRequestError) ||
					error.code !== "NOT_FOUND"
				)
					throw error;
				return resolveEntry(workspace, absolute);
			}
		},
		async exists(path) {
			try {
				await workspace.stat(path);
				return true;
			} catch (error) {
				if (error instanceof WorkerRequestError && error.code === "NOT_FOUND")
					return false;
				throw error;
			}
		},
		read: (path) => workspace.read(path),
		write: (path, content) => workspace.write(path, content),
		ensureParent: (path) => workspace.mkdir(posix.dirname(path)),
		remove: (path) => workspace.remove(path),
		runExclusive: mutations.run,
	};
}

async function resolveEntry(
	workspace: WorkspaceClient,
	absolute: string,
): Promise<string> {
	const suffix = [posix.basename(absolute)];
	let parent = posix.dirname(absolute);
	for (;;) {
		try {
			return posix.join(await workspace.canonicalize(parent), ...suffix);
		} catch (error) {
			if (!(error instanceof WorkerRequestError) || error.code !== "NOT_FOUND")
				throw error;
		}
		const next = posix.dirname(parent);
		if (next === parent) return absolute;
		suffix.unshift(posix.basename(parent));
		parent = next;
	}
}
