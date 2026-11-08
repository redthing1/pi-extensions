export const CHECKPOINT_STRATEGY = "compact-horizon";
export const CHECKPOINT_MARKER = `[${CHECKPOINT_STRATEGY}]`;

const CHECKPOINT_PREFIX = `${CHECKPOINT_MARKER}\n\n`;

export const CHECKPOINT_PROMPT = `You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.

Your entire response must be the handoff summary addressed to the next model; represent any pending user request as work for that model.

Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done (clear next steps)
- Any critical data, examples, or references needed to continue

Be concise, structured, and focused on helping the next LLM seamlessly continue the work.`;

export const CONTINUATION_PROMPT = `Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:`;

export function encodeCheckpoint(body: string): string {
	return `${CHECKPOINT_PREFIX}${body.trim()}`;
}

export function decodeCheckpoint(summary: string): string | undefined {
	if (!summary.startsWith(CHECKPOINT_PREFIX)) return undefined;
	const body = summary.slice(CHECKPOINT_PREFIX.length).trim();
	return body || undefined;
}

export function formatContinuation(body: string): string {
	return `${CONTINUATION_PROMPT}\n\n${body}`;
}
