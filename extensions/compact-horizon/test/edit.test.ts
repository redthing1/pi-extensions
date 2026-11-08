import assert from "node:assert/strict";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { editCheckpoint } from "../edit.ts";
import { encodeCheckpoint } from "../prompts.ts";

const manager = SessionManager.inMemory();
manager.appendMessage({ role: "user", content: "history", timestamp: 1 });
const checkpointId = manager.appendCompaction(encodeCheckpoint("original"), null, 100);
manager.appendMessage({ role: "user", content: "later request", timestamp: 2 });
let edited: string | undefined = "corrected";
let saveCount = 0;
let duringEditor = () => {};
const ctx = {
	hasUI: true,
	isIdle: () => true,
	hasPendingMessages: () => false,
	sessionManager: manager,
	ui: {
		editor: async (_title: string, body?: string) => {
			assert.equal(body, saveCount ? "corrected" : "original");
			duringEditor();
			return edited;
		},
		notify: () => {},
	},
	editCompactionSummary: (id: string, summary: string) => {
		assert.equal(id, checkpointId);
		assert.equal(summary, encodeCheckpoint("corrected"));
		manager.appendContextEdit(id, { content: summary });
		saveCount++;
	},
};
await editCheckpoint(ctx);
assert.equal(saveCount, 1);
assert.equal(manager.getEntry(checkpointId)?.type, "compaction");
await editCheckpoint(ctx); // unchanged
edited = undefined;
await editCheckpoint(ctx); // cancelled
assert.equal(saveCount, 1);
edited = " ";
await assert.rejects(editCheckpoint(ctx), /must not be empty/);
edited = "another correction";
duringEditor = () => { manager.appendCustomEntry("changed", {}); };
await assert.rejects(editCheckpoint(ctx), /conversation changed/);
assert.equal(saveCount, 1);
await assert.rejects(editCheckpoint({ ...ctx, isIdle: () => false }), /idle/);
await assert.rejects(editCheckpoint({ ...ctx, hasUI: false }), /interactive editor/);
