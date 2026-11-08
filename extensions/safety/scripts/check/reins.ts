import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { analyzeAgentSearchTool } from "../../../agent-search/tool-effects.ts";
import type { ToolEffectObserver } from "../../../shared/tool-effects.ts";
import { requestFromToolCall } from "../../src/controller/request.js";
import { classifyPathAccess } from "../../src/paths/classify.js";
import { ApprovalManager } from "../../src/reins/approval-manager.js";
import { decideWithReins } from "../../src/reins/engine.js";
import type { PathGrant } from "../../src/reins/grant-types.js";
import type {
	PathAccessGrantCandidate,
	ReinsDecision,
} from "../../src/reins/types.js";
import { assert } from "./assert.js";
import type { CheckContext } from "./context.js";

const agentSearchEffects: ToolEffectObserver = {
	analyze(toolName, input) {
		if (toolName !== "web_search" && toolName !== "web_fetch") return undefined;
		return analyzeAgentSearchTool(toolName, input);
	},
};

export function checkReins({ cwd, loaded }: CheckContext): void {
	const outsideDir = mkdtempSync(join(tmpdir(), "pi-safety-reins-"));
	try {
		checkReinsWithTempPaths(cwd, loaded, outsideDir);
	} finally {
		rmSync(outsideDir, { recursive: true, force: true });
	}
}

function checkReinsWithTempPaths(
	cwd: string,
	loaded: CheckContext["loaded"],
	outsideDir: string,
): void {
	const protectedPath = classifyPathAccess(loaded.policy, "read", ".env");
	assert(
		!protectedPath.allowed && protectedPath.reason === "protected-path",
		".env should be protected",
	);

	for (const path of protectedPaths()) {
		const access = classifyPathAccess(loaded.policy, "list", path);
		assert(
			!access.allowed && access.reason === "protected-path",
			`${path} should be protected`,
		);
	}

	const homeEnvAccess = classifyPathAccess(
		loaded.policy,
		"list",
		"$HOME/Downloads",
	);
	assert(
		!homeEnvAccess.allowed && homeEnvAccess.reason === "protected-path",
		"$HOME/Downloads should be privacy protected",
	);
	assert(
		homeEnvAccess.protectedKind === "privacy",
		"$HOME/Downloads should be privacy-classified",
	);

	const historyAccess = classifyPathAccess(
		loaded.policy,
		"read",
		"~/.zsh_history",
	);
	assert(
		historyAccess.protectedKind === "secret",
		"shell history should be secret-classified",
	);

	const piAuthAccess = classifyPathAccess(
		loaded.policy,
		"read",
		"~/.pi/agent/auth.json",
	);
	assert(
		!piAuthAccess.allowed && piAuthAccess.protectedKind === "secret",
		"pi auth should be secret-protected",
	);

	for (const path of ["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/fd/1"]) {
		const access = classifyPathAccess(loaded.policy, "write", path);
		assert(
			access.allowed,
			`${path} writes should be treated as safe virtual path access`,
		);
	}
	const stdinAccess = classifyPathAccess(loaded.policy, "read", "/dev/stdin");
	assert(
		stdinAccess.allowed,
		"/dev/stdin reads should be treated as safe virtual path access",
	);
	const zeroReadAccess = classifyPathAccess(loaded.policy, "read", "/dev/zero");
	assert(
		zeroReadAccess.allowed,
		"/dev/zero reads should be treated as safe virtual path access",
	);

	const unsafeDeviceWriteRequest = requestFromToolCall(
		{
			type: "tool_call",
			toolName: "write",
			toolCallId: "write-dev-zero",
			input: { path: "/dev/zero", content: "x" },
		} satisfies ToolCallEvent,
		cwd,
		loaded.policy,
	);
	const unsafeDeviceWriteDecision = decideWithReins(
		loaded.policy,
		unsafeDeviceWriteRequest,
	);
	const unsafeDeviceWriteCandidate = pathRequirementCandidate(
		unsafeDeviceWriteDecision,
	);
	assert(
		unsafeDeviceWriteDecision.kind === "ask",
		"unsafe virtual path writes should ask for approval",
	);
	assert(
		unsafeDeviceWriteCandidate?.type === "pathAccess",
		"unsafe virtual path writes should offer path approval context",
	);
	assert(
		!unsafeDeviceWriteCandidate.roots.includes("/dev"),
		"unsafe virtual path writes should not offer broad /dev grants",
	);
	assert(
		unsafeDeviceWriteCandidate.scopes.length === 0,
		"unsafe virtual path writes should not offer reusable grants",
	);

	const workspaceRead = classifyPathAccess(
		loaded.policy,
		"read",
		"SECURITY.md",
	);
	assert(workspaceRead.allowed, "workspace SECURITY.md should be readable");

	const globalSkillRead = classifyPathAccess(
		loaded.policy,
		"read",
		"~/.agents/skills/example-skills/example/SKILL.md",
	);
	assert(globalSkillRead.allowed, "global skill files should be readable");

	const globalSkillWrite = classifyPathAccess(
		loaded.policy,
		"write",
		"~/.agents/skills/example-skills/example/SKILL.md",
	);
	assert(
		!globalSkillWrite.allowed,
		"global skill files should not be writable",
	);

	const readOnlyPolicy = {
		...loaded.policy,
		reins: { ...loaded.policy.reins, mode: "read-only" as const },
	};
	const editRequest = requestFromToolCall(
		{
			type: "tool_call",
			toolName: "edit",
			toolCallId: "edit-1",
			input: { path: "README.md", edits: [{ oldText: "x", newText: "y" }] },
		} satisfies ToolCallEvent,
		cwd,
		readOnlyPolicy,
	);
	assert(
		decideWithReins(readOnlyPolicy, editRequest).kind === "block",
		"read-only should block edit",
	);

	const protectedRequest = requestFromToolCall(
		{
			type: "tool_call",
			toolName: "read",
			toolCallId: "read-1",
			input: { path: ".env" },
		} satisfies ToolCallEvent,
		cwd,
		loaded.policy,
	);
	assert(
		decideWithReins(loaded.policy, protectedRequest).kind === "block",
		"protected file read should block",
	);

	const privacyReadRequest = requestFromToolCall(
		{
			type: "tool_call",
			toolName: "read",
			toolCallId: "read-privacy",
			input: { path: "~/Downloads/notes.txt" },
		} satisfies ToolCallEvent,
		cwd,
		loaded.policy,
	);
	const privacyReadDecision = decideWithReins(
		loaded.policy,
		privacyReadRequest,
	);
	assert(
		privacyReadDecision.kind === "ask",
		"privacy file read should ask for approval",
	);
	const privacyReadCandidate = pathRequirementCandidate(privacyReadDecision);
	assert(
		privacyReadCandidate?.type === "pathAccess",
		"privacy file read should offer a path grant",
	);
	assert(
		privacyReadCandidate.sensitivity === "privacy",
		"privacy path grant should be sensitivity-marked",
	);
	const privacyReadPath = privacyReadRequest.paths[0];
	assert(
		privacyReadPath !== undefined,
		"privacy file read should include a classified path",
	);
	assert(
		privacyReadCandidate.roots.includes(dirname(privacyReadPath.resolvedPath)),
		"privacy file read should offer the containing directory",
	);
	assert(
		privacyReadCandidate.scopes.includes("session"),
		"privacy file read should offer a session directory grant",
	);
	assert(
		!privacyReadCandidate.scopes.includes("workspace"),
		"privacy file read should not offer a workspace grant",
	);

	const outsideReadDir = join(outsideDir, "read");
	const outsideReadFile = join(outsideReadDir, "notes.txt");
	mkdirSync(outsideReadDir);
	writeFileSync(outsideReadFile, "notes\n", "utf-8");
	const outsideReadRequest = requestFromToolCall(
		{
			type: "tool_call",
			toolName: "read",
			toolCallId: "read-outside",
			input: { path: outsideReadFile },
		} satisfies ToolCallEvent,
		cwd,
		loaded.policy,
	);
	const outsideReadDecision = decideWithReins(
		loaded.policy,
		outsideReadRequest,
	);
	assert(
		outsideReadDecision.kind === "ask",
		"normal outside-root read should ask for path approval",
	);
	const outsideReadCandidate = pathRequirementCandidate(outsideReadDecision);
	assert(
		outsideReadCandidate?.type === "pathAccess",
		"normal outside-root read should offer a path grant",
	);
	assert(
		outsideReadCandidate.sensitivity === "normal",
		"normal outside-root read grant should be normal sensitivity",
	);
	assert(
		outsideReadCandidate.roots.includes(realpathSync(outsideReadDir)),
		"normal outside-root read should offer the containing directory",
	);

	const tmpListRequest = requestFromToolCall(
		{
			type: "tool_call",
			toolName: "bash",
			toolCallId: "bash-list-tmp",
			input: { command: "ls -la /tmp" },
		} satisfies ToolCallEvent,
		cwd,
		loaded.policy,
	);
	const tmpListDecision = decideWithReins(loaded.policy, tmpListRequest);
	assert(
		tmpListDecision.kind === "ask",
		"/tmp listing should ask for path approval",
	);
	const tmpListCandidate = pathRequirementCandidate(tmpListDecision);
	assert(
		tmpListCandidate?.type === "pathAccess",
		"/tmp listing should offer a path grant",
	);
	assert(
		tmpListCandidate.scopes.includes("session"),
		"/tmp listing should be reusable for the session",
	);
	assert(
		!tmpListCandidate.scopes.includes("workspace"),
		"/tmp listing should not be workspace-persistent",
	);

	const outsideWriteDir = join(outsideDir, "write");
	const outsideWriteFile = join(outsideWriteDir, "debug.cpp");
	mkdirSync(outsideWriteDir);
	const outsideWriteRequest = requestFromToolCall(
		{
			type: "tool_call",
			toolName: "write",
			toolCallId: "write-outside",
			input: { path: outsideWriteFile, content: "int main() { return 0; }\n" },
		} satisfies ToolCallEvent,
		cwd,
		loaded.policy,
	);
	const outsideWriteDecision = decideWithReins(
		loaded.policy,
		outsideWriteRequest,
	);
	assert(
		outsideWriteDecision.kind === "ask",
		"normal outside-root write should ask for path approval",
	);
	const outsideWriteCandidate = pathRequirementCandidate(outsideWriteDecision);
	assert(
		outsideWriteCandidate?.type === "pathAccess",
		"normal outside-root write should offer a path grant",
	);
	assert(
		outsideWriteCandidate.roots.includes(realpathSync(outsideWriteDir)),
		"normal outside-root write should offer the containing directory",
	);

	const privacyWriteRequest = requestFromToolCall(
		{
			type: "tool_call",
			toolName: "write",
			toolCallId: "write-privacy",
			input: { path: "~/Downloads/pi-safety-check.txt", content: "x\n" },
		} satisfies ToolCallEvent,
		cwd,
		loaded.policy,
	);
	const privacyWriteDecision = decideWithReins(
		loaded.policy,
		privacyWriteRequest,
	);
	assert(
		privacyWriteDecision.kind === "ask",
		"privacy writes should ask for explicit approval",
	);
	const privacyWriteCandidate = pathRequirementCandidate(privacyWriteDecision);
	assert(
		privacyWriteCandidate?.type === "pathAccess",
		"privacy writes should use a path grant candidate for prompt context",
	);
	assert(
		privacyWriteCandidate.scopes.length === 0,
		"privacy writes should not offer reusable path grant scopes",
	);

	const customProtectedPolicy = {
		...loaded.policy,
		protectedPaths: [...loaded.policy.protectedPaths, `${outsideReadDir}/**`],
	};
	const customProtectedRequest = requestFromToolCall(
		{
			type: "tool_call",
			toolName: "read",
			toolCallId: "read-custom-protected",
			input: { path: outsideReadFile },
		} satisfies ToolCallEvent,
		cwd,
		customProtectedPolicy,
	);
	assert(
		decideWithReins(customProtectedPolicy, customProtectedRequest).kind ===
			"block",
		"custom protected paths should remain blocked",
	);

	const shellRequest = requestFromToolCall(
		{
			type: "tool_call",
			toolName: "bash",
			toolCallId: "bash-1",
			input: { command: "bun run check" },
		} satisfies ToolCallEvent,
		cwd,
		loaded.policy,
	);
	assert(
		decideWithReins(loaded.policy, shellRequest).kind === "ask",
		"bun run check should require approval in code profile",
	);

	const cmakeBuildRequest = requestFromToolCall(
		{
			type: "tool_call",
			toolName: "bash",
			toolCallId: "bash-cmake-build",
			input: { command: `cd ${cwd} && cmake --build build-release --parallel` },
		} satisfies ToolCallEvent,
		cwd,
		loaded.policy,
	);
	const cmakeBuildDecision = decideWithReins(loaded.policy, cmakeBuildRequest);
	assert(
		cmakeBuildDecision.kind === "ask",
		"cmake build should require approval",
	);
	assert(
		cmakeBuildDecision.requirement?.type === "command",
		"cmake build should ask for command approval",
	);
	assert(
		cmakeBuildDecision.requirement.candidate?.type === "commandFamily",
		"cmake build should offer a command-family grant",
	);

	const readOnlyGitAfterCd = requestFromToolCall(
		{
			type: "tool_call",
			toolName: "bash",
			toolCallId: "bash-git-cd",
			input: { command: `cd ${cwd} && git status` },
		} satisfies ToolCallEvent,
		cwd,
		readOnlyPolicy,
	);
	assert(
		decideWithReins(readOnlyPolicy, readOnlyGitAfterCd).kind === "allow",
		"read-only should allow cd workspace && git status",
	);

	const readOnlyGitDashC = requestFromToolCall(
		{
			type: "tool_call",
			toolName: "bash",
			toolCallId: "bash-git-c",
			input: { command: `git -C ${cwd} log --oneline -5` },
		} satisfies ToolCallEvent,
		cwd,
		readOnlyPolicy,
	);
	assert(
		decideWithReins(readOnlyPolicy, readOnlyGitDashC).kind === "allow",
		"read-only should allow git -C workspace log",
	);

	const childToolEffects = {
		analyze(toolName: string, input: Record<string, unknown> | undefined) {
			if (toolName !== "child_tool") return undefined;
			const writeCapable = input?.mode === "write";
			return {
				toolName,
				effects: writeCapable
					? ["run_command" as const, "read_files" as const, "write_files" as const]
					: ["run_command" as const, "read_files" as const],
				risk: writeCapable ? "unknown" as const : "safe_read" as const,
				pathInputs: [],
				known: true,
				reason: writeCapable ? "write-capable child" : "read-only child",
			};
		},
	};
	const readOnlyChildRequest = requestFromToolCall(
		{
			type: "tool_call",
			toolName: "child_tool",
			toolCallId: "child-readonly",
			input: { mode: "read" },
		} satisfies ToolCallEvent,
		cwd,
		readOnlyPolicy,
		childToolEffects,
	);
	assert(
		decideWithReins(readOnlyPolicy, readOnlyChildRequest).kind === "allow",
		"read-only policy should allow an owner-classified read-only child tool",
	);

	const writeChildRequest = requestFromToolCall(
		{
			type: "tool_call",
			toolName: "child_tool",
			toolCallId: "child-write",
			input: { mode: "write" },
		} satisfies ToolCallEvent,
		cwd,
		loaded.policy,
		childToolEffects,
	);
	const writeChildDecision = decideWithReins(
		loaded.policy,
		writeChildRequest,
	);
	assert(
		writeChildDecision.kind === "ask",
		"write-capable child tool should require approval",
	);
	assert(
		writeChildDecision.requirement?.type === "command",
		"write-capable child tool should ask for action approval",
	);

	const protectedShellRequest = requestFromToolCall(
		{
			type: "tool_call",
			toolName: "bash",
			toolCallId: "bash-2",
			input: { command: "cat .env" },
		} satisfies ToolCallEvent,
		cwd,
		loaded.policy,
	);
	assert(
		protectedShellRequest.paths.some((path) => !path.allowed),
		"shell path extraction should flag cat .env",
	);
	assert(
		decideWithReins(loaded.policy, protectedShellRequest).kind === "block",
		"cat .env should block before containment",
	);

	const tempHeredocWriteRequest = requestFromToolCall(
		{
			type: "tool_call",
			toolName: "bash",
			toolCallId: "bash-temp-heredoc",
			input: {
				command:
					"cat > /tmp/debug_rv64i.cpp << 'EOF'\nint main() { return 0; }\nEOF\nclang++ /tmp/debug_rv64i.cpp",
			},
		} satisfies ToolCallEvent,
		cwd,
		loaded.policy,
	);
	assert(
		tempHeredocWriteRequest.paths.some(
			(path) =>
				path.path === "/tmp/debug_rv64i.cpp" && path.operation === "write",
		),
		"heredoc output redirection should extract the write target",
	);
	const tempHeredocDecision = decideWithReins(
		loaded.policy,
		tempHeredocWriteRequest,
	);
	assert(
		tempHeredocDecision.kind === "ask",
		"heredoc writes outside workspace should ask instead of blanket blocking",
	);
	assert(
		tempHeredocDecision.requirement?.type === "pathAccess",
		"heredoc with an unknown command should ask for path access before command approval",
	);
	const tempHeredocManager = new ApprovalManager(cwd, {
		persistence: "workspace",
		workspaceStatePath: join(outsideDir, "heredoc-grants.json"),
	});
	const firstAuthorization = tempHeredocManager.evaluate(
		loaded.policy,
		tempHeredocWriteRequest,
	);
	assert(
		firstAuthorization.decision.requirement?.type === "pathAccess",
		"authorization should start with the path requirement",
	);
	const tempPathGrant = pathGrantFromCandidate(
		firstAuthorization.decision.requirement.candidate,
	);
	const afterPathAuthorization = tempHeredocManager.evaluate(
		loaded.policy,
		tempHeredocWriteRequest,
		{
			pathGrants: [tempPathGrant],
			commandApproved: false,
		},
	);
	assert(
		afterPathAuthorization.decision.kind === "ask",
		"after path approval, heredoc command should still require command approval",
	);
	assert(
		afterPathAuthorization.decision.requirement?.type === "command",
		"after path approval, authorization should ask for the command requirement",
	);
	const afterCommandAuthorization = tempHeredocManager.evaluate(
		loaded.policy,
		tempHeredocWriteRequest,
		{
			pathGrants: [tempPathGrant],
			commandApproved: true,
		},
	);
	assert(
		afterCommandAuthorization.decision.kind === "allow",
		"path approval plus command approval should authorize the command",
	);
	assert(
		afterCommandAuthorization.decision.reason.includes("command approved once"),
		"authorization reason should keep command approval context",
	);
	assert(
		afterCommandAuthorization.decision.reason.includes("path grant matched"),
		"authorization reason should keep path approval context",
	);
	assert(
		afterCommandAuthorization.executionGrants.pathGrants.length > 0,
		"authorization should retain request-local path approvals",
	);

	const noArgCdRequest = requestFromToolCall(
		{
			type: "tool_call",
			toolName: "bash",
			toolCallId: "bash-cd-home",
			input: { command: "cd" },
		} satisfies ToolCallEvent,
		cwd,
		loaded.policy,
	);
	assert(
		noArgCdRequest.paths.some(
			(path) => path.path === "~" && path.protectedKind === "privacy",
		),
		"cd should flag HOME as privacy-protected",
	);
	assert(
		decideWithReins(loaded.policy, noArgCdRequest).kind === "ask",
		"cd should ask before moving to HOME",
	);

	const homeSearchRequest = requestFromToolCall(
		{
			type: "tool_call",
			toolName: "bash",
			toolCallId: "bash-home-search",
			input: { command: "find ~ -maxdepth 2 -type f" },
		} satisfies ToolCallEvent,
		cwd,
		loaded.policy,
	);
	assert(
		homeSearchRequest.paths.some((path) => path.reason === "protected-path"),
		"shell path extraction should flag find ~",
	);
	assert(
		homeSearchRequest.paths.length === 1,
		"find path extraction should not treat expression operands as paths",
	);
	assert(
		decideWithReins(loaded.policy, homeSearchRequest).kind === "ask",
		"find ~ should ask for privacy approval",
	);

	const downloadsSearchRequest = requestFromToolCall(
		{
			type: "tool_call",
			toolName: "bash",
			toolCallId: "bash-downloads-search",
			input: { command: "rg password ~/Downloads" },
		} satisfies ToolCallEvent,
		cwd,
		loaded.policy,
	);
	assert(
		downloadsSearchRequest.paths.some(
			(path) => path.reason === "protected-path",
		),
		"shell path extraction should flag ~/Downloads",
	);
	assert(
		decideWithReins(loaded.policy, downloadsSearchRequest).kind === "ask",
		"rg over ~/Downloads should ask for privacy approval",
	);

	const historyReadRequest = requestFromToolCall(
		{
			type: "tool_call",
			toolName: "bash",
			toolCallId: "bash-history-read",
			input: { command: "cat ~/.zsh_history" },
		} satisfies ToolCallEvent,
		cwd,
		loaded.policy,
	);
	assert(
		decideWithReins(loaded.policy, historyReadRequest).kind === "block",
		"shell history reads should remain blocked",
	);

	const quotedHistoryReadRequest = requestFromToolCall(
		{
			type: "tool_call",
			toolName: "bash",
			toolCallId: "bash-quoted-history-read",
			input: { command: 'cat "$HOME/.zsh_history"' },
		} satisfies ToolCallEvent,
		cwd,
		loaded.policy,
	);
	assert(
		decideWithReins(loaded.policy, quotedHistoryReadRequest).kind === "block",
		"quoted shell history reads should remain blocked",
	);

	const moveHistoryRequest = requestFromToolCall(
		{
			type: "tool_call",
			toolName: "bash",
			toolCallId: "bash-history-move",
			input: { command: "mv ~/.zsh_history /tmp/history-copy" },
		} satisfies ToolCallEvent,
		cwd,
		loaded.policy,
	);
	assert(
		decideWithReins(loaded.policy, moveHistoryRequest).kind === "block",
		"modeled mv source paths should protect shell history",
	);

	const uvDownloadsRequest = requestFromToolCall(
		{
			type: "tool_call",
			toolName: "bash",
			toolCallId: "bash-uv-downloads",
			input: { command: "uv --directory ~/Downloads run pytest" },
		} satisfies ToolCallEvent,
		cwd,
		loaded.policy,
	);
	const uvDownloadsDecision = decideWithReins(
		loaded.policy,
		uvDownloadsRequest,
	);
	assert(uvDownloadsDecision.kind === "ask", "uv over Downloads should ask");
	assert(
		uvDownloadsDecision.requirement?.type === "pathAccess",
		"uv --directory privacy path should ask for path approval before command approval",
	);
	assert(
		uvDownloadsDecision.requirement.candidate.sensitivity === "privacy",
		"uv --directory privacy path should be privacy-marked",
	);

	const npmUserConfigRequest = requestFromToolCall(
		{
			type: "tool_call",
			toolName: "bash",
			toolCallId: "bash-npm-userconfig",
			input: { command: "npm --userconfig ~/.npmrc install" },
		} satisfies ToolCallEvent,
		cwd,
		loaded.policy,
	);
	assert(
		decideWithReins(loaded.policy, npmUserConfigRequest).kind === "block",
		"npm --userconfig should protect npm credentials",
	);

	const compilerOutputRequest = requestFromToolCall(
		{
			type: "tool_call",
			toolName: "bash",
			toolCallId: "bash-compiler-output",
			input: { command: "clang++ main.cpp -o /tmp/main-bin" },
		} satisfies ToolCallEvent,
		cwd,
		loaded.policy,
	);
	const compilerOutputDecision = decideWithReins(
		loaded.policy,
		compilerOutputRequest,
	);
	assert(
		compilerOutputDecision.kind === "ask",
		"compiler output outside workspace should ask",
	);
	assert(
		compilerOutputDecision.requirement?.type === "pathAccess",
		"compiler output path should ask for path approval before command approval",
	);

	const planInputRequest = requestFromToolCall(
		{
			type: "tool_call",
			toolName: "request_plan_input",
			toolCallId: "plan-input-1",
			input: { questions: [] },
		} satisfies ToolCallEvent,
		cwd,
		loaded.policy,
	);
	assert(
		decideWithReins(loaded.policy, planInputRequest).kind === "allow",
		"guarded should allow request_plan_input",
	);

	const submitPlanRequest = requestFromToolCall(
		{
			type: "tool_call",
			toolName: "submit_plan",
			toolCallId: "submit-plan-1",
			input: { plan: "Do the work." },
		} satisfies ToolCallEvent,
		cwd,
		loaded.policy,
	);
	assert(
		decideWithReins(loaded.policy, submitPlanRequest).kind === "allow",
		"guarded should allow submit_plan",
	);

	const webSearchRequest = requestFromToolCall(
		{
			type: "tool_call",
			toolName: "web_search",
			toolCallId: "web-search-1",
			input: { query: "Python pathlib documentation" },
		} satisfies ToolCallEvent,
		cwd,
		loaded.policy,
		agentSearchEffects,
	);
	const webSearchDecision = decideWithReins(loaded.policy, webSearchRequest);
	assert(
		webSearchDecision.kind === "ask",
		"web_search should ask in the code profile",
	);
	assert(
		webSearchRequest.summary === "Search web: Python pathlib documentation",
		"web_search approval should show its query",
	);
	assert(
		webSearchRequest.reason === "web search requires network access",
		"web_search should not be classified as unknown custom tool",
	);

	const webFetchRequest = requestFromToolCall(
		{
			type: "tool_call",
			toolName: "web_fetch",
			toolCallId: "web-fetch-1",
			input: {
				url: "https://docs.python.org/3/library/pathlib.html?ignored=value",
			},
		} satisfies ToolCallEvent,
		cwd,
		loaded.policy,
		agentSearchEffects,
	);
	const webFetchDecision = decideWithReins(loaded.policy, webFetchRequest);
	assert(
		webFetchDecision.kind === "ask",
		"web_fetch should ask in the code profile",
	);
	assert(
		webFetchRequest.summary ===
			"Fetch https://docs.python.org/3/library/pathlib.html",
		"web_fetch approval should show a sanitized destination",
	);
	assert(
		webFetchRequest.reason === "web fetch requires network access",
		"web_fetch should not be classified as unknown custom tool",
	);
	assert(
		decideWithReins(readOnlyPolicy, webSearchRequest).kind === "block",
		"read-only should block web_search network access",
	);
	assert(
		decideWithReins(readOnlyPolicy, webFetchRequest).kind === "block",
		"read-only should block web_fetch network access",
	);
}

function protectedPaths(): string[] {
	return [
		"~",
		"~/Downloads",
		"~/Documents",
		"~/Pictures",
		"~/Movies",
		"~/Music",
		"~/Library",
		"~/.zsh_history",
		"~/.bash_history",
		"~/.pi/agent/auth.json",
		"~/.ssh/config",
		"~/.config/gh/hosts.yml",
		`${homedir()}/Downloads/receipt.pdf`,
	];
}

function pathRequirementCandidate(
	decision: ReinsDecision,
): PathAccessGrantCandidate | undefined {
	return decision.requirement?.type === "pathAccess"
		? decision.requirement.candidate
		: undefined;
}

function pathGrantFromCandidate(
	candidate: PathAccessGrantCandidate,
): PathGrant {
	return {
		id: "check-path-grant",
		type: "pathAccess",
		roots: [...candidate.roots],
		operations: [...candidate.operations],
		sensitivity: candidate.sensitivity,
		createdAt: "2026-05-03T00:00:00Z",
		reason: "check path approval",
	};
}
