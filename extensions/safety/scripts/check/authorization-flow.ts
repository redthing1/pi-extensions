import type {
	BashLaunchEvent,
	ExtensionContext,
	KeybindingsManager,
	Theme,
	ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EffectiveSafetyPolicy } from "../../src/config/types.js";
import { loadSafetyConfig } from "../../src/config/load.js";
import { SafetyController } from "../../src/controller/controller.js";
import { requestFromBashLaunch, requestFromToolCall, requestFromToolCallWithWorkspace } from "../../src/controller/request.js";
import type { WorkspaceFileOperations } from "../../../shared/active-workspace.ts";
import { canonicalPath, isWithinOrEqual } from "../../src/paths/normalize.js";
import { ApprovalManager } from "../../src/reins/approval-manager.js";
import { approvalOptions, type ApprovalResult } from "../../src/ui/approval.js";
import { assert } from "./assert.js";
import type { CheckContext } from "./context.js";

export async function checkAuthorizationFlow({ cwd, loaded }: CheckContext): Promise<void> {
	const tempDir = mkdtempSync(join(tmpdir(), "pi-safety-auth-flow-"));
	try {
		await checkPathThenCommandAuthorization(cwd, loaded.policy, tempDir);
		await checkPersistentCommandApprovalsAdvance(cwd, loaded.policy, tempDir);
		await checkUnpersistableCommandRemainder(cwd, loaded.policy, tempDir);
		await checkDangerousCommandHasNoPersistentGrant(cwd, loaded.policy, tempDir);
		await checkSessionOnlyApprovalPersistence(cwd, loaded.policy);
		await checkZdrControllerDoesNotPersist(cwd, tempDir);
		await checkSyntheticProtectedPathBlocksWithoutPrompt(cwd, loaded.policy, tempDir);
		await checkApprovalInterruptAborts(cwd, loaded.policy, tempDir);
		await checkCurlOutputThenReadApproval(cwd, loaded.policy);
		await checkParallelApprovalsSerialize(cwd, loaded.policy);
		await checkApprovalQueueRecovers(cwd, loaded.policy);
		await checkDeniedApprovalCancelsQueue(cwd, loaded.policy);
		await checkActiveApprovalClosesOnAbort(cwd, loaded.policy);
		await checkNonTuiApprovalFailsClosed(cwd, loaded.policy);
		await checkProvidedWorkspacePaths(tempDir);
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
}

async function checkProvidedWorkspacePaths(agentDir: string): Promise<void> {
	const policy = loadSafetyConfig({
		agentDir,
		cwd: agentDir,
		workspace: { cwd: "/workspace/sub", root: "/workspace", home: "/home/remote" },
		enabledOverride: true,
	}).policy;
	const files: WorkspaceFileOperations = {
		resolveEntry: async (path) => path,
		canonicalize: async (path) => path === "/workspace/sub/link" ? "/outside" : path,
		exists: async () => false,
		read: async () => Buffer.alloc(0),
		write: async () => undefined,
		ensureParent: async () => undefined,
		remove: async () => undefined,
		runExclusive: async (_path, operation) => operation(),
	};
	const request = await requestFromToolCallWithWorkspace(
		{ type: "tool_call", toolName: "bash", toolCallId: "provided-workspace", input: { command: "cat link" } } satisfies ToolCallEvent,
		policy.workspaceCwd,
		policy,
		files,
	);
	assert(policy.workspaceKind === "provided", "provided workspace policy should not claim local containment");
	assert(request.cwd === "/workspace/sub", "provided workspace request should use the provided cwd");
	assert(request.paths.some((path) => path.absolutePath === "/workspace/sub/link" && path.reason === "symlink-escapes-root"), "provided workspace paths should be resolved and canonicalized by the provider");
}

async function checkCurlOutputThenReadApproval(cwd: string, policy: EffectiveSafetyPolicy): Promise<void> {
	const command =
		"curl -s --max-time 40 https://example.invalid/synthetic -o /tmp/pi-safety-synthetic-download; grep -i synthetic /tmp/pi-safety-synthetic-download";
	const request = requestFromBashLaunch(
		{
			type: "bash_launch",
			shell: "bash",
			home: "/synthetic/home",
			pathStyle: "posix",
			source: "tool",
			id: "bash-curl-output-then-read",
			submittedCommand: command,
			command,
			cwd,
			operationsKind: "local",
		} satisfies BashLaunchEvent,
		policy,
	);
	const tempRoot = canonicalPath("/tmp");
	assert(
		request.paths.some((path) => path.operation === "write" && isWithinOrEqual(path.resolvedPath, tempRoot)),
		"curl output should classify as a canonical temporary-directory write",
	);
	assert(
		request.paths.some((path) => path.operation === "read" && isWithinOrEqual(path.resolvedPath, tempRoot)),
		"the following grep should classify as a canonical temporary-directory read",
	);
	const ctx = queuedApprovalContext(cwd, [{ choice: "allow_once" }, { choice: "allow_once" }]);
	const authorization = await new ApprovalManager(cwd, { persistence: "session" }).authorize(policy, request, ctx);
	assert(authorization.decision.kind === "allow", "curl output followed by a read should resolve after explicit approvals");
	assert(ctx.prompts === 2, "curl output followed by a read should ask once for its shared path scope and once for the command");
}

async function checkParallelApprovalsSerialize(cwd: string, policy: EffectiveSafetyPolicy): Promise<void> {
	const manager = new ApprovalManager(cwd, { persistence: "session" });
	const probe = new ApprovalPromptProbe();
	const ctx = approvalContext(cwd, () => probe.open());
	const first = manager.authorize(policy, unknownCommandRequest(cwd, policy, "parallel-a"), ctx);
	const second = manager.authorize(policy, unknownCommandRequest(cwd, policy, "parallel-b"), ctx);

	await waitForPromptCount(ctx, 1);
	await Promise.resolve();
	assert(ctx.prompts === 1, "a second parallel authorization should wait for the active prompt");
	assert(probe.maxActive === 1, "parallel authorizations should never own multiple custom prompts");
	probe.resolveNext({ choice: "allow_once" });

	await waitForPromptCount(ctx, 2);
	assert(probe.maxActive === 1, "the next queued approval should open only after the first closes");
	probe.resolveNext({ choice: "allow_once" });

	const [firstResult, secondResult] = await Promise.all([first, second]);
	assert(firstResult.decision.kind === "allow", "the first parallel authorization should complete");
	assert(secondResult.decision.kind === "allow", "the second parallel authorization should complete");
}

async function checkApprovalQueueRecovers(cwd: string, policy: EffectiveSafetyPolicy): Promise<void> {
	const manager = new ApprovalManager(cwd, { persistence: "session" });
	let prompt = 0;
	const ctx = approvalContext(cwd, () => {
		prompt += 1;
		if (prompt === 1) throw new Error("synthetic approval failure");
		return { choice: "allow_once" };
	});
	const first = manager.authorize(policy, unknownCommandRequest(cwd, policy, "failure-a"), ctx);
	const second = manager.authorize(policy, unknownCommandRequest(cwd, policy, "failure-b"), ctx);
	const [firstResult, secondResult] = await Promise.all([first, second]);
	assert(firstResult.decision.kind === "block", "an approval UI failure should fail closed");
	assert(firstResult.decision.reason.includes("synthetic approval failure"), "an approval UI failure should retain its cause");
	assert(secondResult.decision.kind === "allow", "an approval UI failure should not strand the next queued authorization");
}

async function checkDeniedApprovalCancelsQueue(cwd: string, policy: EffectiveSafetyPolicy): Promise<void> {
	const manager = new ApprovalManager(cwd, { persistence: "session" });
	const ctx = queuedApprovalContext(cwd, [{ choice: "deny" }]);
	const abortController = new AbortController();
	ctx.signal = abortController.signal;
	ctx.abort = () => {
		ctx.aborted = true;
		abortController.abort();
	};
	const first = manager.authorize(policy, unknownCommandRequest(cwd, policy, "denied-a"), ctx);
	const second = manager.authorize(policy, unknownCommandRequest(cwd, policy, "denied-b"), ctx);
	const [firstResult, secondResult] = await Promise.all([first, second]);
	assert(firstResult.decision.kind === "block", "a denied approval should block its request");
	assert(secondResult.decision.kind === "block", "a queued request should block after the agent operation is aborted");
	assert(secondResult.decision.reason === "authorization cancelled", "a queued request should report cancellation after abort");
	assert(ctx.prompts === 1, "denying one parallel approval should not open selectors for cancelled queued requests");
}

async function checkActiveApprovalClosesOnAbort(cwd: string, policy: EffectiveSafetyPolicy): Promise<void> {
	const abortController = new AbortController();
	const ctx = approvalContext(cwd, () => {
		throw new Error("component-aware custom UI should control this result");
	});
	ctx.signal = abortController.signal;
	ctx.ui.custom = <T,>(factory: ApprovalComponentFactory<T>): Promise<T> => {
		ctx.prompts += 1;
		return new Promise<T>((resolve, reject) => {
			Promise.resolve(
				factory(
					{} as Parameters<typeof factory>[0],
					{} as Parameters<typeof factory>[1],
					{} as Parameters<typeof factory>[2],
					resolve,
				),
			).catch(reject);
		});
	};
	const authorization = new ApprovalManager(cwd, { persistence: "session" }).authorize(
		policy,
		unknownCommandRequest(cwd, policy, "aborted-active-prompt"),
		ctx,
	);
	await waitForPromptCount(ctx, 1);
	abortController.abort();
	const result = await authorization;
	assert(result.decision.kind === "block", "aborting an active approval should block its request");
	assert(result.decision.reason === "user interrupted approval prompt", "an aborted prompt should resolve as interrupted");
	assert(ctx.aborted, "an interrupted active prompt should abort the current agent operation");
}

async function checkNonTuiApprovalFailsClosed(cwd: string, policy: EffectiveSafetyPolicy): Promise<void> {
	const ctx = approvalContext(cwd, () => {
		throw new Error("non-TUI authorization must not open a custom component");
	});
	ctx.mode = "rpc";
	const result = await new ApprovalManager(cwd, { persistence: "session" }).authorize(
		policy,
		unknownCommandRequest(cwd, policy, "rpc-approval"),
		ctx,
	);
	assert(result.decision.kind === "block", "non-TUI approval requirements should fail closed");
	assert(
		result.decision.reason === "approval required but no interactive UI is available",
		"non-TUI approval failures should explain that interactive approval is unavailable",
	);
	assert(ctx.prompts === 0, "non-TUI approval requirements should not invoke the custom component API");
	assert(!ctx.aborted, "non-TUI approval failures should not abort through a nonexistent prompt");
}

function unknownCommandRequest(cwd: string, policy: EffectiveSafetyPolicy, command: string) {
	return requestFromBashLaunch(
		{
			type: "bash_launch",
			shell: "bash",
			home: "/synthetic/home",
			pathStyle: "posix",
			source: "tool",
			id: `bash-${command}`,
			submittedCommand: command,
			command,
			cwd,
			operationsKind: "local",
		} satisfies BashLaunchEvent,
		policy,
	);
}

async function checkSessionOnlyApprovalPersistence(
	cwd: string,
	policy: EffectiveSafetyPolicy,
): Promise<void> {
	const request = requestFromBashLaunch(
		{
			type: "bash_launch",
			shell: "bash",
			home: "/synthetic/home",
			pathStyle: "posix",
			source: "tool",
			id: "bash-zdr-session-approval",
			submittedCommand: "tool-a",
			command: "tool-a",
			cwd,
			operationsKind: "local",
		} satisfies BashLaunchEvent,
		policy,
	);
	const manager = new ApprovalManager(cwd, { persistence: "session" });
	const evaluated = manager.evaluate(policy, request);
	assert(evaluated.decision.kind === "ask", "session-only approval check should begin with an approval prompt");
	const choices = approvalOptions(evaluated.decision, "session");
	assert(
		choices.map((choice) => choice.value).join(",") === "allow_once,allow_session,deny",
		"session-only prompts should not offer workspace persistence",
	);
	assert(choices[1]?.label.includes("not saved"), "session-only prompts should explain that the approval is not saved");
	assert(
		approvalOptions(evaluated.decision, "workspace").some((choice) => choice.value === "allow_workspace"),
		"workspace-persistent prompts should offer workspace approval",
	);

	const firstContext = queuedApprovalContext(cwd, [{ choice: "allow_workspace" }], true);
	const firstAuthorization = await manager.authorize(policy, request, firstContext);
	assert(firstAuthorization.decision.kind === "allow", "unavailable workspace approval should fall back to a session approval");
	assert(firstContext.prompts === 1, "session fallback should require one prompt");
	assert(!firstContext.aborted, "session fallback should not abort the agent");
	assert(manager.saveableSessionApprovals() === undefined, "session-only approvals should not be saveable");
	assert(manager.saveSessionApprovalsToWorkspace().kind === "unavailable", "session-only approval saving should be unavailable");

	const repeatedContext = queuedApprovalContext(cwd, [], true);
	const repeatedAuthorization = await manager.authorize(policy, request, repeatedContext);
	assert(repeatedAuthorization.decision.kind === "allow", "session approval should authorize the repeated request");
	assert(repeatedContext.prompts === 0, "session approval should suppress repeated prompts for the live session");
}

async function checkZdrControllerDoesNotPersist(cwd: string, tempDir: string): Promise<void> {
	const agentDir = join(tempDir, "zdr-agent");
	const controller = SafetyController.create({
		agentDir,
		cwd,
		clientZdr: true,
		enabledOverride: true,
		profileOverride: "watch",
	});
	const event = {
		type: "bash_launch",
		shell: "bash",
		home: "/synthetic/home",
		pathStyle: "posix",
		source: "tool",
		id: "bash-zdr-controller",
		submittedCommand: "tool-a",
		command: "tool-a",
		cwd,
		operationsKind: "local",
	} satisfies BashLaunchEvent;
	const firstContext = queuedApprovalContext(cwd, [{ choice: "allow_session" }], true);
	const firstResult = await controller.handleBashLaunch(event, firstContext);
	assert(firstResult === undefined, "ZDR controller should allow a session-approved request");
	assert(!existsSync(controller.paths().workspaceStatePath), "ZDR controller should not create workspace approval state");
	assert(!existsSync(controller.paths().auditDir), "ZDR controller should not create audit state");
	assert(!controller.auditRecordingEnabled(), "ZDR controller should report audit recording as disabled");
	assert(controller.saveSessionApprovalsToWorkspace().kind === "unavailable", "ZDR controller should reject approval persistence");

	const repeatedContext = queuedApprovalContext(cwd, [], true);
	const repeatedResult = await controller.handleBashLaunch({ ...event, id: "bash-zdr-controller-repeat" }, repeatedContext);
	assert(repeatedResult === undefined, "ZDR controller should reuse a session approval");
	assert(repeatedContext.prompts === 0, "ZDR controller should not repeat a session-approved prompt");
	assert(!existsSync(controller.paths().workspaceStatePath), "ZDR session approval reuse should remain in memory");
	assert(!existsSync(controller.paths().auditDir), "ZDR session approval reuse should not write audit state");
}

async function checkPathThenCommandAuthorization(cwd: string, policy: EffectiveSafetyPolicy, tempDir: string): Promise<void> {
	const debugPath = join(tempDir, "debug.cpp");
	const request = requestFromToolCall(
		{
			type: "tool_call",
			toolName: "bash",
			toolCallId: "bash-auth-flow",
			input: { command: `cat > ${debugPath} << 'EOF'\nint main() { return 0; }\nEOF\nclang++ ${debugPath}` },
		} satisfies ToolCallEvent,
		cwd,
		policy,
	);
	const ctx = queuedApprovalContext(cwd, [{ choice: "allow_once" }, { choice: "allow_once" }]);
	const manager = workspaceApprovalManager(cwd, join(tempDir, "path-then-command-grants.json"));

	const authorization = await manager.authorize(policy, request, ctx);

	assert(authorization.decision.kind === "allow", "path then command approvals should authorize the request");
	assert(authorization.decision.reason.includes("command approved once"), "authorization should preserve command approval reason");
	assert(authorization.decision.reason.includes("path grant matched"), "authorization should preserve path grant reason");
	assert(authorization.executionGrants.commandApproved, "authorization should record command approval");
	assert(authorization.executionGrants.pathGrants.length === 1, "authorization should retain the request-local path approval");
	assert(ctx.prompts === 2, "authorization should prompt for both path access and command approval");
	assert(!ctx.aborted, "successful approval flow should not abort");
}

async function checkPersistentCommandApprovalsAdvance(cwd: string, policy: EffectiveSafetyPolicy, tempDir: string): Promise<void> {
	const request = requestFromToolCall(
		{
			type: "tool_call",
			toolName: "bash",
			toolCallId: "bash-persistent-command-advance",
			input: { command: "tool-a && tool-b" },
		} satisfies ToolCallEvent,
		cwd,
		policy,
	);
	const ctx = queuedApprovalContext(cwd, [{ choice: "allow_workspace" }, { choice: "allow_workspace" }]);
	const manager = workspaceApprovalManager(cwd, join(tempDir, "persistent-command-advance.json"));

	const authorization = await manager.authorize(policy, request, ctx);

	assert(authorization.decision.kind === "allow", "persistent command approvals should advance across segments");
	assert(ctx.prompts === 2, "persistent command approvals should prompt once per uncovered segment");
	assert(!ctx.aborted, "persistent command approval flow should not abort");
}

async function checkUnpersistableCommandRemainder(cwd: string, policy: EffectiveSafetyPolicy, tempDir: string): Promise<void> {
	const request = requestFromToolCall(
		{
			type: "tool_call",
			toolName: "bash",
			toolCallId: "bash-unpersistable-command-remainder",
			input: { command: "tool-a && bash script.sh" },
		} satisfies ToolCallEvent,
		cwd,
		policy,
	);
	const ctx = queuedApprovalContext(cwd, [{ choice: "allow_workspace" }, { choice: "allow_once" }]);
	const manager = workspaceApprovalManager(cwd, join(tempDir, "unpersistable-command-remainder.json"));

	const authorization = await manager.authorize(policy, request, ctx);

	assert(authorization.decision.kind === "allow", "unpersistable command remainders should allow once after earlier grants");
	assert(ctx.prompts === 2, "unpersistable command remainders should be prompted after covered segments are skipped");
	assert(!ctx.aborted, "unpersistable command remainder flow should not abort");
}

async function checkDangerousCommandHasNoPersistentGrant(cwd: string, policy: EffectiveSafetyPolicy, tempDir: string): Promise<void> {
	const guardedPolicy: EffectiveSafetyPolicy = { ...policy, reins: { ...policy.reins, mode: "guarded" } };
	const request = requestFromToolCall(
		{
			type: "tool_call",
			toolName: "bash",
			toolCallId: "bash-dangerous-command-persistent-grant",
			input: { command: "tool-a | python3 -c 'print(1)'" },
		} satisfies ToolCallEvent,
		cwd,
		guardedPolicy,
	);
	const manager = workspaceApprovalManager(cwd, join(tempDir, "dangerous-command-persistent-grant.json"));

	const evaluated = manager.evaluate(guardedPolicy, request);

	assert(evaluated.decision.kind === "ask", "guarded dangerous commands should ask for approval");
	assert(evaluated.decision.requirement?.type === "command", "guarded dangerous commands should ask for command approval");
	assert(!evaluated.decision.requirement.candidate, "dangerous compound commands should not offer persistent grants");
}

async function checkSyntheticProtectedPathBlocksWithoutPrompt(
	cwd: string,
	policy: EffectiveSafetyPolicy,
	tempDir: string,
): Promise<void> {
	const secretPath = join(tempDir, "fake-secret.txt");
	writeFileSync(secretPath, "synthetic secret\n", "utf-8");
	const protectedPolicy: EffectiveSafetyPolicy = {
		...policy,
		protectedPaths: [...policy.protectedPaths, secretPath],
	};
	const request = requestFromToolCall(
		{
			type: "tool_call",
			toolName: "bash",
			toolCallId: "bash-fake-secret",
			input: { command: `cat ${secretPath}` },
		} satisfies ToolCallEvent,
		cwd,
		protectedPolicy,
	);
	const ctx = queuedApprovalContext(cwd, [{ choice: "allow_once" }]);
	const manager = workspaceApprovalManager(cwd, join(tempDir, "protected-grants.json"));

	const authorization = await manager.authorize(protectedPolicy, request, ctx);

	assert(authorization.decision.kind === "block", "synthetic protected paths should block before approval");
	assert(ctx.prompts === 0, "synthetic protected path block should not prompt");
	assert(!ctx.aborted, "pre-prompt protected path blocks should not abort the agent");
}

async function checkApprovalInterruptAborts(cwd: string, policy: EffectiveSafetyPolicy, tempDir: string): Promise<void> {
	const outputPath = join(tempDir, "interrupt-output.txt");
	const request = requestFromToolCall(
		{
			type: "tool_call",
			toolName: "bash",
			toolCallId: "bash-interrupt",
			input: { command: `printf nope > ${outputPath}` },
		} satisfies ToolCallEvent,
		cwd,
		policy,
	);
	const ctx = queuedApprovalContext(cwd, [{ choice: "interrupt" }]);
	const manager = workspaceApprovalManager(cwd, join(tempDir, "interrupt-grants.json"));

	const authorization = await manager.authorize(policy, request, ctx);

	assert(authorization.decision.kind === "block", "approval interrupt should block the request");
	assert(authorization.decision.reason === "user interrupted approval prompt", "approval interrupt should use a clear reason");
	assert(ctx.aborted, "approval interrupt should abort the agent");
	assert(ctx.prompts === 1, "interrupt scenario should prompt once");
}

type QueuedApprovalContext = ExtensionContext & {
	aborted: boolean;
	prompts: number;
};

type ApprovalComponentFactory<T> = (
	tui: TUI,
	theme: Theme,
	keybindings: KeybindingsManager,
	done: (result: T) => void,
) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>;

function queuedApprovalContext(cwd: string, results: ApprovalResult[], clientZdr = false): QueuedApprovalContext {
	return approvalContext(cwd, () => nextApproval(results), clientZdr);
}

function approvalContext(
	cwd: string,
	next: () => ApprovalResult | Promise<ApprovalResult>,
	clientZdr = false,
): QueuedApprovalContext {
	const ctx: QueuedApprovalContext = {
		aborted: false,
		prompts: 0,
		mode: "tui",
		ui: {
			select: async () => undefined,
			confirm: async () => false,
			input: async () => undefined,
			notify: () => undefined,
			onTerminalInput: () => () => undefined,
			setStatus: () => undefined,
			setWorkingMessage: () => undefined,
			setWorkingVisible: () => undefined,
			setWorkingIndicator: () => undefined,
			setHiddenThinkingLabel: () => undefined,
			setWidget: () => undefined,
			setFooter: () => undefined,
			setHeader: () => undefined,
			setTitle: () => undefined,
			custom: async <T,>() => {
				ctx.prompts += 1;
				return (await next()) as T;
			},
			pasteToEditor: () => undefined,
			setEditorText: () => undefined,
			getEditorText: () => "",
			editor: async () => undefined,
			addAutocompleteProvider: () => undefined,
			setEditorComponent: () => undefined,
			getEditorComponent: () => undefined,
			theme: {} as ExtensionContext["ui"]["theme"],
			getAllThemes: () => [],
			getTheme: () => undefined,
			setTheme: () => ({ success: false, error: "unsupported in check context" }),
			getToolsExpanded: () => false,
			setToolsExpanded: () => undefined,
		},
		hasUI: true,
		cwd,
		isProjectTrusted: () => true,
		privacy: { clientZdr, remoteZdr: clientZdr },
		scopedModels: [],
		sessionManager: {} as ExtensionContext["sessionManager"],
		modelRegistry: {} as ExtensionContext["modelRegistry"],
		model: undefined,
		isIdle: () => true,
		signal: undefined,
		abort: () => {
			ctx.aborted = true;
		},
		hasPendingMessages: () => false,
		shutdown: () => undefined,
		getContextUsage: () => undefined,
		compact: () => undefined,
		getSystemPrompt: () => "",
		getSystemPromptOptions: () => ({ cwd }),
		writeOutputFile: async () => { throw new Error("Unexpected output file in approval fixture"); },
	};
	return ctx;
}

function nextApproval(results: ApprovalResult[]): ApprovalResult {
	const result = results.shift();
	if (!result) throw new Error("approval flow requested more prompts than expected");
	return result;
}

class ApprovalPromptProbe {
	active = 0;
	maxActive = 0;
	private readonly pending: Array<(result: ApprovalResult) => void> = [];

	open(): Promise<ApprovalResult> {
		this.active += 1;
		this.maxActive = Math.max(this.maxActive, this.active);
		return new Promise((resolve) => {
			this.pending.push((result) => {
				this.active -= 1;
				resolve(result);
			});
		});
	}

	resolveNext(result: ApprovalResult): void {
		const resolve = this.pending.shift();
		if (!resolve) throw new Error("no approval prompt is pending");
		resolve(result);
	}
}

async function waitForPromptCount(ctx: QueuedApprovalContext, count: number): Promise<void> {
	for (let attempt = 0; attempt < 50; attempt += 1) {
		if (ctx.prompts >= count) return;
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	throw new Error(`timed out waiting for ${count} approval prompts; saw ${ctx.prompts}`);
}

function workspaceApprovalManager(cwd: string, workspaceStatePath: string): ApprovalManager {
	return new ApprovalManager(cwd, { persistence: "workspace", workspaceStatePath });
}
