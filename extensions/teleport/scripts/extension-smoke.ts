import { strict as assert } from "node:assert";
import { type ChildProcessWithoutNullStreams, execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { parseArgs } from "node:util";
import { getSystemMessageText, type Message } from "@earendil-works/pi-ai";
import type {
	BuildSystemPromptOptions,
	ExtensionAPI,
	ExtensionContext,
	ExtensionCommandContext,
	SessionEntry,
	Skill,
} from "@earendil-works/pi-coding-agent";
import applyPatchExtension from "../../apply-patch/index.ts";
import teleportExtension from "../index.ts";
import { TELEPORT_MARKER_TYPE } from "../session-marker.ts";
import { MasterConnection, quotePosix } from "../transport/master.ts";
import { WorkspaceClient } from "../workspace/client.ts";
import { observeActiveWorkspace, type ActiveWorkspace } from "../../shared/active-workspace.ts";

const { values } = parseArgs({
	options: {
		config: { type: "string" },
		destination: { type: "string", default: "teleport-test" },
		ssh: { type: "string", default: "/usr/bin/ssh" },
	},
});

if (!values.config) throw new Error("--config is required");
const configPath = resolve(values.config);
if (process.env.PI_TELEPORT_FIXTURE_CONFIG !== configPath)
	throw new Error("Run extension-smoke.sh to provide isolated client state");
if ((await readFile(join(configPath, "..", ".fixture-marker"), "utf8")).trim() !== "pi-teleport-isolated-fixture")
	throw new Error("An isolated SSH fixture is required");
const destination = values.destination;
const systemSsh = resolve(values.ssh);
const temporaryRoot = await mkdtemp(join(tmpdir(), "pi-teleport-extension-smoke-"));
const agentDirectory = join(temporaryRoot, "agent");
const wrapperDirectory = join(temporaryRoot, "bin");
const wrapperPath = join(wrapperDirectory, "ssh");
const originalArgv = process.argv;
const originalPath = process.env.PATH;
const originalAgentDirectory = process.env.PI_CODING_AGENT_DIR;
const remoteSkillDirectory = "/workspace/.pi/skills/teleport-smoke";
const remoteSkillPath = `${remoteSkillDirectory}/SKILL.md`;
const remoteSkillContent = "---\nname: teleport-smoke\ndescription: Remote smoke skill\n---\n\nREMOTE TELEPORT SKILL\n";
const remotePromptDirectory = "/workspace/.pi/prompts";
const remotePromptPath = `${remotePromptDirectory}/teleport-review.md`;
const remotePromptContent = "REMOTE TELEPORT PROMPT\n";
const remoteGlobalContext = "$HOME/.pi/agent/AGENTS.override.md";

await mkdir(agentDirectory, { recursive: true });
await mkdir(wrapperDirectory, { recursive: true });
await writeFile(join(agentDirectory, "AGENTS.md"), "teleport-trusted-global-context\n");
await writeFile(wrapperPath, `#!/bin/sh\nexec ${quotePosix(systemSsh)} "$@"\n`);
await chmod(wrapperPath, 0o700);
const initialScratch = listRemoteScratch();

try {
	execRemote("printf '%s\\n' teleport-remote-context > /workspace/AGENTS.md");
	execRemote(
		`test ! -e ${remoteGlobalContext} && mkdir -p -- "$HOME/.pi/agent" && printf '%s\\n' teleport-remote-global-context > ${remoteGlobalContext}`,
	);
	execRemote(
		`mkdir -p -- ${quotePosix(remoteSkillDirectory)} && printf %s ${quotePosix(remoteSkillContent)} > ${quotePosix(remoteSkillPath)}`,
	);
	execRemote(
		`mkdir -p -- ${quotePosix(remotePromptDirectory)} && printf %s ${quotePosix(remotePromptContent)} > ${quotePosix(remotePromptPath)}`,
	);
	process.env.PATH = `${wrapperDirectory}:${originalPath ?? ""}`;
	process.env.PI_CODING_AGENT_DIR = agentDirectory;

	await checkInactiveMode();
	await checkCompactedSession();
	await checkReadyAndFailedMode();
	await checkRecovery();
	await checkStartupFailure();
	await checkShutdownDuringResources();
	await import("./runtime-recovery.ts");
	assert.deepEqual(listRemoteScratch(), initialScratch, "all fixture worker scratch must be removed");

	console.log("teleport extension lifecycle smoke passed");
} finally {
	process.argv = originalArgv;
	if (originalPath === undefined) delete process.env.PATH;
	else process.env.PATH = originalPath;
	if (originalAgentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDirectory;
	try {
		execRemote(
			`rm -f -- /workspace/AGENTS.md ${remoteGlobalContext} ${quotePosix(remotePromptPath)} && rm -rf -- ${quotePosix(remoteSkillDirectory)}`,
		);
	} catch {
		// The isolated endpoint may have been stopped by a failed test.
	}
	await rm(temporaryRoot, { recursive: true, force: true });
}

async function checkInactiveMode(): Promise<void> {
	process.argv = ["bun", "pi"];
	const localWorkspace = join(temporaryRoot, "local-workspace");
	await mkdir(localWorkspace);
	const harness = createHarness(undefined, ["read", "bash", "local-only", "apply_patch"], [], localWorkspace);
	applyPatchExtension(harness.api);
	teleportExtension(harness.api);
	await harness.invoke("session_start", {
		type: "session_start",
		reason: "startup",
	});
	assert.equal(
		await harness.invoke("resources_discover", {
			type: "resources_discover",
			cwd: localWorkspace,
			reason: "startup",
		}),
		undefined,
	);
	assert.deepEqual(harness.activeTools(), ["read", "bash", "local-only", "apply_patch"]);
	assert.equal(await harness.invoke("before_agent_start", promptEvent()), undefined);
	assert.equal(await harness.invoke("tool_call", toolCall("read")), undefined);
	assert.equal(
		await harness.invoke("user_bash", {
			type: "user_bash",
			command: "pwd",
			excludeFromContext: false,
			cwd: "/local/project",
		}),
		undefined,
	);
	assert.equal(harness.shutdownMessage(), undefined);
	const localPath = join(localWorkspace, "apply-local.txt");
	const movedPath = join(localWorkspace, "apply-local-moved.txt");
	const result = await harness.executeTool("apply_patch", {
		operations: [
			{ type: "create_file", path: localPath, diff: "+one" },
			{ type: "update_file", path: localPath, diff: "@@\n-one\n+two" },
			{ type: "update_file", path: localPath, move_path: movedPath, diff: "@@\n-two\n+three" },
			{ type: "delete_file", path: movedPath },
		],
	});
	assert.deepEqual(
		(result.details as { results: Array<{ status: string }> }).results.map((operation) => operation.status),
		["completed", "completed", "completed", "completed"],
	);
}

async function checkReadyAndFailedMode(): Promise<void> {
	process.argv = ["bun", "pi", "--teleport", `${destination}:/workspace`];
	const initialTools = ["read", "write", "edit", "bash", "grep", "find", "ls", "question", "apply_patch", "unknown"];
	const harness = createHarness(`${destination}:/workspace`, initialTools);
	applyPatchExtension(harness.api);
	teleportExtension(harness.api);
	let providedWorkspace: ActiveWorkspace | undefined;
	observeActiveWorkspace(harness.api, (access) => {
		if (access.kind !== "ready") return;
		providedWorkspace = access.workspace;
	});

	const startup = harness.invoke("session_start", {
		type: "session_start",
		reason: "startup",
	});
	await waitFor(() => harness.status("teleport") === "teleport connecting");
	assert.deepEqual(harness.activeTools(), ["question"]);
	const guardedBash = await harness.invoke("user_bash", {
		type: "user_bash",
		command: "pwd",
		excludeFromContext: false,
		cwd: "/local/project",
	});
	await assert.rejects(
		() =>
			bashOperations(guardedBash, "guarded").exec("pwd", "/local/project", {
				onData: () => {},
			}),
		/Teleport workspace is unavailable/,
	);

	await startup;
	assert.equal(harness.shutdownMessage(), undefined);
	assert.deepEqual(harness.workspaceInfo(), {
		label: `${destination}:/workspace`,
		projectTrust: "isolated",
	});
	assert.deepEqual(
		new Set(harness.activeTools()),
		new Set(["read", "write", "edit", "bash", "grep", "find", "ls", "question", "read_output", "apply_patch"]),
	);
	assert(harness.registeredTools().has("read"));
	assert(harness.registeredTools().has("bash"));
	const savedOutput = (await harness.invoke("output_file", {
		type: "output_file",
		prefix: "fixture",
		extension: ".txt",
		data: "client-only fixture output",
	})) as { path: string };
	assert.match(savedOutput.path, /^pi-output:[a-f0-9]{32}$/u);
	const savedResult = await harness.executeTool("read_output", { reference: savedOutput.path, release: true });
	assert(JSON.stringify(savedResult.content).includes("client-only fixture output"));
	await assert.rejects(
		() => harness.executeTool("read_output", { reference: savedOutput.path }),
		/Unknown or expired/,
	);
	const overflow = await harness.executeTool("bash", {
		command: "printf '%070000d\\n' 0; printf 'synthetic-tail\\n'",
	});
	const overflowReference = toolText(overflow).match(/pi-output:[a-f0-9]{32}/u)?.[0];
	assert(overflowReference, "remote overflow must use an opaque output reference");
	const overflowRead = await harness.executeTool("read_output", {
		reference: overflowReference,
		offset: 2,
		limit: 1,
		release: true,
	});
	assert(toolText(overflowRead).includes("synthetic-tail"));
	await assert.rejects(
		() => harness.executeTool("read_output", { reference: overflowReference }),
		/Unknown or expired/,
	);
	assert(harness.entries().some((entry) => entry.type === "custom" && entry.customType === TELEPORT_MARKER_TYPE));
	const discoveredResources = replacementResources(
		await harness.invoke("resources_discover", {
			type: "resources_discover",
			cwd: "/local/project",
			reason: "startup",
		}),
	);
	const discoveredSkills = discoveredResources.replaceSkills;
	const remoteDocument = discoveredSkills.find((document) => document.path === remoteSkillPath);
	assert(remoteDocument);
	assert.equal(remoteDocument.scope, "project");
	assert.equal(remoteDocument.content, remoteSkillContent);
	assert.deepEqual(
		discoveredResources.replacePrompts.find((document) => document.path === remotePromptPath),
		{ path: remotePromptPath, content: remotePromptContent, scope: "project" },
	);
	const reloadedSkillContent = remoteSkillContent.replace("REMOTE TELEPORT SKILL", "RELOADED TELEPORT SKILL");
	const reloadedPromptContent = "RELOADED TELEPORT PROMPT\n";
	execRemote(`printf %s ${quotePosix(reloadedSkillContent)} > ${quotePosix(remoteSkillPath)}`);
	execRemote(`printf %s ${quotePosix(reloadedPromptContent)} > ${quotePosix(remotePromptPath)}`);
	const reloadedResources = replacementResources(
		await harness.invoke("resources_discover", {
			type: "resources_discover",
			cwd: "/local/project",
			reason: "reload",
		}),
	);
	assert.equal(
		reloadedResources.replaceSkills.find((document) => document.path === remoteSkillPath)?.content,
		reloadedSkillContent,
	);
	assert.equal(
		reloadedResources.replacePrompts.find((document) => document.path === remotePromptPath)?.content,
		reloadedPromptContent,
	);
	// Idle compaction transforms historical context without before_agent_start.
	const deliberateUserText: Message = {
		role: "user",
		content: "The user deliberately mentioned /local/project.",
		timestamp: 1,
	};
	const projected = (await harness.invoke("context_with_system", {
		type: "context_with_system",
		messages: [
			{ role: "system", content: "OLD HOST SYSTEM", timestamp: 0 },
			deliberateUserText,
			{ role: "system", content: "", sections: { cwd: "/local/project" }, timestamp: 2 },
		],
	})) as { messages: Message[] };
	assert.equal(projected.messages.length, 2);
	assert.equal(projected.messages[1], deliberateUserText);
	const projectedSystem = projected.messages[0];
	assert.equal(projectedSystem.role, "system");
	if (projectedSystem.role !== "system") throw new Error("Missing leading system message");
	const idlePrompt = getSystemMessageText(projectedSystem);
	assert.match(idlePrompt, /<cwd>\n\/workspace\n<\/cwd>/);
	assert.match(idlePrompt, /teleport-remote-global-context/);
	assert.match(idlePrompt, /teleport-remote-context/);
	assert.doesNotMatch(
		idlePrompt,
		/OLD HOST SYSTEM|\/local\/project|LOCAL CUSTOM PROMPT|LOCAL APPEND PROMPT|teleport-trusted-global-context|Pi documentation/,
	);
	const remoteSkill: Skill = {
		name: "teleport-smoke",
		description: "Remote smoke skill",
		filePath: remoteDocument.path,
		baseDir: remoteSkillDirectory,
		sourceInfo: {
			path: remoteDocument.path,
			source: "extension:teleport",
			scope: remoteDocument.scope,
			origin: "top-level",
		},
		disableModelInvocation: false,
		content: remoteDocument.content,
	};

	const prompt = systemPrompt(await harness.invoke("before_agent_start", promptEvent([remoteSkill])));
	assert.match(prompt, /<cwd>\n\/workspace\n<\/cwd>/);
	assert.doesNotMatch(prompt, /teleport-trusted-global-context/);
	assert.match(prompt, /teleport-remote-global-context/);
	assert.match(prompt, /teleport-remote-context/);
	assert.match(prompt, /- read: remote read/);
	assert.match(prompt, /- question: local control plane/);
	assert.doesNotMatch(prompt, /local-project-context/);
	assert.doesNotMatch(prompt, /LOCAL CUSTOM PROMPT/);
	assert.doesNotMatch(prompt, /LOCAL APPEND PROMPT/);
	assert.doesNotMatch(prompt, /Pi documentation/);
	assert.doesNotMatch(prompt, /local-skill/);
	assert.match(prompt, /teleport-smoke/);
	assert.match(prompt, /\/workspace\/\.pi\/skills\/teleport-smoke\/SKILL\.md/);
	assert.match(prompt, /apply_patch: structured patch tool/);
	assert.equal(await harness.invoke("tool_call", toolCall("read")), undefined);
	assert.equal(await harness.invoke("tool_call", toolCall("apply_patch")), undefined);
	const workspace = providedWorkspace;
	if (!workspace) throw new Error("Teleport workspace was not published");
	await checkRemoteToolCwd(harness, workspace);
	await checkRemoteApplyPatch(harness, workspace);
	await checkChildAttachment(workspace, destination);
	const markerEntry = harness
		.entries()
		.find((entry) => entry.type === "custom" && entry.customType === TELEPORT_MARKER_TYPE);
	if (!markerEntry || markerEntry.type !== "custom") throw new Error("Teleport marker was not appended");
	const matchingSession = join(temporaryRoot, "matching-session.jsonl");
	const mismatchedSession = join(temporaryRoot, "mismatched-session.jsonl");
	await writeSession(matchingSession, markerEntry.data);
	await writeSession(mismatchedSession, {
		protocolVersion: 1,
		destination,
		cwd: "/other",
	});
	assert.equal(
		await harness.invoke("session_before_switch", {
			type: "session_before_switch",
			reason: "resume",
			targetSessionFile: matchingSession,
		}),
		undefined,
	);
	assert.deepEqual(
		await harness.invoke("session_before_switch", {
			type: "session_before_switch",
			reason: "resume",
			targetSessionFile: mismatchedSession,
		}),
		{ cancel: true },
	);
	assert.equal(
		await harness.invoke("session_before_fork", {
			type: "session_before_fork",
			entryId: "entry-1",
			position: "at",
		}),
		undefined,
	);

	const readyBash = await harness.invoke("user_bash", {
		type: "user_bash",
		command: "kill -KILL $PPID",
		excludeFromContext: false,
		cwd: "/local/project",
	});
	await assert.rejects(
		() =>
			bashOperations(readyBash, "ready").exec("kill -KILL $PPID", "/local/project", {
				onData: () => {},
				timeout: 5,
			}),
		/Worker transport closed|protocol stream ended|closed/,
	);
	await waitFor(() => harness.status("teleport") === "teleport disconnected");
	assert.deepEqual(new Set(harness.activeTools()), new Set(["question", "read_output"]));
	assert.throws(() => workspace.assertActive(), /Teleport workspace is unavailable/);
	await assert.rejects(
		() => workspace.children?.prepareChild({ cwd: "/workspace/unavailable" }) ?? Promise.resolve(),
		/Teleport workspace is unavailable/,
	);
	assert(
		harness.notifications().some((notification) => notification.message.startsWith("Teleport: Connection lost:")),
	);
	assert.deepEqual(await harness.invoke("tool_call", toolCall("read")), {
		block: true,
		reason: "Teleport workspace is unavailable",
	});
	assert.deepEqual(
		await harness.invoke("session_before_switch", {
			type: "session_before_switch",
			reason: "new",
		}),
		{ cancel: true },
	);
	assert.deepEqual(
		await harness.invoke("session_before_fork", {
			type: "session_before_fork",
			entryId: "entry-1",
			position: "at",
		}),
		{ cancel: true },
	);
	assert.deepEqual(
		replacementResources(
			await harness.invoke("resources_discover", {
				type: "resources_discover",
				cwd: "/local/project",
				reason: "reload",
			}),
		),
		{ replaceSkills: [], replacePrompts: [] },
	);
	const failedPrompt = systemPrompt(await harness.invoke("before_agent_start", promptEvent([remoteSkill])));
	assert.match(failedPrompt, /<cwd>\n\/workspace\n<\/cwd>/);
	assert.doesNotMatch(failedPrompt, /teleport-trusted-global-context/);
	assert.doesNotMatch(failedPrompt, /teleport-remote-global-context/);
	assert.doesNotMatch(failedPrompt, /teleport-remote-context/);
	assert.doesNotMatch(failedPrompt, /- read: remote read/);
	assert.doesNotMatch(failedPrompt, /local-project-context/);
	assert.doesNotMatch(failedPrompt, /teleport-smoke/);

	await harness.invoke("session_shutdown", {
		type: "session_shutdown",
		reason: "quit",
	});
	assert.equal(harness.workspaceInfo(), undefined);
	assert.equal(harness.status("teleport"), undefined);
}

async function checkRemoteToolCwd(
	harness: ReturnType<typeof createHarness>,
	workspace: ActiveWorkspace,
): Promise<void> {
	assert(workspace.files);
	const path = "~/.teleport-home-smoke.txt";
	try {
		assert.match(toolText(await harness.executeTool("read", { path: "sentinel.txt" })), /remote-sentinel/);
		await harness.executeTool("write", {
			path,
			content: "one\n",
		});
		await harness.executeTool("edit", {
			path,
			edits: [{ oldText: "one", newText: "two" }],
		});
		const resolvedPath = await workspace.files.resolveEntry(path);
		assert.equal((await workspace.files.read(resolvedPath)).toString("utf8"), "two\n");
		assert.match(toolText(await harness.executeTool("ls", { path: "~" })), /\.teleport-home-smoke\.txt/);
		assert.match(
			toolText(
				await harness.executeTool("find", {
					pattern: "*.txt",
					path: "~",
				}),
			),
			/\.teleport-home-smoke\.txt/,
		);
		assert.match(
			toolText(
				await harness.executeTool("grep", {
					pattern: "two",
					path,
				}),
			),
			/two/,
		);
		assert.equal(toolText(await harness.executeTool("bash", { command: "pwd" })).trim(), "/workspace");
	} finally {
		const resolvedPath = await workspace.files.resolveEntry(path);
		if (await workspace.files.exists(resolvedPath)) await workspace.files.remove(resolvedPath);
	}
}

async function checkRemoteApplyPatch(
	harness: ReturnType<typeof createHarness>,
	workspace: ActiveWorkspace,
): Promise<void> {
	assert(workspace.files);
	const path = "/workspace/.teleport-apply-smoke.txt";
	const movedPath = "/workspace/.teleport-apply-smoke-moved.txt";
	const result = await harness.executeTool("apply_patch", {
		operations: [
			{ type: "create_file", path, diff: "+one" },
			{ type: "update_file", path, diff: "@@\n-one\n+two" },
			{
				type: "update_file",
				path,
				move_path: movedPath,
				diff: "@@\n-two\n+three",
			},
			{ type: "delete_file", path: movedPath },
		],
	});
	assert.deepEqual(
		(result.details as { results: Array<{ status: string }> }).results.map((operation) => operation.status),
		["completed", "completed", "completed", "completed"],
	);
	assert.equal(await workspace.files.exists(path), false);
	assert.equal(await workspace.files.exists(movedPath), false);
}

async function checkChildAttachment(workspace: ActiveWorkspace, expectedDestination: string): Promise<void> {
	assert(workspace.children);
	assert(workspace.files);
	const requestedCwd = "/workspace/child-project";
	const attachment = await workspace.children.prepareChild({ cwd: requestedCwd });
	try {
		assert.deepEqual(attachment.args.slice(0, 5), [
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-context-files",
			"--extension",
		]);
		assert.equal(isAbsolute(attachment.args[5] ?? ""), true);
		assert.deepEqual(attachment.env, { PI_ACTIVE_WORKSPACE_HANDOFF_FD: "3" });
		assert.deepEqual(await readdir(attachment.hostCwd), []);
		assert(attachment.writeHandoff);

		const stream = new PassThrough();
		const chunks: Buffer[] = [];
		stream.on("data", (chunk: Buffer) => chunks.push(chunk));
		const ended = new Promise<void>((resolveEnd) => stream.on("end", resolveEnd));
		attachment.writeHandoff(stream);
		await ended;
		const handoff = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
			destination: string;
			cwd: string;
			socketPath: string;
		};
		assert.equal(handoff.destination, expectedDestination);
		assert.equal(handoff.cwd, requestedCwd);
		assert.equal(typeof handoff.socketPath, "string");
		assert.deepEqual(Object.keys(handoff).sort(), ["cwd", "destination", "socketPath"]);

		const borrowed = new MasterConnection({
			destination: handoff.destination,
			borrowedSocketPath: handoff.socketPath,
		});
		try {
			await borrowed.start();
			const result = await collectChannel(borrowed.spawnChannel("printf child-channel-ok"));
			assert.equal(result.code, 0);
			assert.equal(result.stdout, "child-channel-ok");
			assert.equal(result.stderr, "");
		} finally {
			await borrowed.close();
		}
		assert.equal((await workspace.files.read("/workspace/sentinel.txt")).toString("utf8"), "remote-sentinel\n");
	} finally {
		await attachment.dispose();
	}
	await assert.rejects(() => readdir(attachment.hostCwd), /ENOENT/);
}

async function collectChannel(
	child: ChildProcessWithoutNullStreams,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk: Buffer) => {
		stdout += chunk.toString("utf8");
	});
	child.stderr.on("data", (chunk: Buffer) => {
		stderr += chunk.toString("utf8");
	});
	child.stdin.end();
	const code = await new Promise<number | null>((resolveClose, rejectClose) => {
		child.once("error", rejectClose);
		child.once("close", resolveClose);
	});
	return { code, stdout, stderr };
}

async function checkCompactedSession(): Promise<void> {
	process.argv = ["bun", "pi", "--teleport", `${destination}:/workspace`];
	const timestamp = new Date(0).toISOString();
	const harness = createHarness(
		`${destination}:/workspace`,
		["read", "bash"],
		[
			{
				type: "custom",
				id: "marker",
				parentId: null,
				timestamp,
				customType: TELEPORT_MARKER_TYPE,
				data: {
					protocolVersion: 1,
					destination,
					cwd: "/workspace",
				},
			},
			{
				type: "compaction",
				id: "compaction",
				parentId: "marker",
				timestamp,
				summary: "in-memory compacted transcript",
				firstKeptEntryId: "marker",
				tokensBefore: 10_000,
			},
		],
	);
	teleportExtension(harness.api);
	await harness.invoke("session_start", {
		type: "session_start",
		reason: "resume",
	});
	assert.equal(harness.shutdownMessage(), undefined);
	assert.deepEqual(new Set(harness.activeTools()), new Set(["read", "bash", "read_output"]));
	assert.equal(
		harness.entries().filter((entry) => entry.type === "custom" && entry.customType === TELEPORT_MARKER_TYPE).length,
		1,
	);
	await harness.invoke("session_shutdown", {
		type: "session_shutdown",
		reason: "quit",
	});
}

async function checkStartupFailure(): Promise<void> {
	process.argv = ["bun", "pi", "--teleport", `${destination}:/workspace/does-not-exist`];
	const harness = createHarness(`${destination}:/workspace/does-not-exist`, ["read", "bash"]);
	teleportExtension(harness.api);
	await harness.invoke("session_start", {
		type: "session_start",
		reason: "startup",
	});
	assert.deepEqual(harness.activeTools(), []);
	assert.equal(harness.status("teleport"), "teleport disconnected");
	assert.equal(harness.shutdownMessage(), undefined);
	assert.equal(harness.workspaceInfo(), undefined);
	execRemote("mkdir -- /workspace/does-not-exist");
	try {
		await harness.command("reconnect");
		assert.equal(harness.workspaceInfo()?.label, `${destination}:/workspace/does-not-exist`);
	} finally {
		await harness.command("disconnect");
		execRemote("rmdir -- /workspace/does-not-exist");
	}
	await harness.invoke("session_shutdown", {
		type: "session_shutdown",
		reason: "quit",
	});
}

async function checkRecovery(): Promise<void> {
	process.argv = ["bun", "pi", "--teleport", `${destination}:/workspace`];
	const harness = createHarness(`${destination}:/workspace`, ["read", "bash", "question", "apply_patch"]);
	applyPatchExtension(harness.api);
	teleportExtension(harness.api);
	let workspace: ActiveWorkspace | undefined;
	observeActiveWorkspace(harness.api, (access) => {
		if (access.kind === "ready") workspace = access.workspace;
	});
	await harness.invoke("session_start", { type: "session_start", reason: "startup" });
	const original = workspace!;
	harness.appendSyntheticMessage("Client-ZDR synthetic conversation must survive transport loss");
	const conversation = harness.entries();
	const saved = (await harness.invoke("output_file", {
		type: "output_file",
		prefix: "recovery",
		extension: ".txt",
		data: "client recovery canary",
	})) as { path: string };
	const overflow = await harness.executeTool("bash", { command: "printf '%070000d\\n' 0" });
	const remoteReference = toolText(overflow).match(/pi-output:[a-f0-9]{32}/u)?.[0];
	assert(remoteReference);
	const mutation = "/workspace/teleport-recovery-once.txt";
	try {
		await assert.rejects(() =>
			harness.executeTool("bash", { command: `printf 'once\\n' >> ${mutation}; kill -KILL $PPID` }),
		);
		await waitFor(() => harness.status("teleport") === "teleport disconnected");
		assert.equal(harness.shutdownMessage(), undefined);
		assert.deepEqual(harness.entries(), conversation);
		assert.throws(() => original.assertActive(), /unavailable/);
		assert(
			toolText(await harness.executeTool("read_output", { reference: saved.path })).includes(
				"client recovery canary",
			),
		);
		await assert.rejects(() => harness.executeTool("read_output", { reference: remoteReference }), /expired/);
		await harness.command("");
		assert(harness.notifications().some(({ message }) => message.includes("Connection: disconnected")));
		execRemote(`printf %s ${quotePosix("RECOVERED PROMPT\n")} > ${quotePosix(remotePromptPath)}`);
		await Promise.all([harness.command("reconnect"), harness.command("reconnect")]);
		assert.notEqual(workspace, original);
		workspace!.assertActive();
		assert.deepEqual(
			new Set(harness.activeTools()),
			new Set(["read", "bash", "question", "read_output", "apply_patch"]),
		);
		await checkRemoteApplyPatch(harness, workspace!);
		await checkChildAttachment(workspace!, destination);
		assert.deepEqual(harness.entries(), conversation);
		assert.equal(
			toolText(await harness.executeTool("read", { path: mutation })).trim(),
			"once",
			"reconnect must not replay an uncertain mutation",
		);
		assert.equal(
			replacementResources(
				await harness.invoke("resources_discover", { type: "resources_discover", reason: "refresh" }),
			).replacePrompts.find(({ path }) => path === remotePromptPath)?.content,
			"RECOVERED PROMPT\n",
		);
		assert(
			toolText(await harness.executeTool("read_output", { reference: saved.path })).includes(
				"client recovery canary",
			),
		);
		const ownScratch = listRemoteScratch();
		await harness.command("reconnect");
		assert.deepEqual(listRemoteScratch(), ownScratch, "reconnect while connected is a no-op");
		await harness.command("disconnect");
		assert.equal(harness.status("teleport"), "teleport disconnected");
		assert.deepEqual(harness.entries(), conversation);
		assert.deepEqual(await harness.invoke("tool_call", toolCall("bash")), {
			block: true,
			reason: "Teleport workspace is unavailable",
		});
		await harness.command("reconnect");
		assert.equal(
			toolText(await harness.executeTool("bash", { command: "printf 'fresh-operation'" })),
			"fresh-operation",
		);
		await harness.executeTool("read_output", { reference: saved.path, release: true });
	} finally {
		await harness.invoke("session_shutdown", { type: "session_shutdown", reason: "quit" });
		execRemote(`rm -f -- ${mutation}`);
	}
}

async function checkShutdownDuringResources(): Promise<void> {
	process.argv = ["bun", "pi", "--teleport", `${destination}:/workspace`];
	const harness = createHarness(`${destination}:/workspace`, ["read", "bash"]);
	teleportExtension(harness.api);
	const original = WorkspaceClient.prototype.context;
	let reached = false;
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	WorkspaceClient.prototype.context = async () => {
		reached = true;
		await gate;
		return [];
	};
	let startup: Promise<unknown> | undefined;
	try {
		startup = harness.invoke("session_start", { type: "session_start", reason: "startup" });
		await waitFor(() => reached);
		await harness.invoke("session_shutdown", { type: "session_shutdown", reason: "quit" });
		assert.deepEqual(
			listRemoteScratch(),
			initialScratch,
			"shutdown must dispose a ready worker whose resource discovery is unfinished",
		);
		release();
		await startup;
		assert.equal(harness.workspaceInfo(), undefined);
		assert.equal(harness.shutdownMessage(), undefined);
		assert.deepEqual(harness.activeTools(), []);
	} finally {
		release();
		await startup;
		WorkspaceClient.prototype.context = original;
	}
}

function promptEvent(skills: Skill[] = [localSkill()]): {
	type: "before_agent_start";
	messageType: "user";
	prompt: string;
	systemPrompt: string;
	systemPromptOptions: BuildSystemPromptOptions;
} {
	return {
		type: "before_agent_start",
		messageType: "user",
		prompt: "test",
		systemPrompt: "local assembled prompt",
		systemPromptOptions: {
			cwd: "/local/project",
			customPrompt: "LOCAL CUSTOM PROMPT",
			appendSystemPrompt: "LOCAL APPEND PROMPT",
			selectedTools: ["read", "question", "apply_patch"],
			toolSnippets: {
				read: "remote read",
				question: "local control plane",
				apply_patch: "structured patch tool",
			},
			contextFiles: [
				{
					path: join(process.env.PI_CODING_AGENT_DIR ?? "", "AGENTS.md"),
					content: "teleport-trusted-global-context\n",
				},
				{
					path: "/local/project/AGENTS.md",
					content: "local-project-context\n",
				},
			],
			skills,
		},
	};
}

function localSkill(): Skill {
	const path = "/local/project/.pi/skills/local-skill/SKILL.md";
	return {
		name: "local-skill",
		description: "Local skill",
		filePath: path,
		baseDir: "/local/project/.pi/skills/local-skill",
		sourceInfo: {
			path,
			source: "local",
			scope: "project",
			origin: "top-level",
		},
		disableModelInvocation: false,
	};
}

function replacementResources(result: unknown): {
	replaceSkills: Array<{ path: string; content: string; scope: "user" | "project" }>;
	replacePrompts: Array<{ path: string; content: string; scope: "user" | "project" }>;
} {
	if (
		typeof result !== "object" ||
		result === null ||
		!("replaceSkills" in result) ||
		!Array.isArray(result.replaceSkills) ||
		!("replacePrompts" in result) ||
		!Array.isArray(result.replacePrompts)
	) {
		throw new Error("resources_discover did not replace resources");
	}
	return result as {
		replaceSkills: Array<{ path: string; content: string; scope: "user" | "project" }>;
		replacePrompts: Array<{ path: string; content: string; scope: "user" | "project" }>;
	};
}

function toolCall(toolName: string): {
	type: "tool_call";
	toolCallId: string;
	toolName: string;
	input: Record<string, unknown>;
} {
	return {
		type: "tool_call",
		toolCallId: `call-${toolName}`,
		toolName,
		input: {},
	};
}

function systemPrompt(result: unknown): string {
	if (
		typeof result !== "object" ||
		result === null ||
		!("systemPrompt" in result) ||
		typeof result.systemPrompt !== "string"
	) {
		throw new Error("before_agent_start did not return a system prompt");
	}
	return result.systemPrompt;
}

function toolText(result: { content?: unknown }): string {
	if (!Array.isArray(result.content)) throw new Error("Tool result has no content");
	return result.content
		.map((item) => {
			if (
				typeof item !== "object" ||
				item === null ||
				!("type" in item) ||
				item.type !== "text" ||
				!("text" in item) ||
				typeof item.text !== "string"
			) {
				throw new Error("Tool result contains non-text content");
			}
			return item.text;
		})
		.join("\n");
}

interface TestBashOperations {
	exec(
		command: string,
		cwd: string,
		options: { onData(data: Buffer): void; timeout?: number },
	): Promise<{ exitCode: number | null; fullOutputPath?: string }>;
}

function bashOperations(result: unknown, state: string): TestBashOperations {
	if (
		typeof result !== "object" ||
		result === null ||
		!("operations" in result) ||
		typeof result.operations !== "object" ||
		result.operations === null ||
		!("exec" in result.operations) ||
		typeof result.operations.exec !== "function"
	) {
		throw new Error(`user_bash did not return operations in ${state} state`);
	}
	return result.operations as TestBashOperations;
}

type Handler = (event: unknown, context: ExtensionContext) => unknown | Promise<unknown>;

function createHarness(
	requestedTarget: string | undefined,
	initialTools: string[],
	initialEntries: SessionEntry[] = [],
	contextCwd = "/local/project",
) {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, (args: string, ctx: ExtensionCommandContext) => Promise<void>>();
	const registeredTools = new Map<string, { execute?: (...args: unknown[]) => Promise<unknown> }>();
	const entries: SessionEntry[] = [...initialEntries];
	const statuses = new Map<string, string | undefined>();
	const notifications: Array<{
		message: string;
		type: "info" | "warning" | "error" | undefined;
	}> = [];
	const eventHandlers = new Map<string, Set<(data: unknown) => void>>();
	let activeTools = [...initialTools];
	let shutdownMessage: string | undefined;
	let workspaceInfo: { label: string; projectTrust: "isolated" } | undefined;

	const api = {
		on(event: string, handler: Handler): void {
			const current = handlers.get(event) ?? [];
			current.push(handler);
			handlers.set(event, current);
		},
		registerFlag(): void {},
		registerCommand(
			name: string,
			options: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> },
		): void {
			commands.set(name, options.handler);
		},
		getFlag(name: string): string | undefined {
			return name === "teleport" ? requestedTarget : undefined;
		},
		reportStartupError(message: string): void {
			throw new Error(`Unexpected startup diagnostic: ${message}`);
		},
		registerTool(tool: unknown): void {
			if (typeof tool !== "object" || tool === null || !("name" in tool) || typeof tool.name !== "string") {
				throw new Error("Registered tool has no name");
			}
			registeredTools.set(tool.name, tool as { execute?: (...args: unknown[]) => Promise<unknown> });
		},
		appendEntry(customType: string, data: unknown): void {
			entries.push({
				type: "custom",
				id: `entry-${entries.length + 1}`,
				parentId: null,
				timestamp: new Date(0).toISOString(),
				customType,
				data,
			});
		},
		getActiveTools(): string[] {
			return [...activeTools];
		},
		getAllTools(): Array<{ name: string }> {
			return [...new Set([...initialTools, ...registeredTools.keys()])].map((name) => ({ name }));
		},
		setActiveTools(names: string[]): void {
			activeTools = [...names];
		},
		events: {
			emit(channel: string, data: unknown): void {
				for (const handler of eventHandlers.get(channel) ?? []) handler(data);
			},
			on(channel: string, handler: (data: unknown) => void): () => void {
				const current = eventHandlers.get(channel) ?? new Set();
				current.add(handler);
				eventHandlers.set(channel, current);
				return () => current.delete(handler);
			},
		},
	} as unknown as ExtensionAPI;

	const context = {
		privacy: { clientZdr: true, remoteZdr: false },
		abort() {},
		isIdle: () => true,
		waitForIdle: async () => {},
		refreshResources: async () => {
			for (const handler of handlers.get("resources_discover") ?? [])
				await handler({ type: "resources_discover", reason: "refresh", cwd: contextCwd }, context);
		},
		prepareBashLaunch: async () => undefined,
		mode: "rpc",
		hasUI: true,
		cwd: contextCwd,
		// Core has already replaced the local skill catalog during resource discovery.
		getSystemPromptOptions: () => promptEvent([]).systemPromptOptions,
		model: { provider: "test", id: "gpt-test", input: ["text"] },
		sessionManager: {
			getEntries: () => entries,
		},
		ui: {
			theme: {
				fg: (_color: string, text: string) => text,
			},
			setStatus(key: string, text: string | undefined): void {
				statuses.set(key, text);
			},
			setWorkspaceInfo(info: { label: string; projectTrust: "isolated" } | undefined): void {
				workspaceInfo = info;
			},
			addAutocompleteProvider(): void {},
			setTitle(): void {},
			notify(message: string, type: "info" | "warning" | "error" | undefined): void {
				notifications.push({ message, type });
			},
		},
		shutdown(message?: string): void {
			shutdownMessage = message;
		},
	} as unknown as ExtensionContext;

	return {
		api,
		async command(args: string) {
			const handler = commands.get("teleport");
			assert(handler);
			await handler(args, context as ExtensionCommandContext);
		},
		activeTools: () => [...activeTools],
		entries: () => [...entries],
		appendSyntheticMessage(text: string) {
			entries.push({
				type: "message",
				id: "synthetic-recovery-message",
				parentId: null,
				timestamp: new Date(0).toISOString(),
				message: { role: "user", content: [{ type: "text", text }], timestamp: 0 },
			});
		},
		registeredTools: () => new Set(registeredTools.keys()),
		shutdownMessage: () => shutdownMessage,
		workspaceInfo: () => workspaceInfo,
		status: (key: string) => statuses.get(key),
		notifications: () => [...notifications],
		async invoke(eventName: string, event: unknown): Promise<unknown> {
			const eventHandlers = handlers.get(eventName) ?? [];
			assert(eventHandlers.length > 0, `expected a ${eventName} handler`);
			let result: unknown;
			for (const handler of eventHandlers) {
				const next = await handler(event, context);
				if (next !== undefined) result = next;
			}
			return result;
		},
		async executeTool(name: string, params: unknown): Promise<{ content?: unknown; details?: unknown }> {
			const tool = registeredTools.get(name);
			if (!tool?.execute) throw new Error(`Tool ${name} is not registered`);
			return (await tool.execute(`call-${name}`, params, undefined, undefined, context)) as {
				content?: unknown;
				details?: unknown;
			};
		},
	};
}

function execRemote(command: string): void {
	execFileSync(systemSsh, ["-F", configPath, destination, command], {
		stdio: "ignore",
	});
}

function listRemoteScratch(): Set<string> {
	const output = execFileSync(
		systemSsh,
		["-F", configPath, destination, "find /tmp -maxdepth 1 -type d -name 'pi-teleport-*' -print"],
		{ encoding: "utf8" },
	);
	return new Set(output.split("\n").filter(Boolean));
}

async function writeSession(path: string, marker: unknown): Promise<void> {
	const lines = [
		{
			type: "session",
			version: 3,
			id: "teleport-smoke-session",
			timestamp: new Date(0).toISOString(),
			cwd: "/local/project",
		},
		{
			type: "custom",
			id: "marker",
			parentId: null,
			timestamp: new Date(0).toISOString(),
			customType: TELEPORT_MARKER_TYPE,
			data: marker,
		},
	];
	await writeFile(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
}

async function waitFor(condition: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (condition()) return;
		await new Promise((resolveWait) => setTimeout(resolveWait, 25));
	}
	throw new Error("Timed out waiting for extension state change");
}
