import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { type Static, Type } from "typebox";
import {
	type AgentToolResult,
	type AgentToolUpdateCallback,
	defineTool,
	type ExtensionAPI,
	type ExtensionContext,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { observeActiveWorkspace, type WorkspaceFileOperations, type WorkspaceObserver } from "../shared/active-workspace.ts";
import { publishChildToolProvider } from "../shared/child-runtime.ts";
import { publishToolEffectAnalyzer } from "../shared/tool-effects.ts";
import { APPLY_PATCH_EFFECTS, createApplyPatchEffectAnalyzer } from "./tool-effects.ts";

const APPLY_PATCH_TOOL = "apply_patch";
const GPT_MODEL_PATTERN = /(?:^|[/:\s_-])gpt(?:[-\d.]|$)/i;
const MAX_OPERATIONS = 100;
const MAX_TOTAL_DIFF_BYTES = 8 * 1024 * 1024;
const PATCH_PREVIEW_MAX_LINES = 16;
const PATCH_PREVIEW_MAX_CHARS = 4000;
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

const operationSchema = Type.Object(
	{
		type: Type.Union([Type.Literal("create_file"), Type.Literal("update_file"), Type.Literal("delete_file")]),
		path: Type.String({ description: "Path to patch (relative or absolute)" }),
		diff: Type.Optional(
			Type.String({
				description:
					"V4A diff. create_file uses full file content with every line prefixed by '+'. update_file uses @@ sections with '+', '-', and space-prefixed lines.",
			}),
		),
		move_path: Type.Optional(Type.String({ description: "Optional move target (relative or absolute)" })),
	},
	{ additionalProperties: false },
);

const applyPatchSchema = Type.Object(
	{
		operations: Type.Array(operationSchema, {
			minItems: 1,
			maxItems: MAX_OPERATIONS,
			description: "Patch operations to apply sequentially",
		}),
	},
	{ additionalProperties: false },
);

type ApplyPatchParams = Static<typeof applyPatchSchema>;
type ApplyPatchOperation = Static<typeof operationSchema>;
type ApplyPatchOpType = ApplyPatchOperation["type"];

type ApplyPatchResult = {
	type: ApplyPatchOpType;
	path: string;
	status: "completed" | "failed";
	output?: string;
};

type ApplyPatchDetails =
	| { stage: "progress"; message: string }
	| { stage: "done"; fuzz: number; results: ApplyPatchResult[] };

type ApplyPatchModel = {
	id?: string;
	name?: string;
};

class DiffError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DiffError";
	}
}

interface Chunk {
	origIndex: number;
	delLines: string[];
	insLines: string[];
}

function normalizeLineEndings(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function detectLineEnding(text: string): "\n" | "\r\n" {
	return text.includes("\r\n") ? "\r\n" : "\n";
}

function restoreLineEndings(text: string, lineEnding: "\n" | "\r\n"): string {
	return lineEnding === "\n" ? text : text.replace(/\n/g, "\r\n");
}

function normalizeUnicodeSpaces(value: string): string {
	return value.replace(UNICODE_SPACES, " ");
}

function normalizeAtPrefix(value: string): string {
	return value.startsWith("@") ? value.slice(1) : value;
}

function expandPath(value: string): string {
	const normalized = normalizeUnicodeSpaces(normalizeAtPrefix(value));
	if (normalized === "~") return os.homedir();
	if (normalized.startsWith("~/")) return os.homedir() + normalized.slice(1);
	return normalized;
}

function errorCode(err: unknown): string | undefined {
	return typeof err === "object" && err !== null && "code" in err
		? String((err as { code?: unknown }).code)
		: undefined;
}

function resolveToCwd(value: string, cwd: string): string {
	const expanded = expandPath(value);
	if (path.isAbsolute(expanded)) return expanded;
	return path.resolve(cwd, expanded);
}

async function pathExists(abs: string): Promise<boolean> {
	try {
		await fs.lstat(abs);
		return true;
	} catch (err) {
		if (errorCode(err) === "ENOENT") return false;
		throw err;
	}
}

function peekNextSection(
	lines: string[],
	startIndex: number,
): { context: string[]; chunks: Chunk[]; nextIndex: number; eof: boolean } {
	const old: string[] = [];
	let delLines: string[] = [];
	let insLines: string[] = [];
	const chunks: Chunk[] = [];

	let mode: "keep" | "add" | "delete" = "keep";
	const origIndex = startIndex;
	let index = startIndex;

	while (index < lines.length) {
		const rawLine = lines[index] ?? "";
		if (
			rawLine.startsWith("@@") ||
			rawLine.startsWith("*** End of File") ||
			rawLine.startsWith("*** End Patch") ||
			rawLine.startsWith("*** Update File:") ||
			rawLine.startsWith("*** Delete File:") ||
			rawLine.startsWith("*** Add File:")
		) {
			break;
		}
		if (rawLine === "***") break;
		if (rawLine.startsWith("***")) throw new DiffError(`Invalid line: ${rawLine}`);

		index++;
		const lastMode: "keep" | "add" | "delete" = mode;
		let line = rawLine === "" ? " " : rawLine;
		const prefix = line[0];
		if (prefix === "+") mode = "add";
		else if (prefix === "-") mode = "delete";
		else if (prefix === " ") mode = "keep";
		else throw new DiffError(`Invalid line: ${rawLine}`);

		line = line.slice(1);
		if (mode === "keep" && lastMode !== mode && (insLines.length > 0 || delLines.length > 0)) {
			chunks.push({ origIndex: old.length - delLines.length, delLines, insLines });
			delLines = [];
			insLines = [];
		}

		if (mode === "delete") {
			delLines.push(line);
			old.push(line);
		} else if (mode === "add") {
			insLines.push(line);
		} else {
			old.push(line);
		}
	}

	if (insLines.length > 0 || delLines.length > 0) {
		chunks.push({ origIndex: old.length - delLines.length, delLines, insLines });
	}

	if (index < lines.length && lines[index] === "*** End of File") {
		return { context: old, chunks, nextIndex: index + 1, eof: true };
	}

	if (index === origIndex) {
		throw new DiffError(`Nothing in section at line ${index + 1}`);
	}

	return { context: old, chunks, nextIndex: index, eof: false };
}

function findContextCore(lines: string[], context: string[], start: number): { index: number; fuzz: number } {
	if (context.length === 0) return { index: start, fuzz: 0 };

	for (let i = start; i <= lines.length - context.length; i++) {
		let ok = true;
		for (let j = 0; j < context.length; j++) {
			if (lines[i + j] !== context[j]) {
				ok = false;
				break;
			}
		}
		if (ok) return { index: i, fuzz: 0 };
	}

	const rstrip = (value: string) => value.replace(/\s+$/g, "");
	for (let i = start; i <= lines.length - context.length; i++) {
		let ok = true;
		for (let j = 0; j < context.length; j++) {
			if (rstrip(lines[i + j] ?? "") !== rstrip(context[j] ?? "")) {
				ok = false;
				break;
			}
		}
		if (ok) return { index: i, fuzz: 1 };
	}

	const strip = (value: string) => value.trim();
	for (let i = start; i <= lines.length - context.length; i++) {
		let ok = true;
		for (let j = 0; j < context.length; j++) {
			if (strip(lines[i + j] ?? "") !== strip(context[j] ?? "")) {
				ok = false;
				break;
			}
		}
		if (ok) return { index: i, fuzz: 100 };
	}

	return { index: -1, fuzz: 0 };
}

function findContext(lines: string[], context: string[], start: number, eof: boolean): { index: number; fuzz: number } {
	if (!eof) return findContextCore(lines, context, start);

	const atEof = findContextCore(lines, context, Math.max(0, lines.length - context.length));
	if (atEof.index !== -1) return atEof;

	const fallback = findContextCore(lines, context, start);
	return { index: fallback.index, fuzz: fallback.index === -1 ? 0 : fallback.fuzz + 10000 };
}

function applyV4AUpdate(input: string, diff: string): { output: string; fuzz: number } {
	const lineEnding = detectLineEnding(input);
	const patchLines = normalizeLineEndings(diff).split("\n");
	if (patchLines.length > 0 && patchLines[patchLines.length - 1] === "") patchLines.pop();

	const fileLines = normalizeLineEndings(input).split("\n");
	const chunks: Chunk[] = [];
	let fuzz = 0;
	let patchIndex = 0;
	let fileIndex = 0;

	while (patchIndex < patchLines.length) {
		const line = patchLines[patchIndex] ?? "";
		let defStr = "";
		if (line.startsWith("@@ ")) {
			defStr = line.slice(3);
			patchIndex++;
		} else if (line === "@@") {
			patchIndex++;
		} else if (patchIndex !== 0) {
			throw new DiffError(`Invalid diff, expected @@ section: ${line}`);
		}

		if (defStr.trim()) {
			let found = false;
			if (!fileLines.slice(0, fileIndex).some((value) => value === defStr)) {
				for (let i = fileIndex; i < fileLines.length; i++) {
					if (fileLines[i] === defStr) {
						fileIndex = i + 1;
						found = true;
						break;
					}
				}
				if (!found && !fileLines.slice(0, fileIndex).some((value) => value.trim() === defStr.trim())) {
					for (let i = fileIndex; i < fileLines.length; i++) {
						if ((fileLines[i] ?? "").trim() === defStr.trim()) {
							fileIndex = i + 1;
							fuzz += 1;
							break;
						}
					}
				}
			}
		}

		const section = peekNextSection(patchLines, patchIndex);
		const found = findContext(fileLines, section.context, fileIndex, section.eof);
		if (found.index === -1) {
			const context = section.context.join("\n");
			throw new DiffError(`${section.eof ? "Invalid EOF context" : "Invalid context"} ${fileIndex}:\n${context}`);
		}

		fuzz += found.fuzz;
		for (const chunk of section.chunks) {
			chunks.push({
				origIndex: chunk.origIndex + found.index,
				delLines: chunk.delLines,
				insLines: chunk.insLines,
			});
		}

		fileIndex = found.index + section.context.length;
		patchIndex = section.nextIndex;
	}

	const dest: string[] = [];
	let origIndex = 0;
	for (const chunk of chunks) {
		if (origIndex > chunk.origIndex) {
			throw new DiffError(`Patch chunks overlap at original line ${chunk.origIndex + 1}`);
		}

		dest.push(...fileLines.slice(origIndex, chunk.origIndex));
		origIndex = chunk.origIndex;

		const actual = fileLines.slice(origIndex, origIndex + chunk.delLines.length);
		const same = chunk.delLines.length === actual.length && chunk.delLines.every((line, i) => line === actual[i]);
		if (!same) {
			throw new DiffError(
				`Patch conflict at line ${origIndex + 1}. Expected:\n${chunk.delLines.join("\n")}\n\nActual:\n${actual.join("\n")}`,
			);
		}

		dest.push(...chunk.insLines);
		origIndex += chunk.delLines.length;
	}

	dest.push(...fileLines.slice(origIndex));
	return { output: restoreLineEndings(dest.join("\n"), lineEnding), fuzz };
}

function applyV4ACreate(diff: string): string {
	if (diff === "") return "";

	const lines = normalizeLineEndings(diff).split("\n");
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

	const out: string[] = [];
	for (const line of lines) {
		if (!line.startsWith("+")) {
			throw new DiffError(`Invalid create_file diff line, expected '+': ${line}`);
		}
		out.push(line.slice(1));
	}
	return out.join("\n");
}

function totalDiffBytes(operations: readonly Readonly<ApplyPatchOperation>[]): number {
	let bytes = 0;
	for (const op of operations) {
		if (typeof op.diff === "string") {
			bytes += Buffer.byteLength(op.diff, "utf8");
		}
	}
	return bytes;
}

async function applyOperation(
	op: Readonly<ApplyPatchOperation>,
	files: WorkspaceFileOperations,
	signal: AbortSignal | undefined,
): Promise<{ result: ApplyPatchResult; fuzz: number }> {
	const display = op.path;

	return files.runExclusive(op.path, async () => {
		if (signal?.aborted) throw new Error("Operation aborted");

		if (op.type === "create_file") {
			if (typeof op.diff !== "string") throw new DiffError(`create_file missing diff for ${display}`);
			if (await files.exists(op.path)) throw new DiffError(`File already exists at path '${display}'`);

			const content = applyV4ACreate(op.diff);
			await files.ensureParent(op.path);
			await files.write(op.path, Buffer.from(content, "utf8"));
			return { result: { type: op.type, path: display, status: "completed" }, fuzz: 0 };
		}

		if (op.type === "update_file") {
			if (typeof op.diff !== "string") throw new DiffError(`update_file missing diff for ${display}`);
			if (!(await files.exists(op.path))) throw new DiffError(`File not found at path '${display}'`);

			const current = (await files.read(op.path)).toString("utf8");
			const { output, fuzz } = applyV4AUpdate(current, op.diff);

			if (op.move_path) {
				const displayTo = op.move_path;
				if (await files.exists(op.move_path)) throw new DiffError(`Target already exists at path '${displayTo}'`);

				await files.ensureParent(op.move_path);
				await files.write(op.move_path, Buffer.from(output, "utf8"));
				await files.remove(op.path);
				return {
					result: { type: op.type, path: displayTo, status: "completed", output: `Moved from ${display}` },
					fuzz,
				};
			}

			await files.write(op.path, Buffer.from(output, "utf8"));
			return { result: { type: op.type, path: display, status: "completed" }, fuzz };
		}

		if (!(await files.exists(op.path))) throw new DiffError(`File not found at path '${display}'`);
		await files.remove(op.path);
		return { result: { type: op.type, path: display, status: "completed" }, fuzz: 0 };
	});
}

async function applyOperations(
	operations: readonly Readonly<ApplyPatchOperation>[],
	files: WorkspaceFileOperations,
	signal: AbortSignal | undefined,
	onProgress: (message: string) => void,
): Promise<{ fuzz: number; results: ApplyPatchResult[] }> {
	const bytes = totalDiffBytes(operations);
	if (bytes > MAX_TOTAL_DIFF_BYTES) {
		throw new DiffError(`Patch is too large: ${bytes} bytes exceeds ${MAX_TOTAL_DIFF_BYTES}`);
	}

	const results: ApplyPatchResult[] = [];
	let fuzz = 0;
	onProgress(`Applying ${operations.length} operation(s)`);

	for (let i = 0; i < operations.length; i++) {
		if (signal?.aborted) throw new Error("Operation aborted");

		const op = operations[i];
		if (!op) continue;
		let resultPath = typeof op.path === "string" ? op.path : "(invalid)";

		try {
			const displayPath = op.path;
			resultPath = displayPath;
			onProgress(`${i + 1}/${operations.length} ${op.type} ${displayPath}`);

			const applied = await applyOperation(op, files, signal);
			fuzz += applied.fuzz;
			results.push(applied.result);
		} catch (err) {
			results.push({
				type: op.type,
				path: resultPath,
				status: "failed",
				output: err instanceof Error ? err.message : String(err),
			});
		}
	}

	return { fuzz, results };
}

function progress(
	onUpdate: AgentToolUpdateCallback<ApplyPatchDetails> | undefined,
	message: string,
): void {
	onUpdate?.({ content: [{ type: "text", text: message }], details: { stage: "progress", message } });
}

function countNewlines(text: string, maxScanChars = 200_000): number {
	const scanned = text.length > maxScanChars ? text.slice(0, maxScanChars) : text;
	let count = 0;
	for (let i = 0; i < scanned.length; i++) {
		if (scanned.charCodeAt(i) === 10) count++;
	}
	return count;
}

function makeDiffPreview(diff: string): string {
	const text = normalizeLineEndings(diff);
	if (text.length <= PATCH_PREVIEW_MAX_CHARS && countNewlines(text) + 1 <= PATCH_PREVIEW_MAX_LINES) {
		return text;
	}

	const headCount = Math.max(6, Math.floor(PATCH_PREVIEW_MAX_LINES / 2));
	const tailCount = Math.max(6, PATCH_PREVIEW_MAX_LINES - headCount);
	const head = text.split("\n").slice(0, headCount);
	const tailLines = text.slice(-PATCH_PREVIEW_MAX_CHARS).split("\n");
	const tail = tailLines.slice(Math.max(0, tailLines.length - tailCount));
	let preview = [...head, "...", ...tail].join("\n");
	if (preview.length > PATCH_PREVIEW_MAX_CHARS) {
		preview = `${preview.slice(0, PATCH_PREVIEW_MAX_CHARS).trimEnd()}\n...`;
	}
	return preview;
}

function summarizeOperations(args: unknown): { opCount: number; approxBytes: number; paths: string[]; preview?: string } {
	const operations = (args as { operations?: unknown })?.operations;
	if (!Array.isArray(operations)) return { opCount: 0, approxBytes: 0, paths: [] };

	let approxBytes = 0;
	let preview: string | undefined;
	const paths: string[] = [];
	for (const op of operations) {
		if (!op || typeof op !== "object") continue;
		const record = op as { path?: unknown; diff?: unknown };
		if (typeof record.path === "string") {
			paths.push(normalizeUnicodeSpaces(normalizeAtPrefix(record.path)));
		}
		if (typeof record.diff === "string") {
			approxBytes += Buffer.byteLength(record.diff, "utf8");
			preview ??= makeDiffPreview(record.diff);
		}
	}

	return { opCount: operations.length, approxBytes, paths: [...new Set(paths)].slice(0, 20), preview };
}

function formatResults(results: ApplyPatchResult[]): string {
	return results
		.map((result) => {
			const status = result.status === "completed" ? "OK" : "ERR";
			return `${status} ${result.type} ${result.path}${result.output ? ` - ${result.output}` : ""}`;
		})
		.join("\n");
}

function isGptModel(model: ApplyPatchModel | undefined): boolean {
	if (!model) return false;
	return [model.id, model.name]
		.filter((value): value is string => typeof value === "string")
		.some((value) => GPT_MODEL_PATTERN.test(value));
}

async function resolveEntryPath(value: string, cwd: string): Promise<string> {
	const absolute = resolveToCwd(value, cwd);
	const suffix = [path.basename(absolute)];
	let parent = path.dirname(absolute);
	for (;;) {
		try {
			return path.join(await fs.realpath(parent), ...suffix);
		} catch (error) {
			if (errorCode(error) !== "ENOENT") throw error;
			const next = path.dirname(parent);
			if (next === parent) return absolute;
			suffix.unshift(path.basename(parent));
			parent = next;
		}
	}
}

function createLocalFileOperations(cwd: string): WorkspaceFileOperations {
	return {
		resolveEntry: (value) => resolveEntryPath(value, cwd),
		canonicalize: async (value) => {
			const absolute = resolveToCwd(value, cwd);
			try {
				return await fs.realpath(absolute);
			} catch (error) {
				if (errorCode(error) !== "ENOENT") throw error;
				return resolveEntryPath(value, cwd);
			}
		},
		exists: pathExists,
		read: (filePath) => fs.readFile(filePath),
		write: (filePath, content) => fs.writeFile(filePath, content),
		ensureParent: async (filePath) => { await fs.mkdir(path.dirname(filePath), { recursive: true }); },
		remove: (filePath) => fs.unlink(filePath),
		runExclusive: (filePath, operation) => withFileMutationQueue(filePath, operation),
	};
}

function currentFileOperations(workspaces: WorkspaceObserver, cwd: string): WorkspaceFileOperations {
	const access = workspaces.current();
	if (access.kind === "local") return createLocalFileOperations(cwd);
	if (access.kind === "unavailable") throw new Error("Active workspace is unavailable");
	access.workspace.assertActive();
	if (!access.workspace.files) throw new Error("Active workspace does not provide file operations");
	return access.workspace.files;
}

const createApplyPatchTool = (workspaces: WorkspaceObserver) => defineTool<typeof applyPatchSchema, ApplyPatchDetails>({
	name: APPLY_PATCH_TOOL,
	label: "apply_patch",
	description: "Apply structured patch operations using V4A create/update/delete diffs.",
	promptSnippet: "Apply structured file patches using create_file, update_file, and delete_file operations",
	promptGuidelines: [
		"Use apply_patch for file edits when it is available.",
		"For apply_patch create_file operations, put the complete file content in diff with every line prefixed by '+'.",
		"For apply_patch update_file operations, use V4A @@ sections with '+', '-', and space-prefixed context lines.",
		"For apply_patch delete_file operations, omit diff.",
	],
	parameters: applyPatchSchema,
	executionMode: "sequential",

	renderCall(args, theme) {
		const summary = summarizeOperations(args);
		let output = theme.fg("toolTitle", theme.bold("apply_patch"));
		output += theme.fg("muted", ` (${summary.opCount} op(s), ~${summary.approxBytes} diff bytes)`);

		if (summary.paths.length > 0) {
			const shown = summary.paths.slice(0, 8);
			const more = summary.paths.length > shown.length ? ` (+${summary.paths.length - shown.length} more)` : "";
			output += `\n${theme.fg("muted", `Paths: ${shown.join(", ")}${more}`)}`;
		}

		output += `\n\n${theme.fg("toolOutput", summary.preview ?? "(waiting for operations)")}`;
		return new Text(output, 0, 0);
	},

	renderResult(result, options, theme) {
		const details = result.details;
		if (options.isPartial) {
			const message = details.stage === "progress" ? details.message : "Working";
			return new Text(theme.fg("warning", message), 0, 0);
		}

		if (details.stage === "done") {
			const completed = details.results.filter((value) => value.status === "completed").length;
			const failed = details.results.length - completed;
			const header =
				theme.fg(failed > 0 ? "error" : "success", failed > 0 ? "Patch completed with failures" : "Patch applied") +
				theme.fg("muted", ` (fuzz=${details.fuzz}, ${completed} completed, ${failed} failed)`);
			if (!options.expanded) return new Text(header, 0, 0);
			return new Text(`${header}\n${formatResults(details.results)}`, 0, 0);
		}

		return new Text(theme.fg("muted", "(no output)"), 0, 0);
	},

	async execute(
		_toolCallId: string,
		params: ApplyPatchParams,
		signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback<ApplyPatchDetails> | undefined,
		ctx: ExtensionContext,
	): Promise<AgentToolResult<ApplyPatchDetails>> {
		progress(onUpdate, "Applying patch operations");
		const files = currentFileOperations(workspaces, ctx.cwd);
		const operations = await Promise.all(params.operations.map(async (operation) => ({
			...operation,
			path: await files.resolveEntry(operation.path),
			...(operation.move_path ? { move_path: await files.resolveEntry(operation.move_path) } : {}),
		})));

		const { fuzz, results } = await applyOperations(operations, files, signal, (message) =>
			progress(onUpdate, message),
		);
		const summary = formatResults(results);
		return {
			content: [{ type: "text", text: `Done. Fuzz=${fuzz}.\n${summary}` }],
			details: { stage: "done", fuzz, results },
		};
	},
});

export default function (pi: ExtensionAPI) {
	let currentModel: ApplyPatchModel | undefined;
	publishToolEffectAnalyzer(pi, createApplyPatchEffectAnalyzer(APPLY_PATCH_TOOL));
	publishChildToolProvider(pi, {
		id: "apply-patch",
		tools: [{ name: APPLY_PATCH_TOOL, effects: APPLY_PATCH_EFFECTS }],
		async prepare(intent, tools) {
			if (!isGptModel({ id: intent.model })) {
				throw new Error(`Child tool '${APPLY_PATCH_TOOL}' is unavailable for model '${intent.model}'.`);
			}
			return {
				id: "apply-patch",
				args: ["--extension", fileURLToPath(new URL(".", import.meta.url))],
				metadata: { tools: [...tools] },
				dispose: async () => undefined,
			};
		},
	});
	const workspaces = observeActiveWorkspace(pi, (access) => {
		if (access.kind === "ready" && access.workspace.files) access.workspace.registerCompatibleTool(APPLY_PATCH_TOOL);
		if (currentModel) syncApplyPatchTool(currentModel);
	});

	function syncApplyPatchTool(model: ApplyPatchModel | undefined): void {
		currentModel = model;
		const active = new Set(pi.getActiveTools());
		const available = new Set(pi.getAllTools().map((tool) => tool.name));
		const workspace = workspaces.current();
		const enabled = isGptModel(model) && (workspace.kind === "local" || (workspace.kind === "ready" && Boolean(workspace.workspace.files)));

		if (enabled) active.add(APPLY_PATCH_TOOL);
		else active.delete(APPLY_PATCH_TOOL);

		pi.setActiveTools([...active].filter((tool) => available.has(tool)));
	}

	pi.registerTool(createApplyPatchTool(workspaces));

	pi.on("session_start", async (_event, ctx) => {
		syncApplyPatchTool(ctx.model);
	});

	pi.on("model_select", async (event) => {
		syncApplyPatchTool(event.model);
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		syncApplyPatchTool(ctx.model);
	});
}
