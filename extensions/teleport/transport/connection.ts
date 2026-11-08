import { randomBytes } from "node:crypto";
import { MasterConnection, type MasterOptions } from "./master.ts";
import { RemoteScratch } from "./scratch.ts";
import { WorkerClient, type WorkerReady } from "./worker-client.ts";
import { workerCommand } from "./worker-command.ts";
import { WorkspaceClient } from "../workspace/client.ts";

export interface ConnectionOptions extends MasterOptions {
	onFailure(error: Error): void;
	onCleanupFailure?(error: Error): void;
}

/** Owns bootstrap, channel health, and teardown in the order remote cleanup needs. */
export class TeleportConnection {
	readonly master: MasterConnection;
	readonly scratch: RemoteScratch;
	private readonly nonce = randomBytes(16).toString("hex");
	private readonly options: ConnectionOptions;
	private client: WorkerClient | undefined;
	private identity: WorkerReady | undefined;
	private operations: WorkspaceClient | undefined;
	private failure: Error | undefined;
	private startPromise: Promise<void> | undefined;
	private closePromise: Promise<void> | undefined;
	private stderr = "";

	constructor(options: ConnectionOptions) {
		this.options = options;
		this.master = new MasterConnection(options);
		this.scratch = new RemoteScratch(this.master, this.nonce);
	}

	get ready(): WorkerReady {
		this.assertReady();
		return this.identity!;
	}

	get workspace(): WorkspaceClient {
		this.assertReady();
		return this.operations!;
	}

	get diagnostic(): string {
		return this.stderr.trim();
	}

	assertReady(): void {
		if (this.failure) throw this.failure;
		if (!this.identity || !this.operations || this.closePromise) throw new Error("Teleport workspace is unavailable");
	}

	async start(cwd: string): Promise<void> {
		if (this.startPromise || this.closePromise) throw new Error("Teleport connection is already started or closed");
		this.startPromise = this.startInternal(cwd);
		try {
			await this.startPromise;
		} catch (error) {
			let cleanup: unknown;
			try {
				await this.close();
			} catch (failure) {
				cleanup = failure;
			}
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(
				[message, this.diagnostic, cleanup instanceof Error ? cleanup.message : ""].filter(Boolean).join("; "),
				{ cause: error },
			);
		}
	}

	private async startInternal(cwd: string): Promise<void> {
		const assertStarting = (): void => {
			if (this.closePromise) throw new Error("Teleport connection is closing");
		};
		await this.master.start();
		assertStarting();
		await this.scratch.create();
		assertStarting();
		await this.scratch.installWorker();
		assertStarting();
		const child = this.master.spawnChannel(workerCommand(this.scratch.workerPath, this.nonce, cwd, this.scratch.path));
		child.stderr.on("data", (chunk: Buffer) => {
			this.stderr = `${this.stderr}${chunk.toString("utf8")}`.slice(-8192);
		});
		this.client = new WorkerClient(child, this.nonce, {
			onFailure: (error) => {
				this.failure = error;
				try {
					this.options.onFailure(error);
				} finally {
					void this.close().catch((cleanup) => {
						try {
							this.options.onCleanupFailure?.(cleanup);
						} catch {
							/* Reporting cannot prevent disposal. */
						}
					});
				}
			},
		});
		this.identity = await this.client.ready();
		this.operations = new WorkspaceClient(this.client);
		this.assertReady();
	}

	close(): Promise<void> {
		this.closePromise ??= Promise.resolve().then(() => this.closeInternal());
		return this.closePromise;
	}

	private async closeInternal(): Promise<void> {
		const errors: unknown[] = [];
		// Wake a bootstrap that is waiting for readiness before joining it.
		const earlyClose =
			this.client && !this.identity
				? this.client.close().catch((error) => {
						errors.push(error);
					})
				: undefined;
		// Finish or reject in-flight allocation before disposing its owners. The
		// public start() handles errors after this internal promise has settled.
		await this.startPromise?.catch(() => {});
		try {
			await (earlyClose ?? this.client?.close());
		} catch (error) {
			errors.push(error);
		}
		// Also handles worker loss and failures before a handshake. This channel
		// can only borrow the existing master; it cannot reconnect independently.
		try {
			await this.scratch.remove();
		} catch (error) {
			errors.push(error);
		}
		try {
			await this.master.close();
		} catch (error) {
			errors.push(error);
		}
		if (errors.length) throw new AggregateError(errors, "Teleport cleanup was incomplete");
	}
}
