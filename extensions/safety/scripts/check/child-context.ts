import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	BashLaunchEvent,
	ExtensionContext,
	ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import type { WorkspaceFileOperations } from "../../../shared/active-workspace.ts";
import type { ChildRunIntent } from "../../../shared/child-runtime.ts";
import type { ToolEffectObserver } from "../../../shared/tool-effects.ts";
import {
	parseSafetyChildContext,
	readSafetyChildContext,
} from "../../src/child/context.js";
import { createSafetyChildPolicyContributor } from "../../src/child/contributor.js";
import { readProvidedProjectSafetyConfig } from "../../src/child/project-config.js";
import { loadSafetyConfig } from "../../src/config/load.js";
import { mergeUserConfig } from "../../src/config/merge.js";
import { SafetyController } from "../../src/controller/controller.js";
import { assert } from "./assert.js";

export async function checkChildContext(): Promise<void> {
	const runtimeRoot = mkdtempSync(join(tmpdir(), "pi-safety-child-context-"));
	try {
		const agentDir = join(runtimeRoot, "agent");
		const parentRoot = join(runtimeRoot, "parent-workspace");
		const childRoot = join(runtimeRoot, "child-workspace");
		mkdirSync(join(parentRoot, ".git"), { recursive: true });
		mkdirSync(join(childRoot, ".git"), { recursive: true });
		const canonicalChildRoot = realpathSync(childRoot);

		const parent = SafetyController.create({
			agentDir,
			cwd: parentRoot,
			clientZdr: false,
			enabledOverride: true,
			profileOverride: "watch",
			toolEffects: subagentEffects,
		});
		const parentContext = approvalContext(parentRoot, [
			{ choice: "allow_once" },
		]);
		const toolCallId = "delegated-read";
		const parentResult = await parent.handleToolCall(
			{
				type: "tool_call",
				toolName: "subagent",
				toolCallId,
				input: {
					commissions: [
						{
							task: "Inspect the child workspace",
							cwd: childRoot,
							tools: ["read", "grep"],
						},
					],
				},
			} satisfies ToolCallEvent,
			parentContext,
		);
		assert(
			parentResult === undefined,
			"parent Safety should authorize the explicitly approved child workspace",
		);
		assert(
			parentContext.prompts === 1,
			"the parent should ask once for the external child workspace",
		);

		const intent: ChildRunIntent = {
			origin: { kind: "tool", toolCallId },
			runId: "child-run",
			batchId: "child-batch",
			cwd: canonicalChildRoot,
			model: "provider/model",
			provider: "provider",
			tools: ["read", "grep"],
			capabilities: ["read_files", "list_files"],
			references: [],
			privacy: { clientZdr: false, remoteZdr: false },
		};
		const inherited = parent.childContext(intent);
		const interactiveInherited = parent.childContext({
			...intent,
			origin: { kind: "interactive" },
		});
		assert(
			interactiveInherited.policy.profile === "watch" &&
				interactiveInherited.grants.length === 0,
			"an interactive managed child should inherit policy without fabricating parent tool authorization",
		);
		assert(
			inherited.policy.profile === "watch",
			"the child should inherit the parent's effective Safety profile",
		);
		assert(
			inherited.policy.reins.mode === "guarded",
			"the child should inherit the parent's exact Reins mode",
		);
		assert(
			inherited.policy.containment.mode === "off",
			"the child should inherit the parent's exact containment mode",
		);
		assert(
			inherited.grants.some(
				(grant) =>
					grant.type === "pathAccess" &&
					grant.roots.includes(canonicalChildRoot),
			),
			"the child should receive the path grant that authorized its delegated workspace",
		);
		assert(
			parseSafetyChildContext(JSON.parse(JSON.stringify(inherited))) !==
				undefined,
			"the inherited context should round-trip through its versioned schema",
		);
		const writeToolCallId = "delegated-write";
		const writeParentContext = approvalContext(parentRoot, [
			{ choice: "allow_once" },
			{ choice: "allow_once" },
		]);
		const writeParentResult = await parent.handleToolCall(
			{
				type: "tool_call",
				toolName: "subagent",
				toolCallId: writeToolCallId,
				input: {
					commissions: [
						{
							task: "Edit the child workspace",
							cwd: childRoot,
							tools: ["read", "edit", "write"],
						},
					],
				},
			} satisfies ToolCallEvent,
			writeParentContext,
		);
		assert(
			writeParentResult === undefined,
			"parent Safety should authorize an explicitly approved write-capable child",
		);
		assert(
			writeParentContext.prompts === 2,
			"write-capable delegation should approve its shared path scope and the launch action separately",
		);
		const writeInherited = parent.childContext({
			...intent,
			origin: { kind: "tool", toolCallId: writeToolCallId },
			tools: ["read", "edit", "write"],
			capabilities: ["read_files", "write_files"],
		});
		assert(
			writeInherited.grants.every((grant) => grant.type === "pathAccess"),
			"one-time approval for a child launch should transfer path scope without transferring command approval",
		);

		const siblingReadRoot = join(runtimeRoot, "sibling-read");
		const siblingWriteRoot = join(runtimeRoot, "sibling-write");
		mkdirSync(siblingReadRoot);
		mkdirSync(siblingWriteRoot);
		const canonicalSiblingReadRoot = realpathSync(siblingReadRoot);
		const canonicalSiblingWriteRoot = realpathSync(siblingWriteRoot);
		const siblingToolCallId = "delegated-siblings";
		const siblingContext = approvalContext(parentRoot, [
			{ choice: "allow_once" },
			{ choice: "allow_once" },
			{ choice: "allow_once" },
		]);
		const siblingResult = await parent.handleToolCall(
			{
				type: "tool_call",
				toolName: "subagent",
				toolCallId: siblingToolCallId,
				input: {
					commissions: [
						{ task: "Read one workspace", cwd: siblingReadRoot, tools: ["read"] },
						{ task: "Write another workspace", cwd: siblingWriteRoot, tools: ["write"] },
					],
				},
			} satisfies ToolCallEvent,
			siblingContext,
		);
		assert(siblingResult === undefined, "parent Safety should authorize the two-child batch");
		const siblingBaseIntent: ChildRunIntent = {
			origin: { kind: "tool", toolCallId: siblingToolCallId },
			runId: "sibling-read-run",
			batchId: "sibling-batch",
			cwd: canonicalSiblingReadRoot,
			model: "provider/model",
			provider: "provider",
			tools: ["read"],
			capabilities: ["read_files"],
			references: [],
			privacy: { clientZdr: false, remoteZdr: false },
		};
		const siblingReadContext = parent.childContext(siblingBaseIntent);
		const siblingWriteContext = parent.childContext({
			...siblingBaseIntent,
			runId: "sibling-write-run",
			cwd: canonicalSiblingWriteRoot,
			tools: ["write"],
			capabilities: ["write_files"],
		});
		const readExecutionGrants = siblingReadContext.grants.filter((grant) => grant.type === "pathAccess");
		const writeExecutionGrants = siblingWriteContext.grants.filter((grant) => grant.type === "pathAccess");
		assert(
			readExecutionGrants.length > 0 &&
				readExecutionGrants.every(
					(grant) =>
						grant.roots.length === 1 &&
						grant.roots[0] === canonicalSiblingReadRoot &&
						grant.operations.every((operation) => operation === "read"),
				),
			"the read child should inherit only its own read execution grant",
		);
		assert(
			writeExecutionGrants.length > 0 &&
				writeExecutionGrants.every(
					(grant) =>
						grant.roots.length === 1 &&
						grant.roots[0] === canonicalSiblingWriteRoot &&
						grant.operations.every((operation) => operation === "write"),
				),
			"the write child should inherit only its own write execution grant",
		);

		const reusableParent = SafetyController.create({
			agentDir,
			cwd: parentRoot,
			clientZdr: false,
			enabledOverride: true,
			profileOverride: "watch",
			toolEffects: subagentEffects,
		});
		const reusableToolCallId = "delegated-reusable-siblings";
		const reusableContext = approvalContext(parentRoot, [
			{ choice: "allow_session" },
			{ choice: "allow_session" },
			{ choice: "allow_once" },
		]);
		const reusableResult = await reusableParent.handleToolCall(
			{
				type: "tool_call",
				toolName: "subagent",
				toolCallId: reusableToolCallId,
				input: {
					commissions: [
						{ task: "Read one workspace", cwd: siblingReadRoot, tools: ["read"] },
						{ task: "Write another workspace", cwd: siblingWriteRoot, tools: ["write"] },
					],
				},
			} satisfies ToolCallEvent,
			reusableContext,
		);
		assert(reusableResult === undefined, "parent Safety should authorize reusable sibling scopes");
		const reusableRead = reusableParent.childContext({
			...siblingBaseIntent,
			origin: { kind: "tool", toolCallId: reusableToolCallId },
		});
		const reusableWrite = reusableParent.childContext({
			...siblingBaseIntent,
			origin: { kind: "tool", toolCallId: reusableToolCallId },
			runId: "reusable-write-run",
			cwd: canonicalSiblingWriteRoot,
			tools: ["write"],
			capabilities: ["write_files"],
		});
		assert(
			reusableRead.grants.every(
				(grant) =>
					grant.type === "pathAccess" &&
					grant.roots.length === 1 &&
					grant.roots[0] === canonicalSiblingReadRoot &&
					grant.operations.every((operation) => operation === "read"),
			),
			"the read child should inherit only its applicable reusable read grant",
		);
		assert(
			reusableWrite.grants.every(
				(grant) =>
					grant.type === "pathAccess" &&
					grant.roots.length === 1 &&
					grant.roots[0] === canonicalSiblingWriteRoot &&
					grant.operations.every((operation) => operation === "write"),
			),
			"the write child should inherit only its applicable reusable write grant",
		);

		const networkToolCallId = "delegated-network-tool";
		const networkContext = approvalContext(parentRoot, [{ choice: "allow_once" }]);
		const networkResult = await parent.handleToolCall(
			{
				type: "tool_call",
				toolName: "subagent",
				toolCallId: networkToolCallId,
				input: {
					commissions: [
						{ task: "Research a public topic", cwd: childRoot, tools: ["web_search"] },
					],
				},
			} satisfies ToolCallEvent,
			networkContext,
		);
		assert(networkResult === undefined, "parent Safety should authorize the network-capable commission");
		const networkInherited = parent.childContext({
			...intent,
			origin: { kind: "tool", toolCallId: networkToolCallId },
			tools: ["web_search"],
			capabilities: ["network"],
		});
		assert(
			networkInherited.approvedTools.length === 1 &&
				networkInherited.approvedTools[0] === "web_search",
			"the exact approved extension tool should follow the child commission",
		);
		const networkChild = SafetyController.create({
			agentDir,
			cwd: childRoot,
			clientZdr: false,
			ephemeral: true,
			initialGrants: networkInherited.grants,
			approvedTools: networkInherited.approvedTools,
			inheritedConfig: networkInherited.policy,
			toolEffects: networkToolEffects,
			enabledOverride: false,
		});
		const approvedNetworkCall = await networkChild.handleToolCall(
			{
				type: "tool_call",
				toolName: "web_search",
				toolCallId: "child-web-search",
				input: { query: "public topic" },
			} satisfies ToolCallEvent,
			noninteractiveContext(childRoot),
		);
		assert(
			approvedNetworkCall === undefined,
			"the noninteractive child should use the exact network tool approved with its commission",
		);
		const unapprovedNetworkCall = await networkChild.handleToolCall(
			{
				type: "tool_call",
				toolName: "web_fetch",
				toolCallId: "child-web-fetch",
				input: { url: "https://example.invalid" },
			} satisfies ToolCallEvent,
			noninteractiveContext(childRoot),
		);
		assert(
			unapprovedNetworkCall?.block === true,
			"an unapproved sibling network tool should still fail closed in the child",
		);

		const contributor = createSafetyChildPolicyContributor({
			extensionPath: "/extensions/safety",
			contextFor: () => inherited,
		});
		const contribution = await contributor.prepare(intent);
		assert(
			contribution !== undefined,
			"Safety should contribute a child runtime policy",
		);
		const contextFlag = contribution.args.indexOf("--safety-context");
		const contextPath = contribution.args[contextFlag + 1];
		assert(
			contextFlag >= 0 && contextPath !== undefined,
			"the child contribution should carry a context path",
		);
		assert(
			readSafetyChildContext(contextPath).policy.profile === "watch",
			"the child should read the contributed context file",
		);
		await contribution.dispose();
		assert(
			!existsSync(contextPath),
			"disposing the contribution should remove its ephemeral context file",
		);

		const child = SafetyController.create({
			agentDir,
			cwd: childRoot,
			clientZdr: false,
			ephemeral: true,
			initialGrants: inherited.grants,
			inheritedConfig: inherited.policy,
			enabledOverride: false,
		});
		assert(
			child.policy().workspaceRoot === canonicalChildRoot,
			"the inherited policy should retarget to the child's workspace root",
		);
		assert(
			child.policy().profile === "watch",
			"retargeting should preserve the inherited Safety profile",
		);
		const childResult = await child.handleToolCall(
			{
				type: "tool_call",
				toolName: "read",
				toolCallId: "child-read",
				input: { path: join(childRoot, "source.txt") },
			} satisfies ToolCallEvent,
			noninteractiveContext(childRoot),
		);
		assert(
			childResult === undefined,
			"the inherited child policy should allow an ordinary read in its delegated workspace",
		);
		assert(
			!child.auditRecordingEnabled(),
			"an ephemeral child should not persist a separate audit trail",
		);

		const disabled = loadSafetyConfig({
			agentDir,
			cwd: childRoot,
			enabledOverride: true,
			inheritedConfig: mergeUserConfig(undefined, false),
		});
		assert(
			!disabled.policy.enabled,
			"an inherited disabled policy should remain disabled despite local enable flags",
		);
		const disabledChild = SafetyController.create({
			agentDir,
			cwd: childRoot,
			clientZdr: false,
			ephemeral: true,
			inheritedConfig: disabled.policy,
			enabledOverride: true,
		});
		const disabledBash = await disabledChild.handleBashLaunch(
			{
				type: "bash_launch",
				shell: "bash",
				home: "/synthetic/home",
				pathStyle: "posix",
				source: "tool",
				id: "disabled-child-command",
				submittedCommand: "printf ok",
				command: "printf ok",
				cwd: childRoot,
				operationsKind: "local",
			} satisfies BashLaunchEvent,
			noninteractiveContext(childRoot),
		);
		assert(
			disabledBash === undefined,
			"a disabled inherited policy should not require a containment backend in the child",
		);

		const inactiveParent = SafetyController.create({
			agentDir,
			cwd: parentRoot,
			clientZdr: false,
			enabledOverride: true,
			profileOverride: "watch",
		});
		inactiveParent.setEnabled(false);
		const rebuiltInactiveParent = SafetyController.create({
			agentDir,
			cwd: parentRoot,
			clientZdr: false,
			enabledOverride: true,
			profileOverride: "watch",
			sessionSettings: inactiveParent.sessionSettingsSnapshot(),
		});
		const inactiveInherited = rebuiltInactiveParent.childContext({
			...intent,
			origin: { kind: "tool", toolCallId: "inactive-parent-child" },
		});
		assert(
			!inactiveInherited.policy.enabled,
			"a child should inherit the parent's live disabled state after controller reconstruction",
		);

		const inactiveTightenedRoot = join(runtimeRoot, "inactive-tightened-workspace");
		mkdirSync(join(inactiveTightenedRoot, ".git"), { recursive: true });
		mkdirSync(join(inactiveTightenedRoot, ".pi"), { recursive: true });
		writeFileSync(
			join(inactiveTightenedRoot, ".pi", "safety.json"),
			`${JSON.stringify({ require: { profile: "guarded" } })}\n`,
		);
		const inactiveTightened = loadSafetyConfig({
			agentDir,
			cwd: inactiveTightenedRoot,
			enabledOverride: true,
			inheritedConfig: inactiveInherited.policy,
		});
		assert(
			!inactiveTightened.policy.enabled &&
				inactiveTightened.policy.profile === "guarded",
			"target policy may tighten an inherited policy without activating disabled Safety",
		);
		const activeSettingsParent = SafetyController.create({
			agentDir,
			cwd: parentRoot,
			clientZdr: false,
			enabledOverride: true,
			profileOverride: "watch",
		});
		activeSettingsParent.setProfile("watch");
		const activeTightened = SafetyController.create({
			agentDir,
			cwd: inactiveTightenedRoot,
			clientZdr: false,
			enabledOverride: false,
			sessionSettings: activeSettingsParent.sessionSettingsSnapshot(),
		});
		assert(
			activeTightened.policy().enabled &&
				activeTightened.policy().profile === "guarded",
			"session settings should survive reconstruction without weakening target-project policy",
		);

		const tightenedRoot = join(runtimeRoot, "tightened-workspace");
		mkdirSync(join(tightenedRoot, ".git"), { recursive: true });
		mkdirSync(join(tightenedRoot, ".pi"), { recursive: true });
		writeFileSync(
			join(tightenedRoot, ".pi", "safety.json"),
			`${JSON.stringify({ require: { network: "none" } })}\n`,
		);
		const tightened = loadSafetyConfig({
			agentDir,
			cwd: tightenedRoot,
			enabledOverride: false,
			inheritedConfig: inherited.policy,
		});
		assert(
			tightened.policy.containment.network === "none",
			"the target project should be able to tighten inherited child policy",
		);
		assert(
			tightened.policy.reins.mode === inherited.policy.reins.mode,
			"target tightening should preserve unrelated inherited policy",
		);

		const providedConfigPath = "/workspace/project/.pi/safety.json";
		const providedProject = await readProvidedProjectSafetyConfig(
			providedFiles(providedConfigPath, { require: { network: "none" } }),
			"/workspace/project/src",
			"/workspace",
		);
		assert(
			providedProject?.path === providedConfigPath,
			"provided workspace tightening should be discovered from the child cwd",
		);
		const providedContext = parent.childContext(intent, providedProject);
		assert(
			parseSafetyChildContext(JSON.parse(JSON.stringify(providedContext)))
				?.project?.path === providedConfigPath,
			"provided project tightening should round-trip in child context",
		);
		assert(
			parseSafetyChildContext({
				...providedContext,
				project: {
					path: providedConfigPath,
					config: { require: { network: "invalid" } },
				},
			}) === undefined,
			"invalid provided project tightening should fail strict child-context parsing",
		);
		let invalidProjectError = "";
		try {
			await readProvidedProjectSafetyConfig(
				providedFiles(providedConfigPath, { require: { network: "invalid" } }),
				"/workspace/project/src",
				"/workspace",
			);
		} catch (error) {
			invalidProjectError =
				error instanceof Error ? error.message : String(error);
		}
		assert(
			invalidProjectError.includes("invalid require.network"),
			"invalid provided workspace tightening should fail before child launch",
		);
		const providedChild = SafetyController.create({
			agentDir,
			cwd: parentRoot,
			workspace: {
				cwd: "/workspace/project/src",
				root: "/workspace/project",
				home: "/home/remote",
			},
			clientZdr: false,
			ephemeral: true,
			inheritedConfig: providedContext.policy,
			inheritedProjectConfig: providedContext.project?.config,
			inheritedProjectConfigPath: providedContext.project?.path,
			enabledOverride: false,
		});
		assert(
			providedChild.policy().containment.network === "none",
			"provided target project policy should tighten the inherited child policy",
		);
		assert(
			providedChild.policy().configPaths.includes(providedConfigPath),
			"provided target project policy source should remain observable",
		);
	} finally {
		rmSync(runtimeRoot, { recursive: true, force: true });
	}
}

function providedFiles(
	configPath: string,
	config: unknown,
): WorkspaceFileOperations {
	return {
		resolveEntry: async (path) => path,
		canonicalize: async (path) => path,
		exists: async (path) => path === configPath,
		read: async (path) => {
			if (path !== configPath)
				throw new Error(`unexpected provided read: ${path}`);
			return Buffer.from(JSON.stringify(config));
		},
		write: async () => undefined,
		ensureParent: async () => undefined,
		remove: async () => undefined,
		runExclusive: async (_path, operation) => operation(),
	};
}

const subagentEffects: ToolEffectObserver = {
	analyze(toolName, input) {
		if (toolName !== "subagent") return undefined;
		const commissions = Array.isArray(input?.commissions)
			? input.commissions
			: [];
		const effects = new Set<"run_command" | "read_files" | "list_files" | "write_files" | "network">(["run_command"]);
		const pathReferences: Array<{ path: string; operation: "read" | "list" | "write" }> = [];
		for (const commission of commissions) {
			if (typeof commission !== "object" || commission === null) continue;
			const value = commission as { cwd?: unknown; tools?: unknown };
			const cwd = typeof value.cwd === "string" ? value.cwd : ".";
			const tools = Array.isArray(value.tools) ? value.tools : [];
			if (tools.some((tool) => tool === "read" || tool === "grep")) {
				effects.add("read_files");
				pathReferences.push({ path: cwd, operation: "read" });
			}
			if (tools.some((tool) => tool === "grep" || tool === "find" || tool === "ls")) {
				effects.add("list_files");
				pathReferences.push({ path: cwd, operation: "list" });
			}
			if (tools.some((tool) => tool === "edit" || tool === "write")) {
				effects.add("write_files");
				pathReferences.push({ path: cwd, operation: "write" });
			}
			if (tools.some((tool) => tool === "web_search" || tool === "web_fetch")) {
				effects.add("network");
			}
		}
		const approvalRequired = effects.has("write_files") || effects.has("network");
		return {
			toolName,
			effects: [...effects],
			risk: approvalRequired ? "unknown" : "safe_read",
			pathInputs: [],
			pathReferences,
			known: true,
			reason: "resolved read-only child intent",
		};
	},
};

const networkToolEffects: ToolEffectObserver = {
	analyze(toolName) {
		if (toolName !== "web_search" && toolName !== "web_fetch") return undefined;
		return {
			toolName,
			effects: ["network"],
			risk: "unknown",
			pathInputs: [],
			known: true,
			reason: "public network access",
		};
	},
};

type ApprovalContext = ExtensionContext & { prompts: number };

function approvalContext(
	cwd: string,
	results: Array<{ choice: "allow_once" | "allow_session" }>,
): ApprovalContext {
	const context = baseContext(cwd, "tui") as ApprovalContext;
	context.prompts = 0;
	context.ui.custom = async <T>() => {
		context.prompts += 1;
		const result = results.shift();
		if (!result)
			throw new Error(
				"child context scenario requested an unexpected approval",
			);
		return result as T;
	};
	return context;
}

function noninteractiveContext(cwd: string): ExtensionContext {
	return baseContext(cwd, "json");
}

function baseContext(cwd: string, mode: "tui" | "json"): ExtensionContext {
	return {
		mode,
		hasUI: mode === "tui",
		cwd,
		ui: {
			custom: async () => {
				throw new Error("this scenario does not expect another approval");
			},
			notify: () => undefined,
		} as unknown as ExtensionContext["ui"],
		sessionManager: {} as ExtensionContext["sessionManager"],
		modelRegistry: {} as ExtensionContext["modelRegistry"],
		model: undefined,
		scopedModels: [],
		isIdle: () => true,
		isProjectTrusted: () => true,
		privacy: { clientZdr: false, remoteZdr: false },
		signal: undefined,
		abort: () => undefined,
		hasPendingMessages: () => false,
		shutdown: () => undefined,
		getContextUsage: () => undefined,
		compact: () => undefined,
		getSystemPrompt: () => "",
		getSystemPromptOptions: () => ({ cwd }),
		writeOutputFile: async () => { throw new Error("Unexpected output file in approval fixture"); },
	};
}
