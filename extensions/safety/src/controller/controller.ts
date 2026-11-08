import type {
	BashLaunchEvent,
	BashLaunchEventResult,
	BashOperations,
	ExtensionContext,
	ToolCallEvent,
	ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import type { WorkspacePathOperations } from "../../../shared/active-workspace.ts";
import type { ChildRunIntent } from "../../../shared/child-runtime.ts";
import type { ToolEffect, ToolEffectObserver } from "../../../shared/tool-effects.ts";
import { AuditRecorder } from "../audit/recorder.js";
import { createSafetyChildContext, type SafetyChildContext } from "../child/context.js";
import type { ProvidedProjectSafetyConfig } from "../child/project-config.js";
import { type LoadSafetyConfigOptions, loadSafetyConfig } from "../config/load.js";
import type {
	ConfigLoadResult,
	ContainmentMode,
	EffectiveSafetyPolicy,
	EnvironmentMode,
	NetworkMode,
	ReinsMode,
	SafetyProfileName,
} from "../config/types.js";
import { DefaultContainmentEngine } from "../containment/engine.js";
import { isWithinOrEqual } from "../paths/normalize.js";
import type { PathOperation } from "../paths/types.js";
import { profilePreset } from "../profiles/presets.js";
import { applyProfile } from "../profiles/resolve.js";
import {
	ApprovalManager,
	type AuthorizationResult,
	type SaveSessionApprovalsResult,
} from "../reins/approval-manager.js";
import type { ExecutionGrants } from "../reins/execution-grants.js";
import { sameStoredApprovalGrant } from "../reins/grant-equivalence.js";
import type { PathGrant, StoredApprovalGrant } from "../reins/grant-types.js";
import { formatPolicyStatus, type StatusTheme, safetyStatusLine, themedSafetyStatusLine } from "../ui/status.js";
import { requestFromBashLaunch, requestFromBashLaunchWithWorkspace, requestFromToolCall, requestFromToolCallWithWorkspace } from "./request.js";
import {
	cloneSafetySessionSettings,
	setPolicyContainmentMode,
	setPolicyEnvironmentMode,
	setPolicyNetworkMode,
	setPolicyReinsMode,
	setSessionProfile,
	type SafetySessionSettings,
} from "../config/session-settings.js";
import type { SafetyRequest } from "./types.js";

export interface SafetyControllerPaths {
	userConfigPath: string;
	projectConfigPath: string;
	workspaceStatePath: string;
	auditDir: string;
}

export interface SafetyControllerCreateOptions extends LoadSafetyConfigOptions {
	clientZdr: boolean;
	pathOperations?: WorkspacePathOperations;
	toolEffects?: ToolEffectObserver;
	ephemeral?: boolean;
	initialGrants?: readonly StoredApprovalGrant[];
	approvedTools?: readonly string[];
}

export class SafetyController {
	static create(options: SafetyControllerCreateOptions): SafetyController {
		const {
			clientZdr,
			pathOperations,
			toolEffects,
			ephemeral = false,
			initialGrants = [],
			approvedTools = [],
			sessionSettings,
			...configOptions
		} = options;
		const loadResult = loadSafetyConfig({ ...configOptions, sessionSettings });
		return new SafetyController(
			loadResult,
			clientZdr,
			ephemeral,
			initialGrants,
			approvedTools,
			pathOperations,
			toolEffects,
			sessionSettings,
		);
	}

	private readonly loadResult: ConfigLoadResult;
	private readonly clientZdr: boolean;
	private readonly ephemeral: boolean;
	private readonly audit: AuditRecorder;
	private readonly containment = new DefaultContainmentEngine();
	private readonly approvals: ApprovalManager;
	private readonly pathOperations: WorkspacePathOperations | undefined;
	private readonly toolEffects: ToolEffectObserver | undefined;
	private readonly approvedTools: ReadonlySet<string>;
	private readonly sessionSettings: SafetySessionSettings;
	private readonly childAuthorizations = new Map<string, { effects: ToolEffect[]; executionGrants: ExecutionGrants }>();

	private constructor(
		loadResult: ConfigLoadResult,
		clientZdr: boolean,
		ephemeral: boolean,
		initialGrants: readonly StoredApprovalGrant[],
		approvedTools: readonly string[],
		pathOperations: WorkspacePathOperations | undefined,
		toolEffects: ToolEffectObserver | undefined,
		sessionSettings: SafetySessionSettings | undefined,
	) {
		this.loadResult = loadResult;
		this.clientZdr = clientZdr;
		this.ephemeral = ephemeral;
		this.pathOperations = pathOperations;
		this.toolEffects = toolEffects;
		this.approvedTools = new Set(approvedTools);
		this.sessionSettings = cloneSafetySessionSettings(
			sessionSettings ?? {},
		);
		this.audit = new AuditRecorder(loadResult.auditDir);
		this.approvals = new ApprovalManager(
			loadResult.policy.workspaceRoot,
			clientZdr || ephemeral || loadResult.policy.workspaceKind === "provided"
				? { persistence: "session", initialGrants }
				: { persistence: "workspace", workspaceStatePath: loadResult.workspaceStatePath, initialGrants },
		);
	}

	policy(): EffectiveSafetyPolicy {
		return this.loadResult.policy;
	}

	paths(): SafetyControllerPaths {
		return {
			userConfigPath: this.loadResult.userConfigPath,
			projectConfigPath: this.loadResult.projectConfigPath,
			workspaceStatePath: this.loadResult.workspaceStatePath,
			auditDir: this.loadResult.auditDir,
		};
	}

	statusLine(): string | undefined {
		return safetyStatusLine(this.loadResult.policy);
	}

	themedStatusLine(theme: StatusTheme | undefined): string | undefined {
		return themedSafetyStatusLine(this.loadResult.policy, theme);
	}

	statusText(): string {
		const persistence = this.clientZdr
			? "session approvals only (ZDR); audit disabled"
			: this.ephemeral
				? "inherited session approvals only; audit disabled"
				: this.loadResult.policy.workspaceKind === "provided"
					? `session approvals only for provided workspace; audit ${this.auditRecordingEnabled() ? "enabled" : "disabled"}`
					: `workspace approvals enabled; audit ${this.auditRecordingEnabled() ? "enabled" : "disabled"}`;
		return `${formatPolicyStatus(this.loadResult.policy)}\nPersistence: ${persistence}`;
	}

	explainText(): string {
		const policy = this.loadResult.policy;
		return [
			`Safety profile ${policy.profile} uses Reins mode ${policy.reins.mode}.`,
			`Containment is ${policy.containment.mode} with network ${policy.containment.network}.`,
			"Model tool calls and direct user bash are mediated by Reins.",
			"Allowed bash commands use Containment operations when the selected backend is available.",
			this.clientZdr
				? "ZDR keeps approvals in memory for this session and disables workspace approvals and audit recording."
				: this.ephemeral
					? "Inherited child context keeps approvals in memory and disables audit recording."
					: policy.workspaceKind === "provided"
						? "Provided workspaces keep approvals in memory for this session; audit recording follows Safety configuration."
						: "Eligible approvals can be stored for this workspace; audit recording follows Safety configuration.",
		].join("\n");
	}

	isClientZdr(): boolean {
		return this.clientZdr;
	}

	auditRecordingEnabled(): boolean {
		return !this.clientZdr && !this.ephemeral && this.loadResult.policy.audit.enabled;
	}

	auditStatusText(): string {
		if (this.clientZdr) return "Safety audit recording is disabled in ZDR mode.";
		if (this.ephemeral) return "Safety audit recording is disabled in an inherited child context.";
		if (!this.loadResult.policy.audit.enabled) return "Safety audit recording is disabled by configuration.";
		return `Safety audit directory: ${this.loadResult.auditDir}`;
	}

	approvalsText(): string {
		return this.approvals.statusText();
	}

	approvalChoices(): string[] {
		return this.approvals.choices();
	}

	saveableSessionApprovals(): number | undefined {
		return this.approvals.saveableSessionApprovals();
	}

	saveSessionApprovalsToWorkspace(): SaveSessionApprovalsResult {
		return this.approvals.saveSessionApprovalsToWorkspace();
	}

	forgetApproval(choice: string): boolean {
		return this.approvals.forget(choice);
	}

	sessionSettingsSnapshot(): SafetySessionSettings {
		return cloneSafetySessionSettings(this.sessionSettings);
	}

	setProfile(profile: string): { ok: true; profile: SafetyProfileName } | { ok: false; reason: string } {
		const preset = profilePreset(profile);
		if (!preset) return { ok: false, reason: `Unknown Safety profile: ${profile}` };
		const next = applyProfile(this.loadResult.policy, preset.name);
		this.loadResult.policy.enabled = next.enabled;
		this.loadResult.policy.profile = next.profile;
		this.loadResult.policy.reins = next.reins;
		this.loadResult.policy.containment = next.containment;
		setSessionProfile(this.sessionSettings, preset.name);
		this.sessionSettings.enabled = next.enabled;
		return { ok: true, profile: preset.name };
	}

	setEnabled(enabled: boolean): void {
		if (enabled && this.loadResult.policy.profile === "off") {
			this.setProfile("code");
			return;
		}
		this.loadResult.policy.enabled = enabled;
		this.sessionSettings.enabled = enabled;
	}

	setReinsMode(mode: ReinsMode): void {
		setPolicyReinsMode(this.loadResult.policy, mode);
		this.sessionSettings.reinsMode = mode;
		this.sessionSettings.enabled = this.loadResult.policy.enabled;
	}

	setContainmentMode(mode: ContainmentMode): void {
		setPolicyContainmentMode(this.loadResult.policy, mode);
		this.sessionSettings.containmentMode = mode;
		this.sessionSettings.enabled = this.loadResult.policy.enabled;
	}

	setNetworkMode(network: NetworkMode): void {
		setPolicyNetworkMode(this.loadResult.policy, network);
		this.sessionSettings.network = network;
		this.sessionSettings.enabled = this.loadResult.policy.enabled;
	}

	setEnvironmentMode(environment: EnvironmentMode): void {
		setPolicyEnvironmentMode(this.loadResult.policy, environment);
		this.sessionSettings.environment = environment;
		this.sessionSettings.enabled = this.loadResult.policy.enabled;
	}

	notifyWarnings(ctx: ExtensionContext): void {
		for (const warning of this.loadResult.policy.warnings) {
			ctx.ui.notify(warning, "warning");
		}
		const support = this.containmentSupport();
		if (this.loadResult.policy.enabled && this.loadResult.policy.containment.mode !== "off" && !support.available) {
			ctx.ui.notify(`Safety containment unavailable: ${support.reason ?? "unknown reason"}`, "error");
		}
	}

	bashOperations(shellPath?: string): BashOperations | undefined {
		if (this.loadResult.policy.workspaceKind === "provided") return undefined;
		return this.containment.bashOperations(this.loadResult.policy, shellPath);
	}

	containmentSupportText(): string {
		if (this.loadResult.policy.containment.mode === "off") return "off";
		const support = this.containmentSupport();
		if (support.available) return support.backend ?? "available";
		return support.reason ?? "unavailable";
	}

	async handleToolCall(event: ToolCallEvent, ctx: ExtensionContext): Promise<ToolCallEventResult | undefined> {
		const policy = this.loadResult.policy;
		if (!policy.enabled || policy.reins.mode === "off") return undefined;
		if (event.toolName === "bash") return undefined;

		let request: SafetyRequest;
		try {
			request = this.pathOperations
				? await requestFromToolCallWithWorkspace(event, policy.workspaceCwd, policy, this.pathOperations, this.toolEffects)
				: requestFromToolCall(event, policy.workspaceCwd, policy, this.toolEffects);
		} catch (error) {
			return { block: true, reason: `blocked by Safety: workspace path resolution failed: ${error instanceof Error ? error.message : String(error)}` };
		}
		const authorization =
			this.commissionAuthorization(event.toolName, request) ??
			(await this.approvals.authorize(policy, request, ctx));
		const decision = authorization.decision;
		if (decision.kind === "allow") {
			this.childAuthorizations.set(event.toolCallId, {
				effects: [...request.effects],
				executionGrants: authorization.executionGrants,
			});
			if (this.auditRecordingEnabled()) this.audit.record(policy, request, decision);
			return undefined;
		}
		if (this.auditRecordingEnabled()) this.audit.record(policy, request, decision);
		return {
			block: true,
			reason: `blocked by Safety: ${decision.reason}`,
		};
	}

	async handleBashLaunch(event: BashLaunchEvent, ctx: ExtensionContext): Promise<BashLaunchEventResult | undefined> {
		const policy = this.loadResult.policy;
		if (!policy.enabled) return undefined;

		if (policy.containment.mode !== "off") {
			if (event.shell === "powershell") {
				return { block: true, reason: "blocked by Safety: PowerShell containment is unavailable" };
			}
			if (policy.workspaceKind === "provided") {
				return { block: true, reason: "blocked by Safety: active workspace does not provide command containment" };
			}
			if (event.operationsKind === "custom") {
				return { block: true, reason: "blocked by Safety: containment cannot safely wrap custom Bash operations" };
			}
			const support = this.containment.support(policy);
			if (!support.available) {
				return {
					block: true,
					reason: `blocked by Safety: configured containment is unavailable: ${support.reason ?? "unknown reason"}`,
				};
			}
		}

		if (policy.reins.mode !== "off") {
			let request: SafetyRequest;
			try {
				request = this.pathOperations
					? await requestFromBashLaunchWithWorkspace(event, policy, event.cwd, this.pathOperations)
					: requestFromBashLaunch(event, policy);
			} catch (error) {
				return { block: true, reason: `blocked by Safety: workspace path resolution failed: ${error instanceof Error ? error.message : String(error)}` };
			}
			const authorization = await this.approvals.authorize(policy, request, ctx);
			const decision = authorization.decision;
			if (this.auditRecordingEnabled()) this.audit.record(policy, request, decision);
			if (decision.kind !== "allow") {
				return { block: true, reason: `blocked by Safety: ${decision.reason}` };
			}
		}

		const operations = this.bashOperations(event.shellPath);
		return operations ? { operations } : undefined;
	}

	childContext(intent: ChildRunIntent, project?: ProvidedProjectSafetyConfig): SafetyChildContext {
		const policy = this.loadResult.policy;
		const authorization = intent.origin.kind === "tool"
			? this.childAuthorizations.get(intent.origin.toolCallId)
			: undefined;
		if (policy.enabled && policy.reins.mode !== "off" && intent.origin.kind === "tool" && !authorization) {
			throw new Error("Safety has no authorization for this child launch");
		}
		if (authorization) {
			const authorizedEffects = new Set(authorization.effects);
			const undeclared = intent.capabilities.filter((capability) => !authorizedEffects.has(capability));
			if (undeclared.length > 0) {
				throw new Error(`child launch exceeds its Safety authorization: ${undeclared.join(", ")}`);
			}
		}
		return createSafetyChildContext(
			policy,
			uniqueGrants([
				...applicableReusableGrants(intent, this.approvals.reusableGrants()),
				...childExecutionPathGrants(intent, authorization?.executionGrants.pathGrants ?? []),
			]),
			authorization?.executionGrants.commandApproved
				? intent.tools.filter((tool) => tool !== "bash")
				: [],
			project,
		);
	}

	releaseChildAuthorization(toolCallId: string): void {
		this.childAuthorizations.delete(toolCallId);
	}

	private containmentSupport() {
		if (this.loadResult.policy.enabled && this.loadResult.policy.containment.mode !== "off" && this.loadResult.policy.workspaceKind === "provided") {
			return { available: false as const, reason: "active workspace does not provide command containment" };
		}
		return this.containment.support(this.loadResult.policy);
	}

	private commissionAuthorization(
		toolName: string,
		request: SafetyRequest,
	): AuthorizationResult | undefined {
		if (!this.approvedTools.has(toolName)) return undefined;
		const evaluated = this.approvals.evaluate(this.loadResult.policy, request);
		if (
			evaluated.decision.kind !== "ask" ||
			evaluated.decision.requirement?.type !== "command" ||
			evaluated.decision.requirement.candidate ||
			request.risk !== "unknown" ||
			request.effects.length === 0 ||
			!request.effects.every(
				(effect) => effect === "network" || effect === "external_state",
			)
		) {
			return undefined;
		}
		return {
			...evaluated,
			decision: {
				kind: "allow",
				reason: "tool capability approved with the parent commission",
				request: evaluated.decision.request,
			},
		};
	}
}

function applicableReusableGrants(
	intent: ChildRunIntent,
	grants: readonly StoredApprovalGrant[],
): StoredApprovalGrant[] {
	const pathGrants = grants.filter((grant): grant is PathGrant => grant.type === "pathAccess");
	const commandGrants = intent.capabilities.includes("run_command")
		? grants.filter((grant) => grant.type !== "pathAccess")
		: [];
	return [...childExecutionPathGrants(intent, pathGrants), ...commandGrants];
}

function childExecutionPathGrants(intent: ChildRunIntent, grants: readonly PathGrant[]): PathGrant[] {
	const operations = childPathOperations(intent.capabilities);
	if (operations.length === 0) return [];
	return grants.flatMap((grant) => {
		const roots = grant.roots.flatMap((root) => {
			if (isWithinOrEqual(intent.cwd, root)) return [intent.cwd];
			if (isWithinOrEqual(root, intent.cwd)) return [root];
			return [];
		});
		if (roots.length === 0) return [];
		const allowedOperations = grant.operations.filter((operation) => operations.includes(operation));
		return allowedOperations.length > 0
			? [{ ...grant, roots: [...new Set(roots)], operations: allowedOperations }]
			: [];
	});
}

function childPathOperations(capabilities: readonly ToolEffect[]): PathOperation[] {
	return [
		...(capabilities.includes("read_files") ? ["read" as const] : []),
		...(capabilities.includes("list_files") ? ["list" as const] : []),
		...(capabilities.includes("write_files") ? ["write" as const] : []),
	];
}

function uniqueGrants(grants: readonly StoredApprovalGrant[]): StoredApprovalGrant[] {
	const unique: StoredApprovalGrant[] = [];
	for (const grant of grants) {
		if (!unique.some((candidate) => sameStoredApprovalGrant(candidate, grant))) unique.push(grant);
	}
	return unique;
}
