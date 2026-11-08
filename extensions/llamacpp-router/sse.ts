export async function* parseSseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
	const decoder = new TextDecoder();
	const reader = body.getReader();
	let buffer = "";
	let dataLines: string[] = [];

	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });

			let lineEnd = findLineEnd(buffer);
			while (lineEnd !== -1) {
				const line = buffer.slice(0, lineEnd).replace(/\r$/, "");
				buffer = buffer.slice(lineEnd + 1);
				const event = consumeLine(line, dataLines);
				if (event !== undefined) {
					yield event;
					dataLines = [];
				}
				lineEnd = findLineEnd(buffer);
			}
		}

		buffer += decoder.decode();
		if (buffer.length > 0) {
			const event = consumeLine(buffer.replace(/\r$/, ""), dataLines);
			if (event !== undefined) {
				yield event;
				dataLines = [];
			}
		}
		if (dataLines.length > 0) {
			yield dataLines.join("\n");
		}
	} finally {
		reader.releaseLock();
	}
}

function consumeLine(line: string, dataLines: string[]): string | undefined {
	if (line.length === 0) {
		return dataLines.length > 0 ? dataLines.join("\n") : undefined;
	}
	if (line.startsWith(":")) {
		return undefined;
	}
	if (!line.startsWith("data:")) {
		return undefined;
	}
	const data = line.slice(5);
	dataLines.push(data.startsWith(" ") ? data.slice(1) : data);
	return undefined;
}

function findLineEnd(buffer: string): number {
	const newline = buffer.indexOf("\n");
	if (newline !== -1) return newline;
	return buffer.indexOf("\r");
}
