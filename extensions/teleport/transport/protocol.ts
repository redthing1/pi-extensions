const PREFIX_BYTES = 13;
const MAX_HEADER_BYTES = 64 * 1024;
const MAX_PAYLOAD_BYTES = 32 * 1024 * 1024;

export const PROTOCOL_VERSION = 4;

export const FRAME = {
	ready: 1,
	request: 2,
	data: 3,
	result: 4,
	error: 5,
} as const;

export type FrameType = (typeof FRAME)[keyof typeof FRAME];

export interface ProtocolFrame {
	type: FrameType;
	header: Record<string, unknown>;
	payload: Buffer<ArrayBufferLike>;
}

export function encodeFrame(
	type: FrameType,
	header: Record<string, unknown>,
	payload: Buffer<ArrayBufferLike> = Buffer.alloc(0),
): Buffer<ArrayBufferLike> {
	const headerBytes = Buffer.from(JSON.stringify(header), "utf8");
	if (headerBytes.length > MAX_HEADER_BYTES) throw new Error("Protocol header exceeds limit");
	if (payload.length > MAX_PAYLOAD_BYTES) throw new Error("Protocol payload exceeds limit");

	const prefix = Buffer.allocUnsafe(PREFIX_BYTES);
	prefix.writeUInt8(type, 0);
	prefix.writeUInt32BE(headerBytes.length, 1);
	prefix.writeBigUInt64BE(BigInt(payload.length), 5);
	return Buffer.concat([prefix, headerBytes, payload]);
}

export class FrameDecoder {
	private readonly prefix = Buffer.alloc(PREFIX_BYTES);
	private prefixBytes = 0;
	private body: Buffer | undefined;
	private bodyBytes = 0;
	private headerLength = 0;
	private type: FrameType = FRAME.ready;

	push(chunk: Buffer<ArrayBufferLike>): ProtocolFrame[] {
		const frames: ProtocolFrame[] = [];
		let offset = 0;
		while (offset < chunk.length) {
			if (!this.body) {
				const count = Math.min(PREFIX_BYTES - this.prefixBytes, chunk.length - offset);
				chunk.copy(this.prefix, this.prefixBytes, offset, offset + count);
				this.prefixBytes += count;
				offset += count;
				if (this.prefixBytes < PREFIX_BYTES) break;
				const type = this.prefix[0];
				if (!isFrameType(type)) throw new Error(`Unknown protocol frame type: ${type}`);
				this.type = type;
				this.headerLength = this.prefix.readUInt32BE(1);
				const payloadLength = this.prefix.readBigUInt64BE(5);
				if (this.headerLength > MAX_HEADER_BYTES) throw new Error("Protocol header exceeds limit");
				if (payloadLength > BigInt(MAX_PAYLOAD_BYTES)) throw new Error("Protocol payload exceeds limit");
				this.body = Buffer.allocUnsafe(this.headerLength + Number(payloadLength));
				this.bodyBytes = 0;
			}
			const count = Math.min(this.body.length - this.bodyBytes, chunk.length - offset);
			chunk.copy(this.body, this.bodyBytes, offset, offset + count);
			this.bodyBytes += count;
			offset += count;
			if (this.bodyBytes < this.body.length) break;
			const headerValue: unknown = JSON.parse(this.body.subarray(0, this.headerLength).toString("utf8"));
			if (!isRecord(headerValue)) throw new Error("Protocol header must be an object");
			frames.push({ type: this.type, header: headerValue, payload: this.body.subarray(this.headerLength) });
			this.body = undefined;
			this.prefixBytes = 0;
		}

		return frames;
	}

	finish(): void {
		if (this.prefixBytes || this.body) throw new Error("Protocol stream ended with a partial frame");
	}
}

function isFrameType(value: number): value is FrameType {
	return (
		value === FRAME.ready ||
		value === FRAME.request ||
		value === FRAME.data ||
		value === FRAME.result ||
		value === FRAME.error
	);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
