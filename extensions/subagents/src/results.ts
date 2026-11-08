import { Buffer } from "node:buffer";
import { completeOutput } from "./artifacts.ts";
import type { BatchView, ChildPresentation, ChildToolCall, ChildView, RunTargetView } from "./types.ts";

const MAX_INLINE_BYTES = 50_000;
const MAX_INLINE_LINES = 2_000;
const MAX_PRESENTATION_BYTES = 12_000;
const MAX_PRESENTATION_BYTES_PER_CHILD = 2_000;
const MAX_PRESENTATION_LINES = 6;
const MAX_PRESENTATION_TOOL_CALLS = 1_000;
const MAX_PRESENTATION_TOOL_CALLS_PER_CHILD = 500;

export function formatStarted(batch: BatchView): string {
	const mode = batch.background ? "background" : "foreground";
	return [
		`Started ${batch.children.length} ${mode} ${batch.children.length === 1 ? "child" : "children"}.`,
		...batch.children.map((child) => `- ${child.id}: ${child.label} (${child.state})`),
	].join("\n");
}

export function formatTargets(targets: readonly RunTargetView[], offset = 0): string {
	return resultPage(targets, offset).text;
}

export function resultPage(targets: readonly RunTargetView[], offset = 0): { text: string; nextOffset?: number } {
	const includeChildHeading = targets.length > 1;
	const output = targets.map((target) => formatTarget(target, includeChildHeading)).join("\n\n---\n\n");
	const bytes = Buffer.from(output);
	if (!Number.isSafeInteger(offset) || offset < 0 || offset > bytes.length || (bytes[offset] & 0xc0) === 0x80) {
		throw new Error("Invalid result offset; use the offset supplied by the previous page.");
	}
	let end = Math.min(bytes.length, offset + MAX_INLINE_BYTES);
	while (end > offset && (bytes[end] & 0xc0) === 0x80) end -= 1;
	let lines = 0;
	for (let index = offset; index < end; index += 1) {
		if (bytes[index] === 10 && ++lines === MAX_INLINE_LINES) {
			end = index + 1;
			break;
		}
	}
	const page = bytes.subarray(offset, end).toString("utf8");
	return end < bytes.length
		? {
				text: `${page}\n\n[More result: subagent_wait ${JSON.stringify({ ids: targets.map((target) => target.id), offset: end })}]`,
				nextOffset: end,
			}
		: { text: page };
}

export function formatList(targets: readonly RunTargetView[], inspect = false, messageOffset?: number): string {
	const children = uniqueChildren(targets);
	if (children.length === 0) return "No outstanding subagents.";
	const now = Date.now();
	return children
		.map((child) => {
			const lines = [
				`${child.id}: ${child.label} (${child.state}, ${elapsed(child, now)}${child.finishedAt !== undefined ? (child.collected ? ", collected" : ", result ready") : ""})${childActivity(child) ? ` — ${childActivity(child)}` : ""}`,
			];
			const usage = child.usage ?? child.result?.usage;
			if (usage)
				lines.push(
					`Tokens (cumulative): ${usage.input} input, ${usage.output} output, ${usage.cacheRead} cache read, ${usage.cacheWrite} cache write.`,
				);
			lines.push(
				`Context (last response): ${child.progress?.contextTokens ?? "unknown"}${(child.contextWindow ?? 0) > 0 ? ` / ${child.contextWindow}` : ""} tokens.`,
			);
			if (inspect) {
				lines.push(
					`Task preview: ${textPreview(child.task, 4000)}`,
					`Tools: ${child.tools.join(", ") || "none"}`,
					`Model: ${child.model}`,
					`Cwd: ${child.cwd}`,
				);
				const calls = child.toolCalls ?? [];
				for (const call of calls.slice(-8))
					lines.push(
						`  ${call.name} ${call.preview.slice(0, 240)} (${call.status}${call.error ? `: ${call.error.slice(0, 240)}` : ""})`,
					);
				if (calls.length > 8) lines.push(`${calls.length - 8} earlier tool actions omitted.`);
				if (child.latestText?.trim())
					lines.push(`Latest assistant text preview:\n${textPreview(child.latestText, 4000)}`);
				const messages = child.messages ?? [];
				const start = messageOffset ?? Math.max(0, messages.length - 3);
				if (start > messages.length) throw new Error("Message offset exceeds the retained message count.");
				for (const message of messages.slice(start, start + 3))
					lines.push(
						`${message.direction === "parent" ? "To child" : "From child"}${message.error ? ` (not accepted: ${textPreview(message.error, 240)})` : message.delivered ? (message.direction === "parent" ? " (accepted for processing)" : " (announced)") : message.direction === "parent" ? " (queued)" : " (notification pending)"}:\n${message.text}`,
					);
				if (messageOffset === undefined && start > 0)
					lines.push(`[Earlier messages: subagent_list ${JSON.stringify({ ids: [child.id], messageOffset: 0 })}]`);
				if (start + 3 < messages.length)
					lines.push(`[More messages: subagent_list ${JSON.stringify({ ids: [child.id], messageOffset: start + 3 })}]`);
			}
			return lines.join("\n");
		})
		.join("\n\n");
}

function childActivity(child: ChildView): string | undefined {
	if (child.state !== "running") return undefined;
	if (child.activity) return child.activity;
	const latest = child.toolCalls?.at(-1);
	const activity = latest ? `${latest.name} ${latest.preview} (${latest.status})` : "waiting for model output";
	const timestamp = child.progress?.lastActivityAt;
	return `${activity.replace(/\s+/gu, " ").slice(0, 240)}${timestamp ? `; last activity ${new Date(timestamp).toISOString()}` : ""}`;
}

function textPreview(text: string, maxBytes: number): string {
	const bytes = Buffer.from(text);
	if (bytes.length <= maxBytes) return text;
	let end = maxBytes;
	while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
	return `${bytes.subarray(0, end).toString("utf8")}…`;
}

function elapsed(child: ChildView, now: number): string {
	const start = child.startedAt ?? child.createdAt;
	const milliseconds = Math.max(0, (child.finishedAt ?? now) - start);
	if (milliseconds < 1_000) return `${milliseconds}ms`;
	if (milliseconds < 60_000) return `${Math.floor(milliseconds / 1_000)}s`;
	return `${Math.floor(milliseconds / 60_000)}m`;
}

export function childPresentations(targets: readonly RunTargetView[], includeDetails = true): ChildPresentation[] {
	const children = uniqueChildren(targets);
	if (children.length === 0) return [];
	const byteBudget = Math.max(
		1,
		Math.min(MAX_PRESENTATION_BYTES_PER_CHILD, Math.floor(MAX_PRESENTATION_BYTES / children.length)),
	);
	const toolBudget = Math.max(
		1,
		Math.min(MAX_PRESENTATION_TOOL_CALLS_PER_CHILD, Math.floor(MAX_PRESENTATION_TOOL_CALLS / children.length)),
	);
	return children.map((child) => {
		const preview =
			includeDetails && child.result ? boundedPreview(completeOutput(child.result), byteBudget) : undefined;
		const childTools = child.toolCalls ?? child.result?.toolCalls ?? [];
		const tools = includeDetails
			? boundedToolCalls(childTools, child.eventsPath ? toolBudget : childTools.length)
			: { calls: [], omitted: 0, headCount: 0 };
		return {
			id: child.id,
			preview: preview?.text,
			previewTruncated: preview?.truncated ?? false,
			usage: child.usage ? { ...child.usage } : child.result ? { ...child.result.usage } : undefined,
			error: child.result?.error,
			totalToolCalls: child.totalToolCalls ?? childTools.length,
			toolCalls: tools.calls,
			omittedToolCalls: tools.omitted,
			toolCallHeadCount: tools.headCount,
		};
	});
}

export function compactTargets(targets: readonly RunTargetView[]): RunTargetView[] {
	return targets.map((target) => {
		if (target.kind === "batch") {
			return {
				...target,
				children: compactChildren(target.children),
			};
		}
		return compactChild(target);
	});
}

export function inspectionPresentations(children: readonly ChildView[], messageOffset?: number): ChildPresentation[] {
	return childPresentations(children, false).map((presentation, index) => {
		const child = children[index];
		const calls = child.toolCalls ?? [];
		const messages = child.messages ?? [];
		const start = messageOffset ?? Math.max(0, messages.length - 3);
		return {
			...presentation,
			toolCalls: calls.slice(-8),
			omittedToolCalls: Math.max(0, calls.length - 8),
			toolCallHeadCount: 0,
			latestText: child.latestText ? textPreview(child.latestText, 4000) : undefined,
			messages: messages.slice(start, start + 3),
			messageOffset: start,
			totalMessages: messages.length,
		};
	});
}

export function targetSummary(target: RunTargetView): string {
	if (target.kind === "child") return `- ${target.id}: ${target.label} (${target.state})`;
	return `- ${target.id}: ${target.state} (${target.children.length} children)`;
}

function formatTarget(target: RunTargetView, includeChildHeading: boolean): string {
	if (target.kind === "child") return formatChild(target, includeChildHeading);
	if (!targetSettled(target)) {
		return [`Batch ${target.id}: ${target.state}`, ...target.children.map(targetSummary)].join("\n");
	}
	const complete = target.children
		.map((child) => `## ${child.label} (${child.id})\n\n${childResult(child)}`)
		.join("\n\n---\n\n");
	return target.error ? `${complete}\n\n${target.error}` : complete;
}

function formatChild(child: ChildView, includeHeading: boolean): string {
	if (!childSettled(child)) return `${child.id}: ${child.label} (${child.state})`;
	const output = childResult(child);
	return includeHeading ? `## ${child.label} (${child.id})\n\n${output}` : output;
}

function childResult(child: ChildView): string {
	if (!child.result) return child.state === "cancelled" ? "Child run was cancelled." : "(no output)";
	return completeOutput(child.result);
}

function compactChildren(children: readonly ChildView[]): ChildView[] {
	return children.map(compactChild);
}

function compactChild(child: ChildView): ChildView {
	const {
		result: _result,
		usage: _usage,
		toolCalls: _toolCalls,
		messages: _messages,
		latestText: _latestText,
		...compact
	} = child;
	const active = child.toolCalls?.filter((tool) => tool.status === "running").at(-1);
	return {
		...compact,
		activity:
			child.state === "running"
				? child.activity || (active ? `${active.name} ${active.preview}`.trim() : "waiting for model output")
				: undefined,
	};
}

function uniqueChildren(targets: readonly RunTargetView[]): ChildView[] {
	const children: ChildView[] = [];
	const seen = new Set<string>();
	for (const target of targets) {
		const candidates = target.kind === "batch" ? target.children : [target];
		for (const child of candidates) {
			if (seen.has(child.id)) continue;
			seen.add(child.id);
			children.push(child);
		}
	}
	return children;
}

function boundedPreview(output: string, maxBytes: number): { text: string; truncated: boolean } {
	const lines = output.trim().split("\n");
	let text = lines.slice(0, MAX_PRESENTATION_LINES).join("\n");
	let truncated = lines.length > MAX_PRESENTATION_LINES;
	if (Buffer.byteLength(text, "utf8") > maxBytes) {
		truncated = true;
		const bytes = Buffer.from(text);
		let end = maxBytes;
		while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
		text = bytes.subarray(0, end).toString("utf8").trimEnd();
	}
	return { text, truncated };
}

function boundedToolCalls(
	toolCalls: readonly ChildToolCall[],
	maxCalls: number,
): {
	calls: readonly ChildToolCall[];
	omitted: number;
	headCount: number;
} {
	if (toolCalls.length <= maxCalls) {
		return { calls: toolCalls.map((tool) => ({ ...tool })), omitted: 0, headCount: toolCalls.length };
	}
	const headCount = Math.ceil(maxCalls / 2);
	const tailCount = maxCalls - headCount;
	return {
		calls: [
			...toolCalls.slice(0, headCount).map((tool) => ({ ...tool })),
			...toolCalls.slice(toolCalls.length - tailCount).map((tool) => ({ ...tool })),
		],
		omitted: toolCalls.length - maxCalls,
		headCount,
	};
}

function targetSettled(batch: BatchView): boolean {
	return batch.children.every(childSettled);
}

function childSettled(child: ChildView): boolean {
	return child.state === "completed" || child.state === "failed" || child.state === "cancelled";
}
