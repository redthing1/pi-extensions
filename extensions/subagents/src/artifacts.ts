import { appendFileSync, closeSync, mkdirSync, openSync, rmSync, writeFileSync } from "node:fs";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { join, resolve } from "node:path";
import type {
	BatchArtifacts,
	BatchView,
	ChildExecutionResult,
	ChildView,
	PreparedCommission,
	RunArtifacts,
} from "./types.ts";

const MAX_ARTIFACT_SEGMENT_LENGTH = 80;

export function createBatchArtifacts(input: {
	batchId: string;
	label: string;
	persistent: boolean;
	createdAt: number;
}): BatchArtifacts {
	if (!input.persistent) return { persistent: false };
	const date = new Date(input.createdAt);
	const runDir = join(
		resolve(getAgentDir(), "runs", "subagents"),
		dateSegment(date),
		`${timestampSegment(date)}-${safeSegment(input.label)}-${shortId(input.batchId)}`,
	);
	const childrenDir = join(runDir, "children");
	mkdirSync(childrenDir, { recursive: true, mode: 0o700 });
	return {
		persistent: true,
		runDir,
		childrenDir,
		inputPath: join(runDir, "input.md"),
		outputPath: join(runDir, "output.md"),
		metaPath: join(runDir, "meta.json"),
		statusPath: join(runDir, "status.json"),
	};
}

export function createChildArtifacts(batch: BatchArtifacts, prepared: PreparedCommission): RunArtifacts {
	if (!batch.persistent || !batch.childrenDir) return { persistent: false };
	const runDir = join(
		batch.childrenDir,
		`${String(prepared.spec.index).padStart(2, "0")}-${safeSegment(prepared.spec.label)}-${shortId(prepared.spec.id)}`,
	);
	mkdirSync(runDir, { recursive: true, mode: 0o700 });
	const eventsPath = join(runDir, "events.jsonl");
	closeSync(openSync(eventsPath, "a", 0o600));
	return {
		persistent: true,
		runDir,
		inputPath: join(runDir, "input.md"),
		outputPath: join(runDir, "output.md"),
		eventsPath,
		metaPath: join(runDir, "meta.json"),
		statusPath: join(runDir, "status.json"),
	};
}

export function removeBatchArtifacts(artifacts: BatchArtifacts | undefined): void {
	if (artifacts?.runDir) rmSync(artifacts.runDir, { recursive: true, force: true });
}

export function writeBatchInput(artifacts: BatchArtifacts, prepared: readonly PreparedCommission[]): void {
	if (!artifacts.inputPath) return;
	writeFileSync(
		artifacts.inputPath,
		[
			"# Subagent Batch",
			"",
			...prepared.flatMap((entry) => [`## ${entry.spec.index + 1}. ${entry.spec.label}`, "", entry.spec.task, ""]),
		].join("\n"),
		{ encoding: "utf8", mode: 0o600 },
	);
}

export function writeChildInput(artifacts: RunArtifacts, prepared: PreparedCommission): void {
	if (!artifacts.inputPath) return;
	const spec = prepared.spec;
	writeFileSync(
		artifacts.inputPath,
		[
			"# Subagent Commission",
			"",
			`Label: ${spec.label}`,
			`Model: ${spec.model}`,
			`Cwd: ${spec.cwd}`,
			`Tools: ${spec.tools.join(", ") || "(none)"}`,
			`Capabilities: ${spec.capabilities.join(", ") || "(none)"}`,
			`Launch contributors: ${prepared.contributions.map((entry) => entry.id).join(", ") || "(none)"}`,
			"",
			"## Task",
			"",
			spec.task,
		].join("\n"),
		{ encoding: "utf8", mode: 0o600 },
	);
}

export function appendChildEvent(artifacts: RunArtifacts, line: string): void {
	if (artifacts.eventsPath) appendFileSync(artifacts.eventsPath, `${line}\n`, "utf8");
}

export function writeChildStatus(artifacts: RunArtifacts, view: ChildView): void {
	const toolCalls = view.toolCalls ?? [];
	writeJson(artifacts.statusPath, {
		id: view.id,
		batchId: view.batchId,
		state: view.state,
		createdAt: view.createdAt,
		startedAt: view.startedAt,
		finishedAt: view.finishedAt,
		progress: view.progress,
		usage: view.usage,
		toolActivity: {
			total: toolCalls.length,
			active: toolCalls.filter((tool) => tool.status === "running"),
			latest: toolCalls.at(-1),
		},
	});
}

export function finishChildArtifacts(
	artifacts: RunArtifacts,
	view: ChildView,
	result: ChildExecutionResult,
	contributions: PreparedCommission["contributions"],
): void {
	if (artifacts.outputPath) {
		writeFileSync(artifacts.outputPath, completeOutput(result), {
			encoding: "utf8",
			mode: 0o600,
		});
	}
	writeChildStatus(artifacts, view);
	writeJson(artifacts.metaPath, {
		id: view.id,
		batchId: view.batchId,
		label: view.label,
		model: view.model,
		modelSource: view.modelSource,
		provider: view.provider,
		cwd: view.cwd,
		tools: view.tools,
		capabilities: view.capabilities,
		state: view.state,
		outcome: result.outcome,
		exitCode: result.exitCode,
		exitSignal: result.exitSignal,
		error: result.error,
		stderr: result.stderr,
		reportedModel: result.model,
		usage: result.usage,
		toolCalls: result.toolCalls,
		contributors: contributions.map((entry) => ({
			id: entry.id,
			metadata: entry.metadata,
		})),
		createdAt: view.createdAt,
		startedAt: view.startedAt,
		finishedAt: view.finishedAt,
	});
}

export function finishBatchArtifacts(artifacts: BatchArtifacts, view: BatchView, output: string): void {
	if (artifacts.outputPath) {
		writeFileSync(artifacts.outputPath, output, {
			encoding: "utf8",
			mode: 0o600,
		});
	}
	writeJson(artifacts.statusPath, {
		id: view.id,
		state: view.state,
		createdAt: view.createdAt,
		finishedAt: view.finishedAt,
		children: view.children.map((child) => ({
			id: child.id,
			state: child.state,
		})),
	});
	writeJson(artifacts.metaPath, {
		id: view.id,
		background: view.background,
		state: view.state,
		createdAt: view.createdAt,
		finishedAt: view.finishedAt,
		children: view.children.map((child) => ({
			id: child.id,
			label: child.label,
			state: child.state,
			runDir: child.runDir,
			outputPath: child.outputPath,
		})),
	});
}

export function completeOutput(result: ChildExecutionResult): string {
	const sections: string[] = [];
	if (result.output) sections.push(result.output);
	if (result.error) sections.push(result.error);
	if (result.stderr && result.stderr.trim() !== result.error?.trim()) {
		sections.push(`Child stderr:\n${result.stderr}`);
	}
	return sections.join("\n\n") || "(no output)";
}

function writeJson(path: string | undefined, value: unknown): void {
	if (!path) return;
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, {
		encoding: "utf8",
		mode: 0o600,
	});
}

function safeSegment(value: string): string {
	const normalized =
		value
			.trim()
			.replace(/[^a-zA-Z0-9_.-]+/gu, "-")
			.replace(/^-+|-+$/gu, "") || "run";
	return normalized.slice(0, MAX_ARTIFACT_SEGMENT_LENGTH);
}

function shortId(value: string): string {
	return value.replace(/^[^-]+-/u, "").slice(0, 8);
}

function dateSegment(date: Date): string {
	return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

function timestampSegment(date: Date): string {
	return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

function pad(value: number): string {
	return String(value).padStart(2, "0");
}
