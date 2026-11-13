import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { FRAME, FrameDecoder, PROTOCOL_VERSION, encodeFrame, isRecord, type ProtocolFrame } from "./protocol.ts";

interface PendingRequest {
	resolve: (value: WorkerResponse) => void;
	reject: (error: Error) => void;
	onData?: (stream: "stdout" | "stderr", chunk: Buffer) => void;
}

export interface WorkerClientOptions {
	onFailure?: (error: Error) => void;
}

const READY_TIMEOUT_MS = 15_000;
const SHUTDOWN_REQUEST_TIMEOUT_MS = 2_000;
const TRANSPORT_CLOSE_TIMEOUT_MS = 2_000;

export interface WorkerResponse {
	result: Record<string, unknown>;
	payload: Buffer;
}

export interface WorkerReady {
	cwd: string;
	root: string;
	home: string;
	pid: number;
	runtime: string;
	shell: string;
	capabilities: {
		find: boolean;
		grep: boolean;
	};
}

export class WorkerRequestError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(`${code}: ${message}`);
		this.name = "WorkerRequestError";
		this.code = code;
	}
}

export class WorkerClient {
	private readonly decoder = new FrameDecoder();
	private readonly pending = new Map<string, PendingRequest>();
	private nextRequestId = 1;
	private readyResolve: ((value: WorkerReady) => void) | undefined;
	private readyReject: ((error: Error) => void) | undefined;
	private readonly readyPromise: Promise<WorkerReady>;
	private readonly transportClosed: Promise<void>;
	private readonly writeQueue: Buffer[] = [];
	private readyTimer: ReturnType<typeof setTimeout> | undefined;
	private readyReceived = false;
	private writeBlocked = false;
	private queuedBytes = 0;
	private closePromise: Promise<void> | undefined;
	private failure: Error | undefined;
	private closed = false;
	private closing = false;

	constructor(
		private readonly process: ChildProcessWithoutNullStreams,
		private readonly nonce: string,
		private readonly options: WorkerClientOptions = {},
	) {
		this.readyPromise = new Promise<WorkerReady>((resolveReady, rejectReady) => {
			this.readyResolve = resolveReady;
			this.readyReject = rejectReady;
		});
		this.transportClosed = new Promise<void>((resolveClosed) => {
			process.once("close", () => resolveClosed());
		});
		this.readyTimer = setTimeout(() => {
			this.fail(new Error("Timed out waiting for Teleport worker handshake"));
		}, READY_TIMEOUT_MS);
		process.stdout.on("data", (chunk: Buffer) => this.accept(chunk));
		process.stdout.on("end", () => {
			try {
				this.decoder.finish();
				if (!this.closed && !this.closing) this.fail(new Error("Worker protocol stream ended"));
			} catch (error) {
				this.fail(error instanceof Error ? error : new Error(String(error)));
			}
		});
		process.stdin.on("error", (error) => this.fail(error));
		process.once("error", (error) => this.fail(error));
		process.once("close", (code, signal) => {
			if (!this.closed && !this.closing)
				this.fail(new Error(`Worker transport closed (code=${code}, signal=${signal})`));
		});
	}

	ready(): Promise<WorkerReady> {
		return this.readyPromise;
	}

	request(
		op: string,
		params: Record<string, unknown>,
		onData?: (stream: "stdout" | "stderr", chunk: Buffer) => void,
		payload: Buffer<ArrayBufferLike> = Buffer.alloc(0),
	): { id: string; promise: Promise<WorkerResponse> } {
		if (this.closed) throw this.failure ?? new Error("Worker client is closed");
		if (this.closing && op !== "shutdown") throw new Error("Worker client is closing");
		if (!this.readyReceived && op !== "shutdown") throw new Error("Worker is not ready");
		if (this.pending.size >= 64) throw new Error("Worker request limit exceeded");
		const id = `r${this.nextRequestId}`;
		this.nextRequestId += 1;
		const frame = encodeFrame(FRAME.request, { id, op, params }, payload);
		const promise = new Promise<WorkerResponse>((resolveRequest, rejectRequest) => {
			this.pending.set(id, {
				resolve: resolveRequest,
				reject: rejectRequest,
				onData,
			});
		});
		this.enqueueWrite(frame);
		return { id, promise };
	}

	async close(): Promise<void> {
		this.closing = true;
		this.closePromise ??= Promise.resolve().then(() => this.closeInternal());
		await this.closePromise;
	}

	invalidate(error: Error): void {
		this.fail(error);
		void this.close().catch(() => {});
	}

	private accept(chunk: Buffer): void {
		if (this.closed) return;
		try {
			for (const frame of this.decoder.push(chunk)) this.route(frame);
		} catch (error) {
			this.fail(error instanceof Error ? error : new Error(String(error)));
		}
	}

	private route(frame: ProtocolFrame): void {
		if (frame.type === FRAME.ready) {
			if (this.readyReceived) throw new Error("Worker sent duplicate handshake");
			const capabilities = frame.header.capabilities;
			if (
				frame.header.nonce !== this.nonce ||
				frame.header.protocolVersion !== PROTOCOL_VERSION ||
				!isRemotePath(frame.header.cwd) ||
				!isRemotePath(frame.header.root) ||
				!isRemotePath(frame.header.home) ||
				!Number.isSafeInteger(frame.header.pid) ||
				(frame.header.pid as number) <= 0 ||
				typeof frame.header.runtime !== "string" ||
				frame.header.runtime.length > 256 ||
				frame.payload.length !== 0 ||
				!isRemotePath(frame.header.shell) ||
				!isRecord(capabilities) ||
				typeof capabilities.find !== "boolean" ||
				typeof capabilities.grep !== "boolean"
			) {
				throw new Error("Worker handshake is invalid");
			}
			this.readyReceived = true;
			if (this.readyTimer) clearTimeout(this.readyTimer);
			this.readyTimer = undefined;
			this.readyResolve?.({
				cwd: frame.header.cwd,
				root: frame.header.root,
				home: frame.header.home,
				pid: frame.header.pid as number,
				runtime: frame.header.runtime,
				shell: frame.header.shell,
				capabilities: {
					find: capabilities.find,
					grep: capabilities.grep,
				},
			});
			this.readyResolve = undefined;
			this.readyReject = undefined;
			return;
		}

		const id = frame.header.id;
		if (typeof id !== "string") throw new Error("Worker response has no request id");
		const pending = this.pending.get(id);
		if (!pending) throw new Error("Worker response has an unknown request id");

		if (frame.type === FRAME.data) {
			const stream = frame.header.stream;
			if (stream !== "stdout" && stream !== "stderr") throw new Error("Worker data frame has invalid stream");
			pending.onData?.(stream, frame.payload);
			return;
		}

		if (frame.type === FRAME.error) {
			const { code, message } = frame.header;
			if (
				typeof code !== "string" ||
				code.length > 64 ||
				typeof message !== "string" ||
				message.length > 8192 ||
				frame.payload.length
			)
				throw new Error("Worker error frame is malformed");
			this.pending.delete(id);
			pending.reject(new WorkerRequestError(code, message));
			return;
		}
		if (frame.type !== FRAME.result || !isRecord(frame.header.result)) {
			throw new Error("Worker result frame is malformed");
		}
		this.pending.delete(id);
		pending.resolve({ result: frame.header.result, payload: frame.payload });
	}

	private fail(error: Error): void {
		if (this.closed) return;
		this.closed = true;
		this.failure = error;
		if (this.readyTimer) clearTimeout(this.readyTimer);
		this.readyTimer = undefined;
		this.readyReject?.(error);
		this.readyResolve = undefined;
		this.readyReject = undefined;
		for (const pending of this.pending.values()) pending.reject(error);
		this.pending.clear();
		this.writeQueue.length = 0;
		this.queuedBytes = 0;
		if (!this.process.killed) this.process.kill("SIGTERM");
		try {
			this.options.onFailure?.(error);
		} catch {
			// Failure reporting must not replace the transport error.
		}
	}

	private enqueueWrite(frame: Buffer): void {
		if (this.writeBlocked) {
			if (this.queuedBytes + frame.length > 64 * 1024 * 1024) {
				this.fail(new Error("Worker write queue limit exceeded"));
				return;
			}
			this.writeQueue.push(frame);
			this.queuedBytes += frame.length;
			return;
		}
		try {
			this.writeBlocked = !this.process.stdin.write(frame);
		} catch (error) {
			this.fail(error instanceof Error ? error : new Error(String(error)));
			return;
		}
		if (this.writeBlocked) {
			this.process.stdin.once("drain", () => this.flushWrites());
		}
	}

	private flushWrites(): void {
		this.writeBlocked = false;
		while (!this.closed && !this.writeBlocked) {
			const frame = this.writeQueue.shift();
			if (!frame) return;
			this.queuedBytes -= frame.length;
			this.enqueueWrite(frame);
		}
	}

	private async closeInternal(): Promise<void> {
		if (!this.closed) {
			try {
				await withTimeout(this.request("shutdown", {}).promise, SHUTDOWN_REQUEST_TIMEOUT_MS);
			} catch {
				// Transport termination below is the bounded fallback.
			}
		}
		this.closed = true;
		if (this.readyTimer) clearTimeout(this.readyTimer);
		this.readyTimer = undefined;
		const closeError = this.failure ?? new Error("Worker client closed");
		this.readyReject?.(closeError);
		this.readyReject = undefined;
		this.readyResolve = undefined;
		for (const pending of this.pending.values()) pending.reject(closeError);
		this.pending.clear();
		this.writeQueue.length = 0;
		this.queuedBytes = 0;
		this.process.stdin.end();
		if (await waitFor(this.transportClosed, TRANSPORT_CLOSE_TIMEOUT_MS)) return;
		this.process.kill("SIGTERM");
		if (await waitFor(this.transportClosed, TRANSPORT_CLOSE_TIMEOUT_MS)) return;
		this.process.kill("SIGKILL");
		if (!(await waitFor(this.transportClosed, TRANSPORT_CLOSE_TIMEOUT_MS)))
			throw new Error("Worker transport did not terminate");
	}
}

function isRemotePath(value: unknown): value is string {
	return typeof value === "string" && value.startsWith("/") && !value.includes("\0") && value.length <= 4096;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new Error("Worker request timed out")), timeoutMs);
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

async function waitFor(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<false>((resolveTimeout) => {
		timer = setTimeout(() => resolveTimeout(false), timeoutMs);
	});
	const completed = await Promise.race([promise.then(() => true), timeout]);
	if (timer) clearTimeout(timer);
	return completed;
}
