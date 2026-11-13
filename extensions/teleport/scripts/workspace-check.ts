import { strict as assert } from "node:assert";
import { WorkspaceClient } from "../workspace/client.ts";
import type { WorkerResponse } from "../transport/worker-client.ts";
let response: WorkerResponse = { result: {}, payload: Buffer.alloc(0) };
const workspace = new WorkspaceClient({
	request: () => ({ id: "r1", promise: Promise.resolve(response) }),
	invalidate(error) {
		throw error;
	},
});
function documents(content: string) {
	response = {
		result: {},
		payload: Buffer.from(JSON.stringify([{ path: "/workspace/fixture.md", content, scope: "project" }])),
	};
}
for (const content of ["safe\r\ntext\tfixture", "literal \\x1b example"]) {
	documents(content);
	assert.equal((await workspace.prompts())[0]?.content, content, "accepted template bytes must be preserved");
}
for (const control of ["\x1b]52;c;fixture\x07", "\x85", "\x00", "\r"]) {
	documents(`synthetic ${control} template`);
	await assert.rejects(() => workspace.prompts(), /terminal controls/);
}
response = { result: {}, payload: Buffer.from("/workspace/one\0/workspace/two\0") };
assert.deepEqual(await workspace.find({ pattern: "*", maxResults: 2 }), ["/workspace/one", "/workspace/two"]);
response.payload = Buffer.alloc(100_000);
await assert.rejects(() => workspace.find({ pattern: "*", maxResults: 2 }), /malformed/);
response.payload = Buffer.from("../client-file\0");
await assert.rejects(() => workspace.find({ pattern: "*" }), /malformed/);
console.log(
	"teleport workspace checks passed: prompt editor boundary, raw-byte preservation, and bounded find results",
);
