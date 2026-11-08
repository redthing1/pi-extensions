export const PROTOCOL_VERSION = 4;
export const MAX_HEADER_BYTES = 64 * 1024;
export const MAX_PAYLOAD_BYTES = 32 * 1024 * 1024;
export const FRAME = { ready: 1, request: 2, data: 3, result: 4, error: 5 };
const PREFIX_BYTES = 13;

export function createProtocol(onRequest, onFailure) {
	let chunks = [];
	let bytes = 0;
	let expected;
	let stopped = false;
	function take(length) {
		const result = Buffer.allocUnsafe(length);
		let offset = 0;
		while (offset < length) {
			const chunk = chunks[0];
			const count = Math.min(length - offset, chunk.length);
			chunk.copy(result, offset, 0, count);
			offset += count;
			if (count === chunk.length) chunks.shift();
			else chunks[0] = chunk.subarray(count);
		}
		bytes -= length;
		return result;
	}
	function accept(chunk) {
		if (stopped) return;
		chunks.push(chunk);
		bytes += chunk.length;
		try {
			while (!stopped) {
				if (!expected) {
					if (bytes < PREFIX_BYTES) break;
					const prefix = take(PREFIX_BYTES);
					const header = prefix.readUInt32BE(1);
					const payload = prefix.readBigUInt64BE(5);
					if (prefix[0] !== FRAME.request || header > MAX_HEADER_BYTES || payload > BigInt(MAX_PAYLOAD_BYTES))
						throw new Error("invalid request frame");
					expected = { header, payload: Number(payload) };
				}
				if (bytes < expected.header + expected.payload) break;
				const header = JSON.parse(take(expected.header).toString("utf8"));
				const payload = take(expected.payload);
				expected = undefined;
				onRequest({ header, payload });
			}
		} catch (error) {
			stopped = true;
			onFailure(error);
		}
	}
	function writeFrame(type, header, payload = Buffer.alloc(0)) {
		const encoded = Buffer.from(JSON.stringify(header), "utf8");
		if (encoded.length > MAX_HEADER_BYTES || payload.length > MAX_PAYLOAD_BYTES)
			throw new Error("worker attempted to write an oversized frame");
		const prefix = Buffer.allocUnsafe(PREFIX_BYTES);
		prefix[0] = type;
		prefix.writeUInt32BE(encoded.length, 1);
		prefix.writeBigUInt64BE(BigInt(payload.length), 5);
		return process.stdout.write(Buffer.concat([prefix, encoded, payload]));
	}
	return {
		accept,
		writeFrame,
		async writeStreamingFrame(type, header, payload) {
			if (writeFrame(type, header, payload)) return;
			await new Promise((resolve) => process.stdout.once("drain", resolve));
		},
		finish() {
			if (bytes || expected) throw new Error("incomplete request frame");
		},
		stop() {
			stopped = true;
			chunks = [];
			bytes = 0;
		},
	};
}
