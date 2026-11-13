import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export interface Peer {
	id: string;
	name: string;
}

export interface PeerMessage {
	id: string;
	from: Peer | null;
	text: string;
}

const ID = /^[0-9a-f]{32}$/;
const MAX_FRAME = 128 * 1024;
const PROCESS_TIMEOUT = 3000;

function isPeer(value: unknown): value is Peer {
	if (!value || typeof value !== "object") return false;
	const peer = value as Record<string, unknown>;
	return (
		typeof peer.id === "string" &&
		ID.test(peer.id) &&
		typeof peer.name === "string" &&
		peer.name.length > 0 &&
		Buffer.byteLength(peer.name) <= 128 &&
		!/[\x00-\x1f\x7f-\x9f]/u.test(peer.name)
	);
}

function isMessage(value: unknown): value is PeerMessage {
	if (!value || typeof value !== "object") return false;
	const message = value as Record<string, unknown>;
	return (
		typeof message.id === "string" &&
		ID.test(message.id) &&
		(message.from === null || isPeer(message.from)) &&
		typeof message.text === "string" &&
		message.text.length > 0 &&
		Buffer.byteLength(message.text) <= 16384
	);
}

export class IntercomClient {
	peer!: Peer;
	private readonly child: ChildProcessWithoutNullStreams;
	private buffer = Buffer.alloc(0);
	private flowing = true;
	private closed = false;
	private ready = false;
	private stderr = "";
	private finishReady!: (error?: Error) => void;
	private stopping?: Promise<void>;
	private readonly lifetime = new AbortController();
	private readonly binary: string;
	private readonly onMessage: (message: PeerMessage) => boolean;
	private readonly onExit: (error: Error) => void;

	private constructor(
		binary: string,
		name: string,
		onMessage: (message: PeerMessage) => boolean,
		onExit: (error: Error) => void,
	) {
		this.binary = binary;
		this.onMessage = onMessage;
		this.onExit = onExit;
		this.child = spawn(binary, ["listen", "--name", name, "--stdio"], { stdio: "pipe", windowsHide: true });
		this.child.stdin.on("error", () => {});
		this.child.stderr.on("data", (data: Buffer) => {
			this.stderr = (this.stderr + data.toString()).slice(-4096);
		});
		this.child.stdout.on("readable", () => this.drain());
		this.child.stdout.on("error", (error) => this.fail(error));
		this.child.on("error", (error) => this.fail(error));
		this.child.on("exit", () => this.fail(new Error(this.stderr.trim() || "Intercom receiver exited.")));
		this.child.on("close", () => this.fail(new Error(this.stderr.trim() || "Intercom receiver exited.")));
	}

	static async start(
		binary: string,
		name: string,
		onMessage: (message: PeerMessage) => boolean,
		onExit: (error: Error) => void,
		signal?: AbortSignal,
	): Promise<IntercomClient> {
		const client = new IntercomClient(binary, name, onMessage, onExit);
		const abort = () => {
			client.fail(new Error("Intercom startup cancelled."));
		};
		try {
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(
					() => client.fail(new Error("Intercom receiver did not become ready.")),
					PROCESS_TIMEOUT,
				);
				client.finishReady = (error) => {
					clearTimeout(timer);
					if (error) reject(error);
					else resolve();
				};
				signal?.addEventListener("abort", abort, { once: true });
				if (signal?.aborted) abort();
			});
			if (client.closed) throw new Error("Intercom receiver exited during startup.");
			return client;
		} catch (error) {
			await client.stop();
			throw error;
		} finally {
			signal?.removeEventListener("abort", abort);
		}
	}

	resume(): void {
		this.flowing = true;
		queueMicrotask(() => this.drain());
	}

	private drain(): void {
		try {
			while (this.flowing && !this.closed) {
				const newline = this.buffer.indexOf(10);
				if (newline < 0) {
					if (this.buffer.length > MAX_FRAME) throw new Error("Intercom event exceeds 128 KiB.");
					const data: Buffer | null = this.child.stdout.read();
					if (!data) break;
					this.buffer = Buffer.concat([this.buffer, data]);
					continue;
				}
				if (newline > MAX_FRAME) throw new Error("Intercom event exceeds 128 KiB.");
				const event = JSON.parse(this.buffer.subarray(0, newline).toString()) as Record<string, unknown>;
				this.buffer = this.buffer.subarray(newline + 1);
				if (!this.ready) {
					if (event.event !== "ready" || event.protocol !== 1 || !isPeer(event.peer)) {
						throw new Error("Incompatible intercom receiver. Protocol 1 is required.");
					}
					this.peer = event.peer;
					this.ready = true;
					this.finishReady();
				} else {
					if (event.event !== "message" || !isMessage(event.message)) throw new Error("Invalid intercom message.");
					this.flowing = this.onMessage(event.message);
				}
			}
		} catch (error) {
			this.fail(error instanceof Error ? error : new Error(String(error)));
		}
	}

	private fail(error: Error): void {
		if (this.closed) return;
		this.closed = true;
		if (this.ready) this.onExit(error);
		else this.finishReady(error);
		void this.stop();
	}

	stop(): Promise<void> {
		if (this.stopping) return this.stopping;
		this.closed = true;
		this.buffer = Buffer.alloc(0);
		this.lifetime.abort();
		this.child.stdin.end();
		this.child.stdout.destroy();
		this.child.stderr.destroy();
		this.stopping = new Promise((resolve) => {
			if (this.child.exitCode !== null || this.child.signalCode !== null) {
				resolve();
				return;
			}
			const force = setTimeout(() => {
				this.child.kill("SIGKILL");
				finish();
			}, 1000);
			const terminate = setTimeout(() => this.child.kill("SIGTERM"), 500);
			const finish = () => {
				clearTimeout(force);
				clearTimeout(terminate);
				resolve();
			};
			this.child.once("close", finish);
		});
		return this.stopping;
	}

	private command(args: string[], signal?: AbortSignal): Promise<unknown> {
		if (this.closed) return Promise.reject(new Error("Intercom is off."));
		return new Promise((resolve, reject) => {
			execFile(
				this.binary,
				["--json", ...args],
				{
					timeout: PROCESS_TIMEOUT,
					killSignal: "SIGKILL",
					maxBuffer: 256 * 1024,
					windowsHide: true,
					signal: signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal,
				},
				(error, stdout) => {
					let value: unknown;
					try {
						value = JSON.parse(stdout);
					} catch (parseError) {
						reject(error ?? parseError);
						return;
					}
					if (value && typeof value === "object" && "error" in value) {
						const detail = value.error as { message?: unknown };
						reject(new Error(typeof detail?.message === "string" ? detail.message : "Intercom command failed."));
					} else if (error) reject(error);
					else resolve(value);
				},
			);
		});
	}

	async list(signal?: AbortSignal): Promise<Peer[]> {
		const result = (await this.command(["list"], signal)) as { peers?: unknown };
		if (!result || !Array.isArray(result.peers) || !result.peers.every(isPeer))
			throw new Error("Invalid intercom peer list.");
		return result.peers;
	}

	async send(peer: string, text: string, signal?: AbortSignal): Promise<string> {
		const result = (await this.command(["send", peer, text, "--from", this.peer.id], signal)) as {
			status?: unknown;
			id?: unknown;
		};
		if (!result || result.status !== "accepted" || typeof result.id !== "string" || !ID.test(result.id)) {
			throw new Error("Invalid intercom acceptance.");
		}
		return result.id;
	}
}
