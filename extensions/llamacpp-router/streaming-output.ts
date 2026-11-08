import {
	parseStreamingJson,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type StopReason,
	type ThinkingContent,
	type TextContent,
	type ToolCall,
} from "@earendil-works/pi-ai";
import { isRecord } from "./guards.js";

interface StreamingToolCallBlock extends ToolCall {
	partialArgs?: string;
	streamIndex?: number;
}

export interface ChoiceDelta {
	content?: string | null;
	tool_calls?: unknown;
	[key: string]: unknown;
}

export interface ChoiceChunk {
	delta?: ChoiceDelta;
	finish_reason?: unknown;
	usage?: unknown;
}

export class StreamingOutputWriter {
	private currentBlock: TextContent | ThinkingContent | null = null;
	private readonly toolBlocks: StreamingToolCallBlock[] = [];

	constructor(
		private readonly stream: AssistantMessageEventStream,
		private readonly output: AssistantMessage,
	) {}

	acceptDelta(delta: ChoiceDelta): void {
		const contentDelta = typeof delta.content === "string" ? delta.content : undefined;
		if (contentDelta && contentDelta.length > 0) {
			this.acceptText(contentDelta);
		}

		const reasoningDelta = firstReasoningDelta(delta);
		if (reasoningDelta) {
			this.acceptReasoning(reasoningDelta);
		}

		for (const toolCall of parseToolCallDeltas(delta.tool_calls)) {
			this.acceptToolCall(toolCall);
		}

		attachReasoningDetails(delta.reasoning_details, this.output);
	}

	finish(): void {
		this.finishTextOrThinking(this.currentBlock);
		this.currentBlock = null;
		this.finishToolCalls();
	}

	private acceptText(delta: string): void {
		this.finishToolCalls();
		if (!this.currentBlock || this.currentBlock.type !== "text") {
			this.finishTextOrThinking(this.currentBlock);
			this.currentBlock = { type: "text", text: "" };
			this.output.content.push(this.currentBlock);
			this.stream.push({ type: "text_start", contentIndex: this.contentIndex(this.currentBlock), partial: this.output });
		}
		this.currentBlock.text += delta;
		this.stream.push({
			type: "text_delta",
			contentIndex: this.contentIndex(this.currentBlock),
			delta,
			partial: this.output,
		});
	}

	private acceptReasoning(delta: { field: string; delta: string }): void {
		this.finishToolCalls();
		if (!this.currentBlock || this.currentBlock.type !== "thinking") {
			this.finishTextOrThinking(this.currentBlock);
			this.currentBlock = { type: "thinking", thinking: "", thinkingSignature: delta.field };
			this.output.content.push(this.currentBlock);
			this.stream.push({
				type: "thinking_start",
				contentIndex: this.contentIndex(this.currentBlock),
				partial: this.output,
			});
		}
		this.currentBlock.thinking += delta.delta;
		this.stream.push({
			type: "thinking_delta",
			contentIndex: this.contentIndex(this.currentBlock),
			delta: delta.delta,
			partial: this.output,
		});
	}

	private acceptToolCall(toolCall: ParsedToolCallDelta): void {
		this.finishTextOrThinking(this.currentBlock);
		this.currentBlock = null;

		let block = findToolBlock(this.toolBlocks, toolCall.streamIndex, toolCall.id);
		if (!block) {
			block = {
				type: "toolCall",
				id: toolCall.id ?? "",
				name: toolCall.name ?? "",
				arguments: {},
				partialArgs: "",
				streamIndex: toolCall.streamIndex,
			};
			this.toolBlocks.push(block);
			this.output.content.push(block);
			this.stream.push({ type: "toolcall_start", contentIndex: this.contentIndex(block), partial: this.output });
		}

		if (!block.id && toolCall.id) block.id = toolCall.id;
		if (!block.name && toolCall.name) block.name = toolCall.name;
		if (block.streamIndex === undefined && toolCall.streamIndex !== undefined) {
			block.streamIndex = toolCall.streamIndex;
		}
		if (toolCall.argumentsDelta) {
			block.partialArgs += toolCall.argumentsDelta;
			block.arguments = parseStreamingJson<ToolCall["arguments"]>(block.partialArgs);
		}
		this.stream.push({
			type: "toolcall_delta",
			contentIndex: this.contentIndex(block),
			delta: toolCall.argumentsDelta ?? "",
			partial: this.output,
		});
	}

	private finishTextOrThinking(block: TextContent | ThinkingContent | null): void {
		if (!block) return;
		const index = this.contentIndex(block);
		if (index === -1) return;
		if (block.type === "text") {
			this.stream.push({ type: "text_end", contentIndex: index, content: block.text, partial: this.output });
		} else {
			this.stream.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: this.output });
		}
	}

	private finishToolCalls(): void {
		for (const block of this.toolBlocks.splice(0)) {
			const index = this.contentIndex(block);
			if (index === -1) continue;
			block.arguments = parseStreamingJson<ToolCall["arguments"]>(block.partialArgs);
			delete block.partialArgs;
			delete block.streamIndex;
			this.stream.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: this.output });
		}
	}

	private contentIndex(block: TextContent | ThinkingContent | StreamingToolCallBlock): number {
		return this.output.content.indexOf(block);
	}
}

export function firstChoice(value: unknown): ChoiceChunk | undefined {
	if (!Array.isArray(value)) return undefined;
	const choice = value[0];
	if (!isRecord(choice)) return undefined;
	return {
		delta: isRecord(choice.delta) ? choice.delta : undefined,
		finish_reason: choice.finish_reason,
		usage: choice.usage,
	};
}

export function mapStopReason(reason: unknown): { stopReason: StopReason; errorMessage?: string } | undefined {
	if (reason === undefined || reason === null) return undefined;
	if (typeof reason !== "string") {
		return { stopReason: "error", errorMessage: "Provider returned a non-string finish_reason" };
	}
	switch (reason) {
		case "stop":
		case "end":
			return { stopReason: "stop" };
		case "length":
			return { stopReason: "length" };
		case "function_call":
		case "tool_calls":
			return { stopReason: "toolUse" };
		case "content_filter":
			return { stopReason: "error", errorMessage: "Provider finish_reason: content_filter" };
		case "network_error":
			return { stopReason: "error", errorMessage: "Provider finish_reason: network_error" };
		default:
			return { stopReason: "error", errorMessage: `Provider finish_reason: ${reason}` };
	}
}

function firstReasoningDelta(delta: ChoiceDelta): { field: string; delta: string } | undefined {
	for (const field of ["reasoning_content", "reasoning", "reasoning_text"]) {
		const value = delta[field];
		if (typeof value === "string" && value.length > 0) {
			return { field, delta: value };
		}
	}
	return undefined;
}

interface ParsedToolCallDelta {
	streamIndex?: number;
	id?: string;
	name?: string;
	argumentsDelta?: string;
}

function parseToolCallDeltas(value: unknown): ParsedToolCallDelta[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((entry) => {
		if (!isRecord(entry)) return [];
		const fn = isRecord(entry.function) ? entry.function : undefined;
		return [
			{
				streamIndex: typeof entry.index === "number" ? entry.index : undefined,
				id: typeof entry.id === "string" ? entry.id : undefined,
				name: typeof fn?.name === "string" ? fn.name : undefined,
				argumentsDelta: typeof fn?.arguments === "string" ? fn.arguments : undefined,
			},
		];
	});
}

function findToolBlock(
	blocks: StreamingToolCallBlock[],
	streamIndex: number | undefined,
	id: string | undefined,
): StreamingToolCallBlock | undefined {
	return blocks.find((block) => {
		if (streamIndex !== undefined && block.streamIndex === streamIndex) return true;
		return id !== undefined && id.length > 0 && block.id === id;
	});
}

function attachReasoningDetails(value: unknown, output: AssistantMessage): void {
	if (!Array.isArray(value)) return;
	for (const detail of value) {
		if (!isRecord(detail) || detail.type !== "reasoning.encrypted") continue;
		if (typeof detail.id !== "string" || detail.data === undefined) continue;
		const matching = output.content.find((block) => block.type === "toolCall" && block.id === detail.id);
		if (matching?.type === "toolCall") {
			matching.thoughtSignature = JSON.stringify(detail);
		}
	}
}
