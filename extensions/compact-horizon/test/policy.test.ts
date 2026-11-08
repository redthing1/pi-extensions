import assert from "node:assert/strict";
import { type AssistantMessage, normalizeContext, getCurrentSystemPrompt, getCurrentTools, type Usage } from "@earendil-works/pi-ai";
import type { SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import {
	checkpointHeadroom,
	dropOldestSourceGroup,
	estimatePendingTokens,
	fitCheckpointSource,
	selectRetainedAnchor,
	shouldCheckpointTokens,
} from "../policy.ts";

function assertBoundary(contextWindow: number, maxTokens: number, firstCompactToken: number): void {
	assert.equal(shouldCheckpointTokens(firstCompactToken - 1, contextWindow, maxTokens), false);
	assert.equal(shouldCheckpointTokens(firstCompactToken, contextWindow, maxTokens), true);
}

assert.equal(checkpointHeadroom(1_000_000, 384_000), 36_864);
assert.equal(checkpointHeadroom(32_768, 32_768), 16_384);
assertBoundary(65_536, 8_192, 53_248);
assertBoundary(65_536, 16_384, 45_056);
assertBoundary(131_072, 16_384, 110_592);
assertBoundary(1_000_000, 384_000, 963_136);
assert.equal(shouldCheckpointTokens(1_000, 0, 20_000), false);

const usage: Usage = {
	input: 900,
	output: 100,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 1_000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const assistant: AssistantMessage = {
	role: "assistant",
	content: [{ type: "text", text: "measured prefix" }],
	api: "openai-completions",
	provider: "openai",
	model: "test-model",
	usage,
	stopReason: "stop",
	timestamp: 1,
};
const anchoredContext = normalizeContext({
	systemPrompt: "This prefix is already represented by provider usage.",
	messages: [assistant, { role: "user", content: "x".repeat(400), timestamp: 2 }],
});
assert.equal(estimatePendingTokens(anchoredContext), 1_156);

function entry(id: string, parentId: string | null, message: SessionMessageEntry["message"]): SessionMessageEntry {
	return { type: "message", id, parentId, timestamp: "2026-01-01T00:00:00Z", message };
}

function user(id: string, parentId: string | null, text: string): SessionMessageEntry {
	return entry(id, parentId, { role: "user", content: text, timestamp: Number(id) });
}

function reply(id: string, parentId: string, text: string): SessionMessageEntry {
	return entry(id, parentId, {
		...assistant,
		content: [{ type: "text", text }],
		usage: { ...usage, input: 0, output: 0, totalTokens: 0 },
		timestamp: Number(id),
	});
}

const twoTurns: SessionEntry[] = [
	user("1", null, "first request"),
	reply("2", "1", "first response"),
	user("3", "2", "second request"),
	reply("4", "3", "second response"),
];
const sourceContext = normalizeContext({ systemPrompt: "system", messages: [] });

assert.deepEqual(
	selectRetainedAnchor({
		branchEntries: twoTurns,
		sourceContext,
		checkpoint: "checkpoint",
		contextWindow: 100_000,
		desiredOutputCap: 8_192,
		keepRecentTokens: 10_000,
	}),
	{ firstKeptEntryId: "1" },
);

assert.deepEqual(
	selectRetainedAnchor({
		branchEntries: twoTurns,
		sourceContext,
		checkpoint: "checkpoint",
		contextWindow: 100_000,
		desiredOutputCap: 8_192,
		keepRecentTokens: 1,
	}),
	{ firstKeptEntryId: null },
);

const toolTurn: SessionEntry[] = [
	user("1", null, "inspect"),
	entry("2", "1", {
		...assistant,
		content: [
			{ type: "toolCall", id: "a", name: "read", arguments: { path: "a" } },
			{ type: "toolCall", id: "b", name: "read", arguments: { path: "b" } },
		],
		usage: { ...usage, input: 0, output: 0, totalTokens: 0 },
	}),
	entry("3", "2", {
		role: "toolResult",
		toolCallId: "a",
		toolName: "read",
		content: [{ type: "text", text: "a" }],
		isError: false,
		timestamp: 3,
	}),
	entry("4", "3", {
		role: "toolResult",
		toolCallId: "b",
		toolName: "read",
		content: [{ type: "text", text: "b" }],
		isError: false,
		timestamp: 4,
	}),
];
assert.equal(
	selectRetainedAnchor({
		branchEntries: toolTurn,
		sourceContext,
		checkpoint: "checkpoint",
		contextWindow: 100_000,
		desiredOutputCap: 8_192,
		keepRecentTokens: 10_000,
	}).firstKeptEntryId,
	"1",
);
assert.equal(
	selectRetainedAnchor({
		branchEntries: toolTurn.slice(0, -1),
		sourceContext,
		checkpoint: "checkpoint",
		contextWindow: 100_000,
		desiredOutputCap: 8_192,
		keepRecentTokens: 10_000,
	}).firstKeptEntryId,
	null,
);

const measuredLargeTurn: SessionEntry[] = [
	user("1", null, "old request"),
	reply("2", "1", "old response"),
	user("3", "2", "structurally small but provider-expensive request"),
	entry("4", "3", {
		...assistant,
		content: [{ type: "text", text: "provider-measured response" }],
		usage: { ...usage, input: 90_000, totalTokens: 90_000 },
		timestamp: 4,
	}),
	user("5", "4", "latest request"),
];
assert.equal(
	selectRetainedAnchor({
		branchEntries: measuredLargeTurn,
		sourceContext,
		checkpoint: "checkpoint",
		contextWindow: 100_000,
		desiredOutputCap: 8_192,
		keepRecentTokens: 30_000,
	}).firstKeptEntryId,
	"5",
);

const reduced = dropOldestSourceGroup(normalizeContext({
	systemPrompt: "system",
	messages: [
		{ role: "user", content: "old", timestamp: 1 },
		assistant,
		{ role: "system", content: "later instruction", sections: { cwd: "remote" }, toolsAdded: [{ name: "read", description: "Read", parameters: {} }], timestamp: 2 },
		{ role: "user", content: "new", timestamp: 3 },
	],
}));
assert.deepEqual(reduced?.messages.map((message) => message.role), ["system", "user"]);
assert.match(getCurrentSystemPrompt(reduced?.messages ?? []), /later instruction/);
assert.equal(getCurrentTools(reduced?.messages ?? [])[0]?.name, "read");

const fitted = fitCheckpointSource(
	normalizeContext({
		systemPrompt: "system",
		messages: [
			{ role: "user", content: "old", timestamp: 1 },
			{ ...assistant, usage: { ...usage, input: 100_000, totalTokens: 100_000 } },
			{ role: "user", content: "new", timestamp: 2 },
		],
	}),
	20_000,
	4_000,
);
assert.deepEqual(fitted.context.messages.map((message) => (message.role === "user" ? message.content : message.role)), [
	"system",
	"new",
]);
assert.ok(fitted.estimatedTokens < 100_000);
