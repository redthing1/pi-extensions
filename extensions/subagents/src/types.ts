import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { WorkspaceChildOperations } from "../../shared/active-workspace.ts";
import type { ChildLaunchContribution, ChildRunIntent } from "../../shared/child-runtime.ts";
import type {
	ManagedChildOutcome,
	ManagedChildControl,
	ManagedChildProgress,
	ManagedChildResult,
	ManagedChildToolCall,
	ManagedChildUpdate,
	ManagedChildUsage,
} from "../../shared/managed-child.ts";
import type { ToolEffect } from "../../shared/tool-effects.ts";

export type ModelSource = "inherited" | "explicit";
export type ChildState = "queued" | "running" | "completed" | "failed" | "cancelled";
export type ChildOutcome = ManagedChildOutcome;

export interface SubagentConfig {
	readonly maxConcurrency: number;
}

export interface CommissionInput {
	label?: string;
	task: string;
	cwd?: string;
	model?: string;
	tools: readonly string[];
}

export interface ResolvedCommission {
	readonly id: string;
	readonly batchId: string;
	readonly toolCallId: string;
	readonly index: number;
	readonly label: string;
	readonly task: string;
	readonly cwd: string;
	readonly provider: string;
	readonly modelId: string;
	readonly model: string;
	readonly contextWindow?: number;
	readonly modelSource: ModelSource;
	readonly thinkingLevel?: ThinkingLevel;
	readonly tools: readonly string[];
	readonly extensionTools: readonly string[];
	readonly capabilities: readonly ToolEffect[];
	readonly privacy: Readonly<{
		clientZdr: boolean;
		remoteZdr: boolean;
	}>;
}

export interface PreparedCommission {
	readonly spec: ResolvedCommission;
	readonly intent: ChildRunIntent;
	readonly contributions: readonly ChildLaunchContribution[];
	readonly workspaceChildren?: WorkspaceChildOperations;
}

export interface RunArtifacts {
	persistent: boolean;
	runDir?: string;
	inputPath?: string;
	outputPath?: string;
	eventsPath?: string;
	metaPath?: string;
	statusPath?: string;
}

export interface BatchArtifacts extends RunArtifacts {
	childrenDir?: string;
}

export type ChildUsage = ManagedChildUsage;
export type ChildToolCall = ManagedChildToolCall;
export type ChildProgress = ManagedChildProgress;
export type ChildExecutionUpdate = ManagedChildUpdate;
export type ChildExecutionResult = ManagedChildResult;

export interface ChildView {
	kind: "child";
	id: string;
	batchId: string;
	index: number;
	label: string;
	state: ChildState;
	task: string;
	cwd: string;
	provider: string;
	model: string;
	contextWindow?: number;
	modelSource: ModelSource;
	tools: readonly string[];
	capabilities: readonly ToolEffect[];
	runDir?: string;
	outputPath?: string;
	eventsPath?: string;
	createdAt: number;
	startedAt?: number;
	finishedAt?: number;
	result?: ChildExecutionResult;
	progress?: ChildProgress;
	activity?: string;
	usage?: ChildUsage;
	toolCalls?: readonly ChildToolCall[];
	totalToolCalls?: number;
	latestText?: string;
	collected?: boolean;
	messages?: readonly ChildMessage[];
}

export interface ChildMessage {
	readonly direction: "parent" | "child";
	readonly text: string;
	readonly createdAt: number;
	delivered: boolean;
	error?: string;
}

export interface BatchView {
	kind: "batch";
	id: string;
	background: boolean;
	state: ChildState;
	createdAt: number;
	finishedAt?: number;
	runDir?: string;
	outputPath?: string;
	error?: string;
	children: readonly ChildView[];
}

export type RunTargetView = BatchView | ChildView;

export interface ChildPresentation {
	readonly id: string;
	readonly preview?: string;
	readonly previewTruncated: boolean;
	readonly usage?: ChildUsage;
	readonly totalToolCalls: number;
	readonly toolCalls: readonly ChildToolCall[];
	readonly omittedToolCalls: number;
	readonly toolCallHeadCount: number;
	readonly latestText?: string;
	readonly messages?: readonly ChildMessage[];
	readonly messageOffset?: number;
	readonly totalMessages?: number;
	readonly error?: string;
}

export interface SubagentUpdate {
	readonly id: string;
	readonly label: string;
	readonly messages: readonly string[];
	readonly state?: ChildState;
	readonly error?: string;
}

export interface SubagentToolDetails {
	operation: "start" | "wait" | "list" | "cancel" | "send";
	targets: readonly RunTargetView[];
	presentations: readonly ChildPresentation[];
	error?: string;
	offset?: number;
	omittedChildren?: number;
	moreChildren?: boolean;
	recipientLabel?: string;
	timedOut?: boolean;
}

export interface ChildLaunchRequest {
	commission: ResolvedCommission;
	intent: ChildRunIntent;
	contributions: readonly ChildLaunchContribution[];
	workspaceChildren?: WorkspaceChildOperations;
	artifacts: RunArtifacts;
	systemPrompt: string;
	onControl?(control: ManagedChildControl): void;
	onMessage?(message: string): void;
}
