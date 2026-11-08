import assert from "node:assert/strict";
import {
	CHECKPOINT_MARKER,
	CHECKPOINT_PROMPT,
	CHECKPOINT_STRATEGY,
	CONTINUATION_PROMPT,
	decodeCheckpoint,
	encodeCheckpoint,
	formatContinuation,
} from "../prompts.ts";

assert.equal(CHECKPOINT_STRATEGY, "compact-horizon");
assert.equal(CHECKPOINT_MARKER, "[compact-horizon]");

const encoded = encodeCheckpoint("  current task state\n  ");
assert.equal(encoded, "[compact-horizon]\n\ncurrent task state");
assert.equal(decodeCheckpoint(encoded), "current task state");
assert.equal(decodeCheckpoint("[compact-horizon]"), undefined);
assert.equal(decodeCheckpoint("[compact-horizon]\n\n  "), undefined);
assert.equal(decodeCheckpoint("prefix [compact-horizon]\n\nstate"), undefined);

assert.equal(formatContinuation("state"), `${CONTINUATION_PROMPT}\n\nstate`);
assert.equal(
	CHECKPOINT_PROMPT,
	`You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.

Your entire response must be the handoff summary addressed to the next model; represent any pending user request as work for that model.

Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done (clear next steps)
- Any critical data, examples, or references needed to continue

Be concise, structured, and focused on helping the next LLM seamlessly continue the work.`,
);
assert.match(CONTINUATION_PROMPT, /Another language model started to solve this problem/);
