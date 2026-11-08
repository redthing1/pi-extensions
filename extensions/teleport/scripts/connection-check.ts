import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { TeleportConnection } from "../transport/connection.ts";
import { encodeFrame, FRAME, PROTOCOL_VERSION } from "../transport/protocol.ts";

const closing = new TeleportConnection({ destination: "fixture", onFailure() {} });
let allowStart!: () => void;
const gate = new Promise<void>((resolve) => {
	allowStart = resolve;
});
const calls: string[] = [];
closing.master.start = () => gate;
closing.scratch.create = async () => {
	calls.push("create");
};
closing.scratch.installWorker = async () => {
	throw new Error("bootstrap continued after close");
};
closing.scratch.remove = async () => {
	calls.push("remove");
};
closing.master.close = async () => {
	calls.push("close");
};
const starting = closing.start("/workspace");
const refused = assert.rejects(starting, /closing|closed/);
await assert.rejects(() => closing.start("/workspace"), /already started/);
const stopped = closing.close();
assert.equal(closing.close(), stopped);
await Promise.resolve();
assert.deepEqual(calls, [], "close must wait for in-flight allocation before disposing its owners");
allowStart();
await Promise.all([refused, stopped]);
assert.deepEqual(calls, ["remove", "close"]);

let cleanupCompleted!: () => void;
const cleaned = new Promise<void>((resolve) => {
	cleanupCompleted = resolve;
});
const reporting = new TeleportConnection({
	destination: "fixture",
	onFailure() {
		throw new Error("synthetic notification failure");
	},
});
reporting.master.start = async () => {};
reporting.scratch.create = async () => {};
reporting.scratch.installWorker = async () => {};
reporting.scratch.remove = async () => {};
reporting.master.close = async () => {
	cleanupCompleted();
};
const worker = spawn("node", ["-e", "process.stdin.resume(); process.stdin.on('end',()=>process.exit(0));"], {
	stdio: ["pipe", "pipe", "pipe"],
});
reporting.master.spawnChannel = (command) => {
	const nonce = /pi-teleport-([a-f0-9]{32})/u.exec(command)?.[1];
	assert(nonce);
	setTimeout(
		() =>
			worker.stdout.emit(
				"data",
				encodeFrame(FRAME.ready, {
					nonce,
					protocolVersion: PROTOCOL_VERSION,
					cwd: "/workspace",
					root: "/workspace",
					home: "/home/fixture",
					pid: 123,
					runtime: "fixture",
					shell: "/bin/sh",
					capabilities: { find: false, grep: false },
				}),
			),
		0,
	);
	return worker;
};
let timer: ReturnType<typeof setTimeout> | undefined;
try {
	await reporting.start("/workspace");
	worker.stdout.emit("data", encodeFrame(FRAME.result, { id: "unknown", result: {} }));
	await Promise.race([
		cleaned,
		new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => reject(new Error("reporter exception prevented automatic cleanup")), 2000);
		}),
	]);
} finally {
	if (timer) clearTimeout(timer);
	await reporting.close();
}
console.log("teleport connection checks passed: concurrent start/close and cleanup despite reporter failure");
