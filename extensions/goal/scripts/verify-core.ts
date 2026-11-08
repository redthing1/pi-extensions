import { strict as assert } from "node:assert";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { accountGoalUsage, blockGoal, completeGoal, createGoal, markGoalProviderError, pauseGoal, resumeGoal, setGoalBudget } from "../src/domain.js";
import { GoalRuntime } from "../src/runtime.js";
import { GoalStore } from "../src/store.js";
import { GOAL_CONTINUATION_MESSAGE, GOAL_STATE_ENTRY } from "../src/types.js";

type SentMessage = Parameters<ExtensionAPI["sendMessage"]>[0];

const start = 1_000;
const goal = createGoal("Ship the goal runtime", 100, start);
assert.equal(goal.status, "active");

const charged = accountGoalUsage(goal, 500, 40, start + 500);
assert.equal(charged.tokensUsed, 40);
assert.equal(charged.timeUsedMs, 500);

const limited = accountGoalUsage(charged, 250, 60, start + 750);
assert.equal(limited.status, "budget_limited");
assert.equal(limited.tokensUsed, 100);

const raised = setGoalBudget(limited, 200, start + 800);
assert.equal(raised.status, "paused");
assert.equal(resumeGoal(raised, start + 900).status, "active");

const blocked = blockGoal(goal, start + 1_000);
assert.equal(blocked.status, "blocked");
assert.equal(resumeGoal(blocked, start + 1_100).status, "active");

const paused = pauseGoal(goal, "interrupted", start + 1_200);
assert.equal(paused.pauseReason, "interrupted");
assert.equal(completeGoal(paused, start + 1_300).status, "complete");

const entries: Array<{ customType: string; data: unknown }> = [];
const sent: SentMessage[] = [];
const context = {
	isIdle: () => true,
	hasPendingMessages: () => false,
	hasUI: false,
	ui: {
		get theme() {
			throw new Error("Headless goal runtime must not read the TUI theme.");
		},
		setStatus: () => {},
	},
	sessionManager: {
		getBranch: () => [],
	},
} as unknown as ExtensionContext;
const api = {
	appendEntry: (customType: string, data: unknown) => entries.push({ customType, data }),
	sendMessage: (message: SentMessage) => sent.push(message),
} as unknown as ExtensionAPI;
const runtime = new GoalRuntime(api);

runtime.setFromUser("Verify goal runtime", 50, "create", context);
assert.equal(sent.length, 1);
runtime.onAgentSettled(context);
assert.equal(sent.length, 1);
assert.equal(sent[0]?.customType, GOAL_CONTINUATION_MESSAGE);
assert.equal(typeof sent[0]?.content, "string");
assert.match(sent[0]?.content as string, /<untrusted_objective>\nVerify goal runtime\n<\/untrusted_objective>/);
assert.equal(entries.at(-1)?.customType, GOAL_STATE_ENTRY);

runtime.onTurnStart(context);
runtime.onMessageEnd(
	{
		role: "assistant",
		usage: { input: 10, output: 5, cacheRead: 30, cacheWrite: 2 },
	} as unknown as AgentMessage,
	context,
);
assert.equal(runtime.goal()?.tokensUsed, 17);
runtime.onTurnEnd(context);
runtime.onAgentEnd([{ role: "assistant", stopReason: "stop" } as unknown as AgentMessage], context);
runtime.onAgentSettled(context);
assert.equal(sent.length, 2);

runtime.onTurnStart(context);
const sentBeforeProviderError = sent.length;
runtime.onAgentEnd([{ role: "assistant", stopReason: "error" } as unknown as AgentMessage], context);
runtime.onAgentSettled(context);
assert.equal(runtime.goal()?.status, "active");
assert.equal(sent.length, sentBeforeProviderError);
assert.notEqual(runtime.goal()?.continuationErrorAt, undefined);
assert.equal(runtime.loopStatus().reason, "waiting after provider error");

runtime.onAgentEnd([{ role: "assistant", stopReason: "error" } as unknown as AgentMessage], context);
runtime.onAgentEnd([{ role: "assistant", stopReason: "stop" } as unknown as AgentMessage], context);
runtime.onAgentSettled(context);
assert.equal(runtime.goal()?.continuationErrorAt, undefined);
assert.equal(sent.length, sentBeforeProviderError + 1);

runtime.onTurnStart(context);
runtime.onAgentEnd([{ role: "assistant", stopReason: "error" } as unknown as AgentMessage], context);
runtime.onAgentSettled(context);
assert.notEqual(runtime.goal()?.continuationErrorAt, undefined);
const sentBeforeManualRecovery = sent.length;
assert.equal(runtime.togglePause(context).message, "Goal resumed");
assert.equal(runtime.goal()?.continuationErrorAt, undefined);
assert.equal(sent.length, sentBeforeManualRecovery + 1);

const sentBeforeTogglePause = sent.length;
assert.equal(runtime.togglePause(context).message, "Goal paused");
assert.equal(runtime.goal()?.status, "paused");
assert.equal(sent.length, sentBeforeTogglePause);
assert.equal(runtime.togglePause(context).message, "Goal resumed");
assert.equal(runtime.goal()?.status, "active");
assert.equal(sent.length, sentBeforeTogglePause + 1);

const waitingGoal = markGoalProviderError(createGoal("Do not retry after reload", undefined, start + 1_500), start + 1_600);
const reloadedSent: SentMessage[] = [];
const reloadedRuntime = new GoalRuntime({
	appendEntry: () => {},
	sendMessage: (message: SentMessage) => reloadedSent.push(message),
} as unknown as ExtensionAPI);
const reloadContext = {
	...context,
	sessionManager: {
		getBranch: () => [{ type: "custom", customType: GOAL_STATE_ENTRY, data: { goal: waitingGoal, reason: "provider-error", writtenAt: start + 1_600 } }],
	},
} as unknown as ExtensionContext;
reloadedRuntime.restore(reloadContext);
reloadedRuntime.maybeContinue(reloadContext);
assert.equal(reloadedRuntime.loopStatus().reason, "waiting after provider error");
assert.equal(reloadedSent.length, 0);

const restoredGoal = createGoal("Keep the latest valid state", undefined, start + 2_000);
const store = new GoalStore({ appendEntry: () => {} });
store.restore({
	sessionManager: {
		getBranch: () => [
			{ type: "custom", customType: GOAL_STATE_ENTRY, data: { goal: restoredGoal, reason: "create", writtenAt: start + 2_000 } },
			{ type: "custom", customType: GOAL_STATE_ENTRY, data: { reason: "clear", writtenAt: start + 2_001 } },
		],
	},
} as unknown as ExtensionContext);
assert.equal(store.goal()?.id, restoredGoal.id);

runtime.onSessionShutdown(context);
console.log("goal core verification passed");
