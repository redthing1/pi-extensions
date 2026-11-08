import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { type ExtensionContext, getMarkdownTheme, type MessageRenderOptions } from "@earendil-works/pi-coding-agent";
import { Box, type Component, Container, Markdown, Spacer, Text, TruncatedText } from "@earendil-works/pi-tui";
import type {
	BatchView,
	ChildPresentation,
	ChildState,
	ChildToolCall,
	ChildUsage,
	ChildView,
	RunTargetView,
	SubagentToolDetails,
	SubagentUpdate,
} from "./types.ts";

type Theme = ExtensionContext["ui"]["theme"];

const COMPACT_CHILD_LIMIT = 6;

export function renderSubagentCall(
	args: { tasks?: readonly { label?: string; task?: string }[]; background?: boolean },
	theme: Theme,
): Component {
	const commissions = args.tasks ?? [];
	const count = commissions.length > 1 ? ` ×${commissions.length}` : "";
	const background = args.background ? " background" : "";
	const labels = commissions.map(commissionLabel);
	const shown = labels.slice(0, 3);
	const more = labels.length > shown.length ? ` +${labels.length - shown.length}` : "";
	const description = shown.length > 0 ? ` ${theme.fg("dim", `${shown.join(" · ")}${more}`)}` : "";
	return new TruncatedText(
		`${theme.fg("toolTitle", theme.bold("subagent"))}${theme.fg("accent", `${count}${background}`)}${description}`,
	);
}

export function renderLifecycleCall(
	name: string,
	args: { ids?: readonly string[]; timeoutSeconds?: number | null },
	theme: Theme,
): Component {
	const label = name.replace("subagent_", "subagent ");
	const duration =
		name === "subagent_wait"
			? theme.fg("dim", ` · ${args.timeoutSeconds === null ? "unbounded" : `${args.timeoutSeconds ?? 30}s`}`)
			: "";
	const ids = args.ids ?? [];
	const shown = ids.slice(0, 2).map(displayId);
	const more = ids.length > shown.length ? ` +${ids.length - shown.length}` : "";
	const targets = shown.length > 0 ? ` ${theme.fg("dim", `${shown.join(" · ")}${more}`)}` : "";
	return new TruncatedText(`${theme.fg("toolTitle", theme.bold(label))}${duration}${targets}`);
}

export function renderSubagentSendCall(
	args: { id?: string; label?: string; message?: string },
	expanded: boolean,
	theme: Theme,
): Component {
	const container = new Container();
	const heading = `${theme.fg("toolTitle", theme.bold("subagent →"))} ${childIdentity(args, theme)}`;
	container.addChild(expanded ? new Text(heading, 0, 0) : new TruncatedText(heading));
	container.addChild(messagePreview(args.message ?? "", expanded, theme));
	if (expanded && args.id) container.addChild(new Text(theme.fg("dim", `  ${args.id}`), 0, 0));
	return container;
}

export function renderSubagentSendResult(
	result: AgentToolResult<SubagentToolDetails>,
	expanded: boolean,
	theme: Theme,
): Component {
	const text = result.content.find((entry) => entry.type === "text")?.text ?? "";
	if (result.details?.error) return messagePreview(theme.fg("error", text), expanded, theme);
	return new Text(
		theme.fg("dim", text.startsWith("Queued") ? "Queued until startup" : "Accepted for processing"),
		2,
		0,
	);
}

function messagePreview(value: string, expanded: boolean, theme: Theme, padding = 2): Component {
	const message = new Text(value, padding, 0);
	return {
		invalidate() {
			message.invalidate();
		},
		render(width) {
			const lines = message.render(width);
			return [
				...(expanded ? lines : lines.slice(0, 3)),
				...(!expanded && lines.length > 3
					? new Text(theme.fg("muted", "  … Ctrl+O full message"), 0, 0).render(width)
					: []),
			];
		},
	};
}

export function renderSubagentUpdates(
	message: { details?: readonly SubagentUpdate[] },
	options: MessageRenderOptions,
	theme: Theme,
): Component | undefined {
	if (!message.details) return undefined;
	const box = new Box(options.outputPad, 1, (text) => theme.bg("customMessageBg", text));
	let shown = 0;
	let total = 0;
	let hiddenFailures = 0;
	for (const update of message.details) {
		total += update.messages.length + (update.state ? 1 : 0);
		const remaining = options.expanded ? Infinity : COMPACT_CHILD_LIMIT - shown;
		if (remaining <= 0) {
			if (update.state === "failed") hiddenFailures += 1;
			continue;
		}
		const messages = update.messages.slice(0, remaining);
		const completion = update.state && messages.length < remaining ? update.state : undefined;
		if (update.state === "failed" && !completion) hiddenFailures += 1;
		if (!messages.length && !completion) continue;
		const status = completion === "completed" ? "result ready" : `${completion} · result ready`;
		if (shown) box.addChild(new Spacer(1));
		const heading = `${messages.length ? theme.fg("accent", "←") : stateGlyph(completion!, theme)} ${childIdentity(update, theme)}${!messages.length && completion ? theme.fg("dim", ` · ${status}`) : ""}`;
		box.addChild(options.expanded ? new Text(heading, 0, 0) : new TruncatedText(heading));
		for (const [index, text] of messages.entries()) {
			if (index) box.addChild(new Spacer(1));
			box.addChild(messagePreview(text, options.expanded, theme));
			shown += 1;
		}
		if (completion) {
			if (messages.length) box.addChild(new Text(`${stateGlyph(completion, theme)} ${status}`, 2, 0));
			shown += 1;
			if (update.error) box.addChild(messagePreview(theme.fg("error", update.error), options.expanded, theme));
		}
		if (options.expanded) box.addChild(new Text(theme.fg("dim", update.id), 2, 0));
	}
	if (shown < total)
		box.addChild(
			new Text(
				theme.fg(
					"muted",
					`… ${total - shown} more updates${hiddenFailures ? ` · ${hiddenFailures} failed` : ""} · Ctrl+O details`,
				),
				0,
				0,
			),
		);
	return box;
}

function childIdentity(child: { id?: string; label?: string }, theme: Theme): string {
	const id = child.id ? displayId(child.id) : "";
	return `${theme.fg("accent", child.label || id)}${child.label && id ? theme.fg("dim", ` · ${id}`) : ""}`;
}

export function renderSubagentResult(
	result: AgentToolResult<SubagentToolDetails>,
	expanded: boolean,
	theme: Theme,
): Component {
	const details = result.details;
	const text = result.content.find((entry) => entry.type === "text")?.text ?? "";
	if (!details) return new Text(text || "(no output)", 0, 0);
	if (details.operation === "send") return renderSubagentSendResult(result, expanded, theme);
	if (details.operation === "list") return renderList(details, text, expanded, theme);
	if (details.operation === "cancel") return renderCancellation(details, text, expanded, theme);
	return renderRuns(details, text, expanded, theme);
}

function renderRuns(details: SubagentToolDetails, text: string, expanded: boolean, theme: Theme): Component {
	const container = new Container();
	const children = uniqueChildren(details.targets);
	const presentations = presentationMap(details.presentations);
	const state = details.error ? "failed" : aggregateState(details.targets);
	const backgroundStart =
		!details.error &&
		details.operation === "start" &&
		details.targets.some((target) => target.kind === "batch" && target.background);
	container.addChild(
		new TruncatedText(
			details.timedOut
				? theme.fg("toolTitle", theme.bold("Wait ended · no results collected"))
				: backgroundStart
					? theme.fg("toolTitle", theme.bold("Started in background"))
					: `${stateGlyph(state, theme)} ${children.length === 1 ? childIdentity(children[0], theme) + theme.fg("dim", ` · ${state}`) : theme.fg("toolTitle", theme.bold(aggregateLabel(children, state)))}${statsSuffix(details.targets, children, presentations, theme)}`,
		),
	);

	if (details.error) {
		container.addChild(new Text(`  ${theme.fg("error", details.error)}`, 0, 0));
		return container;
	}
	if (details.offset) {
		container.addChild(new Markdown(expanded ? text : previewLines(text, 6), 0, 0, getMarkdownTheme()));
		if (!expanded) container.addChild(new Text(theme.fg("muted", "Ctrl+O details"), 0, 0));
		return container;
	}

	if (expanded) {
		for (const child of children) renderExpandedChild(container, child, presentations.get(child.id), theme);
		if (requiresInlineFullOutput(children, presentations) && text.trim()) {
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("muted", "Returned output"), 0, 0));
			container.addChild(new Markdown(text.trim(), 0, 0, getMarkdownTheme()));
		}
		return container;
	}

	const visible = children.slice(0, COMPACT_CHILD_LIMIT);
	const showRows =
		children.length > 1 || state === "running" || state === "queued" || state === "failed" || state === "cancelled";
	if (showRows) {
		for (const child of visible)
			renderCompactChild(container, child, presentations.get(child.id), theme, settled(state));
		if (children.length > visible.length) {
			container.addChild(new Text(theme.fg("dim", `  … ${children.length - visible.length} more`), 0, 0));
		}
	} else {
		const presentation = presentations.get(children[0]?.id ?? "");
		if (presentation?.preview) {
			container.addChild(new Spacer(1));
			container.addChild(new Markdown(previewLines(presentation.preview, 6), 0, 0, getMarkdownTheme()));
		}
	}

	if (hasHiddenDetails(children, details.presentations, visible.length, expanded)) {
		container.addChild(new Text(theme.fg("muted", "Ctrl+O details"), 0, 0));
	}
	return container;
}

function renderList(details: SubagentToolDetails, text: string, expanded: boolean, theme: Theme): Component {
	const container = new Container();
	const children = uniqueChildren(details.targets);
	container.addChild(
		new TruncatedText(
			theme.fg(
				"toolTitle",
				theme.bold(
					details.error
						? "List failed"
						: children.length
							? children.length + (children.length === 1 ? " child" : " children")
							: "No outstanding subagents",
				),
			),
		),
	);
	if (details.error) {
		container.addChild(new Text(theme.fg("error", text), 0, 0));
		return container;
	}
	const presentations = presentationMap(details.presentations);
	const visible = expanded ? children : children.slice(0, COMPACT_CHILD_LIMIT);
	for (const child of visible) {
		if (expanded) renderExpandedChild(container, child, presentations.get(child.id), theme);
		else renderCompactChild(container, child, presentations.get(child.id), theme, false);
	}
	if (children.length > visible.length)
		container.addChild(new Text(theme.fg("dim", `… ${children.length - visible.length} more children`), 0, 0));
	if (details.omittedChildren)
		container.addChild(new Text(theme.fg("dim", `${details.omittedChildren} collected · retained in history`), 0, 0));
	if (details.moreChildren)
		container.addChild(new Text(theme.fg("muted", "More children available through list continuation"), 0, 0));
	if (!expanded && children.length) container.addChild(new Text(theme.fg("muted", "Ctrl+O details"), 0, 0));
	return container;
}

function renderCancellation(details: SubagentToolDetails, text: string, expanded: boolean, theme: Theme): Component {
	const container = new Container();
	const children = uniqueChildren(details.targets);
	const presentations = presentationMap(details.presentations);
	const state = details.error ? "failed" : aggregateState(details.targets);
	container.addChild(
		new TruncatedText(
			`${stateGlyph(state, theme)} ${theme.fg("toolTitle", theme.bold(aggregateLabel(children, state)))}${statsSuffix(details.targets, children, presentations, theme)}`,
		),
	);
	if (details.error) {
		container.addChild(new Text(`  ${theme.fg("error", details.error)}`, 0, 0));
		return container;
	}
	for (const child of children) {
		if (expanded) renderExpandedChild(container, child, presentations.get(child.id), theme);
		else renderCompactChild(container, child, presentations.get(child.id), theme, true);
	}
	if (expanded && requiresInlineFullOutput(children, presentations) && text.trim()) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("muted", "Returned output"), 0, 0));
		container.addChild(new Markdown(text.trim(), 0, 0, getMarkdownTheme()));
	}
	if (!expanded && hasHiddenDetails(children, details.presentations, children.length, false)) {
		container.addChild(new Text(theme.fg("muted", "Ctrl+O details"), 0, 0));
	}
	return container;
}

function renderCompactChild(
	container: Container,
	child: ChildView,
	presentation: ChildPresentation | undefined,
	theme: Theme,
	showPreview: boolean,
): void {
	container.addChild(
		new TruncatedText(
			`  ${stateGlyph(child.state, theme)} ${childIdentity(child, theme)}${child.finishedAt !== undefined ? theme.fg("dim", child.collected ? " · collected" : " · result ready") : ""}${childStats(child, presentation, theme)}`,
		),
	);
	const activity = childActivity(child, presentation);
	if (activity) container.addChild(new TruncatedText(`    ${theme.fg("dim", activity)}`));
	if (
		presentation?.error &&
		(!showPreview || !presentation.preview?.includes(presentation.error) || child.state === "failed")
	)
		container.addChild(new TruncatedText(`    ${theme.fg("error", firstLine(presentation.error))}`));
	const latestMessage = presentation?.messages?.at(-1);
	if (latestMessage)
		container.addChild(
			new TruncatedText(
				`    ${theme.fg("muted", latestMessage.direction === "parent" ? "→" : "←")} ${firstLine(latestMessage.text)}`,
			),
		);
	if (showPreview && presentation?.preview && !(child.state === "failed" && presentation.error)) {
		container.addChild(new Markdown(previewLines(presentation.preview, 2), 4, 0, getMarkdownTheme()));
	}
}

export function renderExpandedChild(
	container: Container,
	child: ChildView,
	presentation: ChildPresentation | undefined,
	theme: Theme,
): void {
	container.addChild(new Spacer(1));
	container.addChild(
		new Text(
			`${stateGlyph(child.state, theme)} ${childIdentity(child, theme)}${theme.fg("dim", ` · ${child.state}${child.finishedAt !== undefined ? (child.collected ? " · collected" : " · result ready") : ""}`)}`,
			0,
			0,
		),
	);
	const stats = childStats(child, presentation, theme, true).trim();
	if (stats) container.addChild(new Text(stats, 2, 0));
	container.addChild(new Text(theme.fg("dim", child.task), 2, 0));
	renderChildContext(container, child, theme);
	if (presentation?.error && !presentation.preview?.includes(presentation.error))
		container.addChild(new Text(theme.fg("error", presentation.error), 2, 0));
	if (presentation && presentation.toolCalls.length > 0) renderToolLog(container, child, presentation, theme);
	if (presentation?.latestText) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("muted", "Latest assistant text"), 2, 0));
		container.addChild(new Text(presentation.latestText, 2, 0));
	}
	if (presentation?.messages?.length) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("muted", "Messages"), 2, 0));
		for (const message of presentation.messages) {
			container.addChild(
				new Text(
					theme.fg(
						message.error ? "error" : "muted",
						`${message.direction === "parent" ? "→ To child" : "← From child"} · ${message.error ? "not accepted" : message.delivered ? (message.direction === "parent" ? "accepted for processing" : "announced") : message.direction === "parent" ? "queued" : "notification pending"}`,
					),
					2,
					0,
				),
			);
			container.addChild(new Text(message.text, 4, 0));
			if (message.error) container.addChild(new Text(theme.fg("error", message.error), 4, 0));
		}
		const earlier = presentation.messageOffset ?? 0;
		const later = (presentation.totalMessages ?? 0) - earlier - presentation.messages.length;
		if (earlier || later)
			container.addChild(
				new Text(theme.fg("dim", `${earlier} earlier · ${later} later messages available through inspection`), 2, 0),
			);
	}
	if (presentation?.preview) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("muted", child.state === "completed" ? "Result" : "Partial result"), 2, 0));
		container.addChild(new Markdown(presentation.preview, 2, 0, getMarkdownTheme()));
	}
}

function renderChildContext(container: Container, child: ChildView, theme: Theme, padding = 2): void {
	const prefix = " ".repeat(padding);
	container.addChild(new Text(theme.fg("dim", child.model), padding, 0));
	container.addChild(new Text(theme.fg("dim", child.cwd), padding, 0));
	container.addChild(new Text(theme.fg("dim", `tools: ${child.tools.join(", ") || "none"}`), padding, 0));
	container.addChild(new Text(theme.fg("dim", child.id), padding, 0));
	if (child.outputPath)
		container.addChild(new TruncatedText(`${prefix}${theme.fg("dim", `output: ${child.outputPath}`)}`));
	else if (child.runDir) container.addChild(new TruncatedText(`${prefix}${theme.fg("dim", `run: ${child.runDir}`)}`));
}

function renderToolLog(container: Container, child: ChildView, presentation: ChildPresentation, theme: Theme): void {
	container.addChild(new Spacer(1));
	container.addChild(new Text(theme.fg("muted", `Tool calls · ${toolCallCount(presentation)}`), 2, 0));
	for (let index = 0; index < presentation.toolCalls.length; index += 1) {
		if (presentation.omittedToolCalls > 0 && index === presentation.toolCallHeadCount) {
			container.addChild(new Text(theme.fg("dim", `… ${presentation.omittedToolCalls} calls omitted`), 4, 0));
		}
		const tool = presentation.toolCalls[index];
		if (!tool) continue;
		const duration = toolDuration(tool);
		const details = [tool.preview, duration ? `· ${duration}` : undefined]
			.filter((value): value is string => Boolean(value))
			.join(" ");
		container.addChild(
			new TruncatedText(
				`    ${toolGlyph(tool, theme)} ${theme.fg("accent", tool.name)}${details ? ` ${theme.fg("dim", details)}` : ""}`,
			),
		);
		if (tool.error) container.addChild(new Text(theme.fg("error", tool.error), 6, 0));
	}
	if (presentation.omittedToolCalls > 0 && child.eventsPath) {
		container.addChild(new TruncatedText(`    ${theme.fg("dim", `full log: ${child.eventsPath}`)}`));
	}
}

function statsSuffix(
	targets: readonly RunTargetView[],
	children: readonly ChildView[],
	presentations: Map<string, ChildPresentation>,
	theme: Theme,
): string {
	if (children.length === 0) return "";
	const parts: string[] = [];
	const duration = targetsDuration(targets);
	if (duration > 0) parts.push(formatDuration(duration));
	const toolCount = children.reduce((sum, child) => sum + toolCallCount(presentations.get(child.id)), 0);
	if (toolCount > 0) parts.push(`${toolCount} tool${toolCount === 1 ? "" : "s"}`);
	const usage = sumUsage(children.map((child) => presentations.get(child.id)?.usage));
	const usageText = formatUsage(usage);
	if (usageText) parts.push(usageText);
	if (children.length === 1) {
		const context = contextStats(children[0]);
		if (context) parts.push(context);
	}
	return parts.length > 0 ? ` ${theme.fg("dim", `· ${parts.join(" · ")}`)}` : "";
}

function aggregateLabel(children: readonly ChildView[], state: ChildState): string {
	if (children.length === 0) return state;
	return formatCounts(stateCounts(children));
}

function toolCallCount(presentation: ChildPresentation | undefined): number {
	return presentation?.totalToolCalls ?? 0;
}

function toolGlyph(tool: ChildToolCall, theme: Theme): string {
	if (tool.status === "running") return theme.fg("accent", "◦");
	if (tool.status === "completed") return theme.fg("success", "✓");
	if (tool.status === "failed") return theme.fg("error", "✗");
	return theme.fg("muted", "–");
}

function toolDuration(tool: ChildToolCall): string | undefined {
	const end = tool.finishedAt ?? (tool.status === "running" ? Date.now() : undefined);
	if (end === undefined) return undefined;
	return formatDuration(Math.max(0, end - tool.startedAt));
}

function childStats(
	child: ChildView,
	presentation: ChildPresentation | undefined,
	theme: Theme,
	expanded = false,
): string {
	const parts: string[] = [];
	const duration = childDuration(child);
	if (duration > 0) parts.push(formatDuration(duration));
	const toolCount = toolCallCount(presentation);
	if (toolCount > 0) parts.push(`${toolCount} tool${toolCount === 1 ? "" : "s"}`);
	const usage = presentation?.usage ? formatUsage(presentation.usage) : "";
	if (usage) parts.push(usage);
	const context = contextStats(child, expanded);
	if (context) parts.push(context);
	return parts.length > 0 ? ` ${theme.fg("dim", `· ${parts.join(" · ")}`)}` : "";
}

function contextStats(child: ChildView, expanded = false): string {
	const tokens = child.progress?.contextTokens;
	const window = child.contextWindow ?? 0;
	if (tokens === undefined && window <= 0) return "";
	return `${expanded ? "context (last response)" : "ctx"} ${tokens === undefined ? "?" : formatTokens(tokens)}${window > 0 ? `/${formatTokens(window)}` : ""}`;
}

function batchStats(batch: BatchView, presentations: Map<string, ChildPresentation>, theme: Theme): string {
	const parts = [formatCounts(stateCounts(batch.children))];
	const duration = batchDuration(batch);
	if (duration > 0) parts.push(formatDuration(duration));
	const toolCount = batch.children.reduce((sum, child) => sum + toolCallCount(presentations.get(child.id)), 0);
	if (toolCount > 0) parts.push(`${toolCount} tool${toolCount === 1 ? "" : "s"}`);
	const usage = sumUsage(batch.children.map((child) => presentations.get(child.id)?.usage));
	const usageText = formatUsage(usage);
	if (usageText) parts.push(usageText);
	return ` ${theme.fg("dim", `· ${parts.join(" · ")}`)}`;
}

function childActivity(child: ChildView, presentation: ChildPresentation | undefined): string | undefined {
	if (child.state !== "running") return undefined;
	const active = presentation?.toolCalls.filter((tool) => tool.status === "running") ?? [];
	const current = active.at(-1);
	if (!current) return child.activity || "waiting for model output";
	const more = active.length > 1 ? ` · +${active.length - 1} active` : "";
	return `${current.name}${current.preview ? ` ${current.preview}` : ""}${more}`;
}

function hasHiddenDetails(
	children: readonly ChildView[],
	presentations: readonly ChildPresentation[],
	visibleChildren: number,
	expanded: boolean,
): boolean {
	if (expanded) return false;
	const visibleLines = children.length > 1 ? 2 : 6;
	return (
		children.length > visibleChildren ||
		presentations.some(
			(presentation) =>
				presentation.previewTruncated ||
				presentation.toolCalls.length > 0 ||
				(presentation.preview?.trim().split("\n").length ?? 0) > visibleLines,
		)
	);
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

function aggregateState(targets: readonly RunTargetView[]): ChildState {
	const states = targets.map((target) => target.state);
	if (states.includes("running")) return "running";
	if (states.includes("queued")) return "queued";
	if (states.includes("failed")) return "failed";
	if (states.includes("cancelled")) return "cancelled";
	return "completed";
}

export function stateGlyph(state: ChildState, theme: Theme): string {
	if (state === "running") return theme.fg("accent", "◦");
	if (state === "queued") return theme.fg("dim", "·");
	if (state === "completed") return theme.fg("success", "✓");
	if (state === "failed") return theme.fg("error", "✗");
	return theme.fg("muted", "–");
}

function stateCounts(children: readonly ChildView[]): Record<ChildState, number> {
	const counts: Record<ChildState, number> = { queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0 };
	for (const child of children) counts[child.state] += 1;
	return counts;
}

function formatCounts(counts: Record<ChildState, number>): string {
	return (["running", "queued", "completed", "failed", "cancelled"] as const)
		.filter((state) => counts[state] > 0)
		.map((state) => `${counts[state]} ${state}`)
		.join(" · ");
}

function presentationMap(presentations: readonly ChildPresentation[]): Map<string, ChildPresentation> {
	return new Map(presentations.map((presentation) => [presentation.id, presentation]));
}

function requiresInlineFullOutput(
	children: readonly ChildView[],
	presentations: Map<string, ChildPresentation>,
): boolean {
	return children.some((child) => presentations.get(child.id)?.previewTruncated && !child.outputPath);
}

function sumUsage(values: readonly (ChildUsage | undefined)[]): ChildUsage {
	const total: ChildUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	for (const usage of values) {
		if (!usage) continue;
		total.input += usage.input;
		total.output += usage.output;
		total.cacheRead += usage.cacheRead;
		total.cacheWrite += usage.cacheWrite;
	}
	return total;
}

function formatUsage(usage: ChildUsage): string {
	const parts: string[] = [];
	if (usage.input > 0) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output > 0) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead > 0) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite > 0) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	return parts.join(" ");
}

function formatTokens(value: number): string {
	if (value < 1_000) return String(value);
	if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`;
	return `${(value / 1_000_000).toFixed(1)}M`;
}

function targetsDuration(targets: readonly RunTargetView[]): number {
	if (targets.length === 0) return 0;
	return Math.max(
		...targets.map((target) => (target.kind === "batch" ? batchDuration(target) : childDuration(target))),
	);
}

function batchDuration(batch: BatchView): number {
	return Math.max(0, (batch.finishedAt ?? Date.now()) - batch.createdAt);
}

function childDuration(child: ChildView): number {
	if (child.progress) return child.progress.durationMs;
	if (child.finishedAt === undefined) return 0;
	return Math.max(0, child.finishedAt - (child.startedAt ?? child.createdAt));
}

function formatDuration(milliseconds: number): string {
	if (milliseconds < 1_000) return `${milliseconds}ms`;
	if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(1)}s`;
	return `${Math.floor(milliseconds / 60_000)}m ${Math.floor((milliseconds % 60_000) / 1_000)}s`;
}

function commissionLabel(commission: { label?: string; task?: string }): string {
	return commission.label?.trim() || firstLine(commission.task ?? "") || "subagent";
}

function firstLine(value: string): string {
	return value.trim().split("\n", 1)[0] ?? "";
}

function previewLines(value: string, count: number): string {
	return value
		.trim()
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.slice(0, count)
		.join("\n");
}

function displayId(id: string): string {
	const separator = id.indexOf("-");
	if (separator === -1) return id.slice(0, 12);
	return `${id.slice(0, separator)}-${id.slice(separator + 1, separator + 9)}`;
}

function settled(state: ChildState): boolean {
	return state === "completed" || state === "failed" || state === "cancelled";
}
