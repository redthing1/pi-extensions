import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { WorkerClient } from "../transport/worker-client.ts";
import { encodeFrame, FRAME, PROTOCOL_VERSION } from "../transport/protocol.ts";

const nonce = "synthetic-handshake";
const ready = encodeFrame(FRAME.ready, {
	nonce,
	protocolVersion: PROTOCOL_VERSION,
	cwd: "/workspace",
	root: "/workspace",
	home: "/home/fixture",
	pid: 123,
	runtime: "fixture",
	shell: "/bin/sh",
	capabilities: { find: true, grep: true },
});
function fake(frames: Buffer[]) {
	const script = `const frames=${JSON.stringify(frames.map((frame) => frame.toString("base64")))}; process.stdin.resume(); for (const frame of frames) process.stdout.write(Buffer.from(frame,'base64')); process.stdin.on('end',()=>process.exit(0));`;
	return spawn("node", ["-e", script], { stdio: ["pipe", "pipe", "pipe"] });
}

for (const invalid of [
	encodeFrame(FRAME.result, { id: "r1", result: [] }),
	encodeFrame(FRAME.result, { id: "unknown", result: {} }),
	encodeFrame(FRAME.data, { id: "r1", stream: "unexpected" }),
	encodeFrame(FRAME.error, { id: "r1", code: {}, message: "fixture" }),
	undefined,
]) {
	const process = fake([ready]);
	let failures = 0;
	const client = new WorkerClient(process, nonce, { onFailure: () => failures++ });
	assert.throws(() => client.request("ping", {}), /not ready/);
	await client.ready();
	const first = client.request("ping", {});
	const second = client.request("ping", {});
	const rejected = Promise.all([assert.rejects(first.promise, /Worker/), assert.rejects(second.promise, /Worker/)]);
	if (invalid) process.stdout.emit("data", invalid);
	else process.stdout.emit("end");
	await rejected;
	assert.equal(failures, 1);
	assert.throws(() => client.request("ping", {}), /Worker/);
	await client.close();
}
const beforeReady = new WorkerClient(fake([]), nonce);
const closedReady = assert.rejects(beforeReady.ready(), /closed/);
await beforeReady.close();
await closedReady;
console.log(
	"teleport client checks passed: malformed responses fail the whole channel, early requests and early close",
);
