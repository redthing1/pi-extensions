import { posix } from "node:path";
import { WorkerRequestError } from "../transport/worker-client.ts";
import type { WorkspaceClient } from "./client.ts";

export class RemoteMutationQueue {
	private readonly tails = new Map<string, Promise<void>>();
	private readonly workspace: WorkspaceClient;

	constructor(workspace: WorkspaceClient) {
		this.workspace = workspace;
	}

	readonly run = async <T>(
		path: string,
		mutate: () => Promise<T>,
	): Promise<T> => {
		const key = await this.canonicalMutationPath(path);
		const previous = this.tails.get(key) ?? Promise.resolve();
		let release = (): void => {};
		const current = new Promise<void>((resolveCurrent) => {
			release = resolveCurrent;
		});
		const tail = previous.then(() => current);
		this.tails.set(key, tail);

		await previous;
		try {
			return await mutate();
		} finally {
			release();
			if (this.tails.get(key) === tail) this.tails.delete(key);
		}
	};

	private async canonicalMutationPath(path: string): Promise<string> {
		const unresolved: string[] = [];
		let candidate = posix.normalize(path);

		for (;;) {
			try {
				const canonical = await this.workspace.canonicalize(candidate);
				return posix.join(canonical, ...unresolved.reverse());
			} catch (error) {
				if (
					!(error instanceof WorkerRequestError) ||
					error.code !== "NOT_FOUND"
				)
					throw error;
			}

			const parent = posix.dirname(candidate);
			if (parent === candidate)
				return posix.join(candidate, ...unresolved.reverse());
			unresolved.push(posix.basename(candidate));
			candidate = parent;
		}
	}
}
