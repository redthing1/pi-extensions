import {
	getDeclaredTools,
	getSystemMessageText,
	normalizeContext,
	resolveTranscript,
	type Api,
	type Context,
	type ImageContent,
	type Message,
	type Model,
	type OpenAICompletionsCompat,
	type SimpleStreamOptions,
	type TextContent,
	type ThinkingContent,
	type Tool,
	type ToolCall,
	type ToolResultMessage,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { mapThinkingLevel } from "./template-compat.js";
import type { RequestConfig, ResolvedCompat } from "./types.js";

export interface ChatCompletionRequest {
	model: string;
	messages: ChatMessage[];
	stream: true;
	stream_options?: { include_usage: true };
	return_progress?: true;
	timings_per_token?: true;
	max_tokens?: number;
	max_completion_tokens?: number;
	temperature?: number;
	tools?: ChatTool[];
	reasoning_effort?: string;
	reasoning?: { effort?: string };
	thinking?: { type: "enabled" | "disabled" };
	enable_thinking?: boolean;
	chat_template_kwargs?: {
		[key: string]: string | number | boolean | null;
	};
	tool_choice?: unknown;
}

export type ChatContentPart =
	| { type: "text"; text: string }
	| { type: "image_url"; image_url: { url: string } };

export interface ChatToolCall {
	id: string;
	type: "function";
	function: {
		name: string;
		arguments: string;
	};
}

export interface ChatMessage {
	role: "system" | "user" | "assistant" | "tool";
	content?: string | ChatContentPart[] | null;
	tool_calls?: ChatToolCall[];
	tool_call_id?: string;
	name?: string;
	reasoning_content?: string;
	reasoning_details?: unknown;
	[key: string]: unknown;
}

export interface ChatTool {
	type: "function";
	function: {
		name: string;
		description: string;
		parameters: unknown;
		strict?: false;
	};
}

export function buildChatRequest(
	model: Model<Api>,
	context: Context,
	options: SimpleStreamOptions | undefined,
	request: RequestConfig,
	compat: ResolvedCompat,
): ChatCompletionRequest {
	const transcript = resolveTranscript(
		normalizeContext(context),
		(model.compat as OpenAICompletionsCompat | undefined)?.supportsMidConvoSystemMessages,
	);
	const payload: ChatCompletionRequest = {
		model: model.id,
		messages: convertMessages(model, transcript, compat),
		stream: true,
	};

	if (request.includeUsage) {
		payload.stream_options = { include_usage: true };
	}
	if (request.returnProgress) {
		payload.return_progress = true;
	}
	if (request.timingsPerToken) {
		payload.timings_per_token = true;
	}
	if (options?.maxTokens) {
		if (compat.maxTokensField === "max_tokens") {
			payload.max_tokens = options.maxTokens;
		} else {
			payload.max_completion_tokens = options.maxTokens;
		}
	}
	if (options?.temperature !== undefined) {
		payload.temperature = options.temperature;
	}

	const toolChoice = readToolChoice(options);
	if (toolChoice !== undefined) {
		payload.tool_choice = toolChoice;
	}

	const tools = getDeclaredTools(transcript.messages);
	if (tools.length > 0) {
		payload.tools = convertTools(tools, compat);
	} else if (hasToolHistory(transcript.messages)) {
		payload.tools = [];
	}

	applyReasoningOptions(payload, model, options, compat);
	return payload;
}

export function resolveCompat(model: Model<Api>): ResolvedCompat {
	const compat = model.compat as OpenAICompletionsCompat | undefined;
	return {
		supportsReasoningEffort: compat?.supportsReasoningEffort ?? false,
		supportsStrictMode: compat?.supportsStrictMode ?? false,
		requiresToolResultName: compat?.requiresToolResultName ?? false,
		requiresAssistantAfterToolResult: compat?.requiresAssistantAfterToolResult ?? false,
		requiresThinkingAsText: compat?.requiresThinkingAsText ?? false,
		requiresReasoningContentOnAssistantMessages: compat?.requiresReasoningContentOnAssistantMessages ?? false,
		thinkingFormat: compat?.thinkingFormat ?? "openai",
		chatTemplateKwargs: compat?.chatTemplateKwargs ?? {},
		maxTokensField: compat?.maxTokensField ?? "max_tokens",
	};
}

function convertMessages(model: Model<Api>, context: TranscriptContext, compat: ResolvedCompat): ChatMessage[] {
	const messages: ChatMessage[] = [];

	let lastRole: string | undefined;
	for (let index = 0; index < context.messages.length; index++) {
		const msg = context.messages[index];
		if (compat.requiresAssistantAfterToolResult && lastRole === "toolResult" && msg.role === "user") {
			messages.push({ role: "assistant", content: "I have processed the tool results." });
		}

		if (msg.role === "system") {
			messages.push({ role: "system", content: sanitizeText(getSystemMessageText(msg)) });
		} else if (msg.role === "user") {
			const content = convertUserContent(msg.content);
			if (content !== undefined) {
				messages.push({ role: "user", content });
			}
		} else if (msg.role === "assistant") {
			const converted = convertAssistantMessage(msg, compat);
			if (converted) {
				messages.push(converted);
			}
		} else if (msg.role === "toolResult") {
			const nextIndex = appendToolResults(model, context.messages, index, messages, compat);
			index = nextIndex;
			lastRole = "toolResult";
			continue;
		}

		lastRole = msg.role;
	}

	return messages;
}

function convertUserContent(content: string | (TextContent | ImageContent)[]): string | ChatContentPart[] | undefined {
	if (typeof content === "string") {
		return sanitizeText(content);
	}

	const parts = content.map((item): ChatContentPart => {
		if (item.type === "text") {
			return { type: "text", text: sanitizeText(item.text) };
		}
		return {
			type: "image_url",
			image_url: {
				url: `data:${item.mimeType};base64,${item.data}`,
			},
		};
	});
	return parts.length > 0 ? parts : undefined;
}

function convertAssistantMessage(
	msg: Extract<Message, { role: "assistant" }>,
	compat: ResolvedCompat,
): ChatMessage | undefined {
	const assistant: ChatMessage = {
		role: "assistant",
		content: null,
	};

	const textBlocks = msg.content.filter(isTextContentBlock);
	const text = textBlocks.map((block) => sanitizeText(block.text)).join("");
	const thinkingBlocks = msg.content
		.filter(isThinkingContentBlock)
		.filter((block) => block.thinking.trim().length > 0);

	if (thinkingBlocks.length > 0) {
		const thinkingText = thinkingBlocks.map((block) => sanitizeText(block.thinking)).join("\n\n");
		if (compat.requiresThinkingAsText) {
			assistant.content = text.length > 0 ? `${thinkingText}\n\n${text}` : thinkingText;
		} else {
			if (text.length > 0) {
				assistant.content = text;
			}
			const signature = thinkingBlocks[0].thinkingSignature;
			if (signature && signature.length > 0) {
				assistant[signature] = thinkingText;
			}
		}
	} else if (text.length > 0) {
		assistant.content = text;
	}

	const toolCalls = msg.content.filter(isToolCallBlock);
	if (toolCalls.length > 0) {
		assistant.tool_calls = toolCalls.map((toolCall) => ({
			id: toolCall.id,
			type: "function",
			function: {
				name: toolCall.name,
				arguments: JSON.stringify(toolCall.arguments),
			},
		}));
		const reasoningDetails = toolCalls.flatMap((toolCall) => {
			if (!toolCall.thoughtSignature) return [];
			try {
				return [JSON.parse(toolCall.thoughtSignature) as unknown];
			} catch {
				return [];
			}
		});
		if (reasoningDetails.length > 0) {
			assistant.reasoning_details = reasoningDetails;
		}
	}

	if (compat.requiresReasoningContentOnAssistantMessages && assistant.reasoning_content === undefined) {
		assistant.reasoning_content = "";
	}

	const hasContent =
		assistant.content !== null &&
		assistant.content !== undefined &&
		(typeof assistant.content === "string" ? assistant.content.length > 0 : assistant.content.length > 0);
	if (!hasContent && !assistant.tool_calls) return undefined;
	return assistant;
}

function appendToolResults(
	model: Model<Api>,
	sourceMessages: Message[],
	startIndex: number,
	targetMessages: ChatMessage[],
	compat: ResolvedCompat,
): number {
	const imageBlocks: ChatContentPart[] = [];
	let index = startIndex;

	for (; index < sourceMessages.length && sourceMessages[index].role === "toolResult"; index++) {
		const toolMsg = sourceMessages[index] as ToolResultMessage;
		const textResult = toolMsg.content
			.filter(isTextContentBlock)
			.map((block) => block.text)
			.join("\n");
		const hasImages = toolMsg.content.some(isImageContentBlock);
		const toolResult: ChatMessage = {
			role: "tool",
			content: sanitizeText(textResult.length > 0 ? textResult : "(see attached image)"),
			tool_call_id: toolMsg.toolCallId,
		};
		if (compat.requiresToolResultName && toolMsg.toolName) {
			toolResult.name = toolMsg.toolName;
		}
		targetMessages.push(toolResult);

		if (hasImages && model.input.includes("image")) {
			for (const block of toolMsg.content) {
				if (isImageContentBlock(block)) {
					imageBlocks.push({
						type: "image_url",
						image_url: {
							url: `data:${block.mimeType};base64,${block.data}`,
						},
					});
				}
			}
		}
	}

	if (imageBlocks.length > 0) {
		if (compat.requiresAssistantAfterToolResult) {
			targetMessages.push({ role: "assistant", content: "I have processed the tool results." });
		}
		targetMessages.push({
			role: "user",
			content: [{ type: "text", text: "Attached image(s) from tool result:" }, ...imageBlocks],
		});
	}

	return index - 1;
}

function convertTools(tools: Tool[], compat: ResolvedCompat): ChatTool[] {
	return tools.map((tool) => ({
		type: "function",
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
			...(compat.supportsStrictMode ? { strict: false as const } : {}),
		},
	}));
}

function applyReasoningOptions(
	payload: ChatCompletionRequest,
	model: Model<Api>,
	options: SimpleStreamOptions | undefined,
	compat: ResolvedCompat,
): void {
	if (!model.reasoning) return;

	const requested = options?.reasoning;
	const mapped = requested ? mapThinkingLevel(model, requested) : undefined;

	if (compat.thinkingFormat === "deepseek") {
		payload.thinking = { type: mapped ? "enabled" : "disabled" };
		if (mapped) payload.reasoning_effort = mapped;
	} else if (compat.thinkingFormat === "openrouter") {
		payload.reasoning = mapped ? { effort: mapped } : { effort: model.thinkingLevelMap?.off ?? "none" };
	} else if (compat.thinkingFormat === "zai" || compat.thinkingFormat === "qwen") {
		payload.enable_thinking = !!mapped;
	} else if (compat.thinkingFormat === "chat-template") {
		const kwargs = resolveChatTemplateKwargs(model, requested, compat);
		if (Object.keys(kwargs).length > 0) payload.chat_template_kwargs = kwargs;
	} else if (compat.thinkingFormat === "qwen-chat-template") {
		payload.chat_template_kwargs = {
			enable_thinking: !!mapped,
			preserve_thinking: true,
		};
	} else if (mapped && compat.supportsReasoningEffort) {
		payload.reasoning_effort = mapped;
	} else if (!mapped && compat.supportsReasoningEffort && typeof model.thinkingLevelMap?.off === "string") {
		payload.reasoning_effort = model.thinkingLevelMap.off;
	}
}

function resolveChatTemplateKwargs(
	model: Model<Api>,
	requested: SimpleStreamOptions["reasoning"],
	compat: ResolvedCompat,
): Record<string, string | number | boolean | null> {
	const kwargs: Record<string, string | number | boolean | null> = {};
	const mapped = requested ? mapThinkingLevel(model, requested) : model.thinkingLevelMap?.off;
	for (const [key, value] of Object.entries(compat.chatTemplateKwargs)) {
		if (typeof value !== "object" || value === null) {
			kwargs[key] = value;
			continue;
		}
		if (!requested && value.omitWhenOff) continue;
		if (value.$var === "thinking.enabled") {
			kwargs[key] = requested !== undefined && mapped !== null;
			continue;
		}
		if (value.$var === "thinking.effort") {
			if (typeof mapped === "string") kwargs[key] = mapped;
			continue;
		}
		if (mapped !== undefined && mapped !== null) kwargs[key] = mapped;
	}
	return kwargs;
}

function hasToolHistory(messages: Message[]): boolean {
	return messages.some(
		(msg) => msg.role === "toolResult" || (msg.role === "assistant" && msg.content.some(isToolCallBlock)),
	);
}

function readToolChoice(options: SimpleStreamOptions | undefined): unknown {
	if (!options || !("toolChoice" in options)) return undefined;
	return (options as SimpleStreamOptions & { toolChoice?: unknown }).toolChoice;
}

function isTextContentBlock(block: { type: string }): block is TextContent {
	return block.type === "text";
}

function isThinkingContentBlock(block: { type: string }): block is ThinkingContent {
	return block.type === "thinking";
}

function isToolCallBlock(block: { type: string }): block is ToolCall {
	return block.type === "toolCall";
}

function isImageContentBlock(block: { type: string }): block is ImageContent {
	return block.type === "image";
}

function sanitizeText(text: string): string {
	return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD");
}
