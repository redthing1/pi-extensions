const MAX_EVENT_BYTES = 2048;
const MAX_PENDING_BYTES = 8192;
const MAX_PENDING_EVENTS = 8;
const DELIVERY_INTERVAL_MS = 5000;

export const MONITOR_TIMEOUT = 300;
export const MAX_MONITOR_TIMEOUT = 1800;

/** Frames decoded output; process, log and session ownership stay with Jobs. */
export class MonitorEvents {
	private fragment = "";
	private lines: string[] = [];
	private bytes = 0;
	private nextDeliveryAt = 0;
	failure?: string;

	get pending(): readonly string[] {
		return this.lines;
	}
	get dueAt(): number {
		return this.lines.length ? this.nextDeliveryAt : Infinity;
	}

	append(text: string): void {
		if (this.failure) return;
		let start = 0;
		while (start < text.length) {
			const end = text.indexOf("\n", start);
			const part = text.slice(start, end < 0 ? undefined : end);
			if (Buffer.byteLength(this.fragment) + Buffer.byteLength(part) > MAX_EVENT_BYTES) {
				this.fail(`an event exceeded ${MAX_EVENT_BYTES} bytes`);
				return;
			}
			this.fragment += part;
			if (end < 0) return;
			const line = this.fragment.replace(/\r$/, "");
			this.fragment = "";
			if (line.trim()) {
				const bytes = Buffer.byteLength(line);
				if (this.lines.length >= MAX_PENDING_EVENTS || this.bytes + bytes > MAX_PENDING_BYTES) {
					this.fail("too many events arrived before they could be delivered");
					return;
				}
				this.lines.push(line);
				this.bytes += bytes;
			}
			start = end + 1;
		}
	}

	finish(): void {
		if (this.fragment && !this.failure) this.append("\n");
	}
	collect(): void {
		if (this.lines.length) this.nextDeliveryAt = Date.now() + DELIVERY_INTERVAL_MS;
		this.lines = [];
		this.bytes = 0;
	}
	discard(): void {
		this.collect();
		this.fragment = "";
	}
	private fail(reason: string): void {
		this.failure = `Monitor stopped: ${reason}. Print only concise, meaningful changes.`;
		this.fragment = "";
	}
}
