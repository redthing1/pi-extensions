import assert from "node:assert/strict";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, type TranscriptContext, type Model, type Usage, normalizeContext, getCurrentTools } from "@earendil-works/pi-ai";
import type {
	ExtensionContext,
	SessionBeforeCompactEvent,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { buildCheckpointContext, createCheckpoint } from "../checkpoint.ts";
import { createCheckpointWithFallback, formatCheckpointMessages } from "../index.ts";
import { CHECKPOINT_MARKER, CHECKPOINT_PROMPT, CONTINUATION_PROMPT, encodeCheckpoint } from "../prompts.ts";

const usage: Usage = {
	input: 100,
	output: 20,
	cacheRead: 80,
	cacheWrite: 0,
	totalTokens: 120,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const model: Model<"openai-completions"> = {
	id: "test-model",
	name: "Test Model",
	api: "openai-completions",
	provider: "openai",
	baseUrl: "https://example.invalid",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 131_072,
	maxTokens: 20_000,
};
const response: AssistantMessage = {
	role: "assistant",
	content: [
		{ type: "thinking", thinking: "not part of the checkpoint" },
		{ type: "text", text: "  current state" },
		{ type: "text", text: "next action  " },
	],
	api: model.api,
	provider: model.provider,
	model: model.id,
	usage,
	stopReason: "stop",
	timestamp: 10,
};
const tool = { name: "read", description: "Read", parameters: { type: "object", properties: {} } };
const sourceContext = normalizeContext({
	systemPrompt: "normal active system prompt",
	messages: [
		{ role: "user", content: "history message", timestamp: 3 },
		{ ...response, content: [{ type: "text", text: "history response" }], usage: { ...usage, totalTokens: 0 } },
	],
	tools: [tool],
});
const branchEntries: SessionEntry[] = [
	{
		type: "message",
		id: "kept-entry",
		parentId: null,
		timestamp: "2026-01-01T00:00:00Z",
		message: { role: "user", content: "history message", timestamp: 3 },
	},
	{
		type: "message",
		id: "response-entry",
		parentId: "kept-entry",
		timestamp: "2026-01-01T00:00:01Z",
		message: sourceContext.messages[2],
	},
];

function eventWithSignal(
	signal = new AbortController().signal,
	reason: SessionBeforeCompactEvent["reason"] = "threshold",
): SessionBeforeCompactEvent {
	return {
		type: "session_before_compact",
		sourceContext,
		providerSessionId: "provider-routing-123",
		preparation: {
			firstKeptEntryId: "kept-entry",
			messagesToSummarize: [],
			turnPrefixMessages: [],
			isSplitTurn: false,
			tokensBefore: 42_000,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
		},
		branchEntries,
		reason,
		willRetry: false,
		signal,
	};
}

type CompleteSimple = ExtensionContext["modelRegistry"]["completeSimple"];

function extensionContext(
	completeSimple: CompleteSimple,
	notifications: string[] = [],
	activeModel: Model<"openai-completions"> | null = model,
	remoteZdr = false,
): ExtensionContext {
	return {
		model: activeModel ?? undefined,
		modelRegistry: { completeSimple } as unknown as ExtensionContext["modelRegistry"],
		thinkingLevel: "high",
		privacy: { clientZdr: false, remoteZdr },
		ui: {
			notify(message: string): void {
				notifications.push(message);
			},
		} as unknown as ExtensionContext["ui"],
	} as unknown as ExtensionContext;
}

const built = buildCheckpointContext(sourceContext, model.contextWindow, model.maxTokens, 99);
assert.equal(built.context.messages.length, sourceContext.messages.length + 1);
assert.equal(built.context.messages[0], sourceContext.messages[0]);
assert.equal(built.context.messages[1], sourceContext.messages[1]);
assert.deepEqual(built.context.messages.slice(0, -1), sourceContext.messages);
assert.deepEqual(getCurrentTools(built.context.messages), [tool]);
const appendedPrompt = built.context.messages.at(-1);
assert.equal(appendedPrompt?.role, "user");
assert.ok(appendedPrompt?.role === "user" && typeof appendedPrompt.content !== "string");
assert.equal(appendedPrompt.content[0]?.type === "text" ? appendedPrompt.content[0].text : undefined, CHECKPOINT_PROMPT);
assert.equal(built.maxTokens, 16_384);

const compressibleBuilt = buildCheckpointContext(
	normalizeContext({ messages: [{ role: "user", content: "A".repeat(180_000), timestamp: 1 }] }),
	65_536,
	8_192,
);
assert.ok(compressibleBuilt.maxTokens > 4_000);

const nearlyFullSource = normalizeContext({
	messages: [
		{ role: "user", content: "important old turn", timestamp: 1 },
		{
			...response,
			usage: { ...usage, input: 54_000, totalTokens: 54_000 },
			content: [{ type: "text", text: "measured response" }],
		},
		{ role: "user", content: "pending request", timestamp: 2 },
	],
});
const nearlyFullBuilt = buildCheckpointContext(nearlyFullSource, 65_536, 8_192);
assert.equal(nearlyFullBuilt.context.messages[0], nearlyFullSource.messages[0]);
assert.equal(nearlyFullBuilt.context.messages.length, nearlyFullSource.messages.length + 1);
assert.ok(nearlyFullBuilt.maxTokens >= 1_024);
assert.ok(nearlyFullBuilt.maxTokens < 8_192);

const calls: unknown[][] = [];
const completeSimple = (async (...args: unknown[]) => {
	calls.push(args);
	return response;
}) as unknown as CompleteSimple;
const event = eventWithSignal();
const result = await createCheckpoint(event, extensionContext(completeSimple));
assert.equal(calls.length, 1);
const [, requestContext, options] = calls[0] as [unknown, TranscriptContext, Record<string, unknown>];
assert.equal(requestContext.messages[0], sourceContext.messages[0]);
assert.deepEqual(getCurrentTools(requestContext.messages), [tool]);
assert.equal(options.maxTokens, 16_384);
assert.equal(options.sessionId, "provider-routing-123");
assert.equal(options.reasoning, "high");
assert.equal(options.allowModelFallbacks, true);
assert.equal("toolChoice" in options, false);
assert.equal(options.signal, event.signal);
assert.equal("cacheRetention" in options, false);
assert.deepEqual(result, {
	compaction: {
		summary: encodeCheckpoint("current state\nnext action"),
		label: "horizon",
		firstKeptEntryId: "kept-entry",
		placement: "after-retained",
		tokensBefore: 42_000,
		usage,
		details: {
			strategy: "compact-horizon",
			model: { provider: model.provider, id: model.id },
		},
	},
});

const zdrCalls: unknown[][] = [];
const zdrComplete = (async (...args: unknown[]) => {
	zdrCalls.push(args);
	return response;
}) as unknown as CompleteSimple;
await createCheckpoint(eventWithSignal(), extensionContext(zdrComplete, [], model, true));
const [, , zdrOptions] = zdrCalls[0] as [unknown, TranscriptContext, Record<string, unknown>];
assert.equal(zdrOptions.allowModelFallbacks, false);

const overflowResult = await createCheckpoint(
	eventWithSignal(new AbortController().signal, "overflow"),
	extensionContext(completeSimple),
);
assert.equal(overflowResult?.compaction.firstKeptEntryId, null);

const overflowRetryCalls: TranscriptContext[] = [];
const overflowRetryComplete = (async (_model: unknown, context: TranscriptContext) => {
	overflowRetryCalls.push(context);
	if (overflowRetryCalls.length === 1) {
		return {
			...response,
			content: [],
			stopReason: "error" as const,
			errorMessage: "Requested token count exceeds the model's maximum context length of 131072 tokens",
		};
	}
	return response;
}) as unknown as CompleteSimple;
const overflowRetryEvent = {
	...eventWithSignal(new AbortController().signal, "overflow"),
	sourceContext: {
		...sourceContext,
		messages: [...sourceContext.messages, { role: "user" as const, content: "pending request", timestamp: 4 }],
	},
};
assert.ok(await createCheckpoint(overflowRetryEvent, extensionContext(overflowRetryComplete)));
assert.equal(overflowRetryCalls.length, 2);
assert.equal(overflowRetryCalls[0]?.messages[0], sourceContext.messages[0]);
assert.equal(overflowRetryCalls[1]?.messages[1], overflowRetryEvent.sourceContext.messages[3]);
assert.deepEqual(getCurrentTools(overflowRetryCalls[1]?.messages ?? []), [tool]);
assert.equal(overflowRetryCalls[1]?.messages.includes(sourceContext.messages[0]), false);

const emptyResponse = { ...response, content: [{ type: "text" as const, text: "  " }] };
const emptyComplete = (async () => emptyResponse) as unknown as CompleteSimple;
assert.equal(await createCheckpoint(eventWithSignal(), extensionContext(emptyComplete)), undefined);

let calledWithoutModel = false;
const noModelComplete = (async () => {
	calledWithoutModel = true;
	return response;
}) as unknown as CompleteSimple;
assert.equal(await createCheckpoint(eventWithSignal(), extensionContext(noModelComplete, [], null)), undefined);
assert.equal(calledWithoutModel, false);

const notifications: string[] = [];
const failingComplete = (async () => {
	throw new Error("summary request unavailable");
}) as unknown as CompleteSimple;
assert.equal(await createCheckpointWithFallback(eventWithSignal(), extensionContext(failingComplete, notifications)), undefined);
assert.deepEqual(notifications, ["compact-horizon checkpoint failed; using Pi fallback: summary request unavailable"]);

const lengthNotifications: string[] = [];
const lengthComplete = (async () => ({ ...response, stopReason: "length" as const })) as unknown as CompleteSimple;
assert.equal(
	await createCheckpointWithFallback(eventWithSignal(), extensionContext(lengthComplete, lengthNotifications)),
	undefined,
);
assert.deepEqual(lengthNotifications, [
	"compact-horizon checkpoint failed; using Pi fallback: Checkpoint response reached its output limit",
]);

const toolCallNotifications: string[] = [];
const toolCallComplete = (async () => ({
	...response,
	content: [{ type: "toolCall" as const, id: "call-1", name: "read", arguments: {} }],
})) as unknown as CompleteSimple;
assert.equal(
	await createCheckpointWithFallback(
		eventWithSignal(),
		extensionContext(toolCallComplete, toolCallNotifications),
	),
	undefined,
);
assert.deepEqual(toolCallNotifications, [
	"compact-horizon checkpoint failed; using Pi fallback: Checkpoint response attempted to call a tool",
]);

const abortedController = new AbortController();
abortedController.abort();
const abortNotifications: string[] = [];
const abortingComplete = (async () => {
	throw new DOMException("aborted", "AbortError");
}) as unknown as CompleteSimple;
assert.equal(
	await createCheckpointWithFallback(
		eventWithSignal(abortedController.signal),
		extensionContext(abortingComplete, abortNotifications),
	),
	undefined,
);
assert.deepEqual(abortNotifications, []);

const retainedMessage: AgentMessage = { role: "user", content: "retained", timestamp: 8 };
const checkpointMessage: AgentMessage = {
	role: "compactionSummary",
	summary: encodeCheckpoint("projected state"),
	tokensBefore: 100,
	timestamp: 9,
};
const formatted = formatCheckpointMessages([retainedMessage, checkpointMessage]);
assert.ok(formatted);
assert.equal(formatted[0], retainedMessage);
assert.deepEqual(formatted[1], {
	role: "user",
	content: [{ type: "text", text: `${CONTINUATION_PROMPT}\n\nprojected state` }],
	timestamp: 9,
});

const unknownCheckpoint: AgentMessage = { ...checkpointMessage, summary: `${CHECKPOINT_MARKER}:other\n\nstate` };
assert.equal(formatCheckpointMessages([unknownCheckpoint]), undefined);
