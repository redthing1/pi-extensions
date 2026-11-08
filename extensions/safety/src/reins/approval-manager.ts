import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { EffectiveSafetyPolicy } from "../config/types.js";
import type { SafetyRequest } from "../controller/types.js";
import { canRequestApproval, requestApproval } from "../ui/approval.js";
import { nowIso } from "../util/time.js";
import { decideWithReins } from "./engine.js";
import { cloneExecutionGrants, emptyExecutionGrants, type ExecutionGrants } from "./execution-grants.js";
import type { PathAccessGrantCandidate, ReinsDecision } from "./types.js";
import { SessionGrantStore } from "./grants.js";
import { WorkspaceGrantStore } from "./workspace-grants.js";
import type { ApprovalPersistence, CommandGrant, PathGrant, StoredApprovalGrant } from "./grant-types.js";
import { normalizePathGrantRoots } from "./path-grant-roots.js";
import { formatGrant, formatGrants } from "./grant-format.js";
import { applyPathGrantsToRequest, hasBlockedPath } from "./path-grant-application.js";
import { workspaceEligibleGrant } from "./grant-equivalence.js";
import { coversShellWithGrants } from "./grant-match.js";
import { firstUncoveredGrantCandidate } from "./rules.js";

const MAX_AUTHORIZATION_STEPS = 8;

export interface AuthorizationResult {
	decision: ReinsDecision;
	executionGrants: ExecutionGrants;
}

export type ApprovalManagerOptions =
	| { persistence: "session"; initialGrants?: readonly StoredApprovalGrant[] }
	| { persistence: "workspace"; workspaceStatePath: string; initialGrants?: readonly StoredApprovalGrant[] };

export type SaveSessionApprovalsResult =
	| { kind: "unavailable" }
	| { kind: "saved"; count: number };

type PromptResolution = { kind: "continue" } | { kind: "done"; decision: ReinsDecision };

export class ApprovalManager {
	private readonly sessionGrants: SessionGrantStore;
	private readonly persistence: ApprovalPersistence;
	private readonly workspaceGrants: WorkspaceGrantStore | undefined;
	private approvalQueue: Promise<void> = Promise.resolve();

	constructor(workspaceRoot: string, options: ApprovalManagerOptions) {
		this.sessionGrants = new SessionGrantStore(workspaceRoot, options.initialGrants);
		this.persistence = options.persistence;
		this.workspaceGrants =
			options.persistence === "workspace" ? new WorkspaceGrantStore(options.workspaceStatePath, workspaceRoot) : undefined;
	}

	async authorize(policy: EffectiveSafetyPolicy, request: SafetyRequest, ctx: ExtensionContext): Promise<AuthorizationResult> {
		const evaluated = this.evaluate(policy, request);
		if (evaluated.decision.kind !== "ask") return evaluated;

		const authorization = this.approvalQueue.then(() => this.authorizeWithPrompts(policy, request, ctx));
		this.approvalQueue = authorization.then(
			() => undefined,
			() => undefined,
		);
		return authorization;
	}

	private async authorizeWithPrompts(
		policy: EffectiveSafetyPolicy,
		request: SafetyRequest,
		ctx: ExtensionContext,
	): Promise<AuthorizationResult> {
		const localGrants = emptyExecutionGrants();
		const seenRequirements = new Set<string>();
		for (let step = 0; step < MAX_AUTHORIZATION_STEPS; step += 1) {
			if (ctx.signal?.aborted) {
				return {
					decision: { kind: "block", reason: "authorization cancelled", request },
					executionGrants: cloneExecutionGrants(localGrants),
				};
			}
			const evaluated = this.evaluate(policy, request, localGrants);
			if (evaluated.decision.kind !== "ask") return evaluated;
			const signature = approvalRequirementSignature(evaluated.decision);
			if (seenRequirements.has(signature)) {
				return {
					decision: {
						...evaluated.decision,
						kind: "block",
						reason: `approval did not resolve requirement: ${approvalRequirementDescription(evaluated.decision)}`,
					},
					executionGrants: cloneExecutionGrants(localGrants),
				};
			}
			seenRequirements.add(signature);

			let promptResult: PromptResolution;
			try {
				promptResult = await this.resolvePrompt(evaluated.decision, ctx, localGrants);
			} catch (error) {
				return {
					decision: {
						...evaluated.decision,
						kind: "block",
						reason: `approval UI failed: ${error instanceof Error ? error.message : String(error)}`,
					},
					executionGrants: cloneExecutionGrants(localGrants),
				};
			}
			if (promptResult.kind === "continue") continue;
			return {
				decision: promptResult.decision,
				executionGrants: cloneExecutionGrants(localGrants),
			};
		}
		return {
			decision: { kind: "block", reason: "authorization did not converge", request },
			executionGrants: cloneExecutionGrants(localGrants),
		};
	}

	evaluate(
		policy: EffectiveSafetyPolicy,
		request: SafetyRequest,
		localGrants: ExecutionGrants = emptyExecutionGrants(),
	): AuthorizationResult {
		const pathAdjusted = this.applyPathGrants(request, localGrants.pathGrants);
		let decision = decideWithReins(policy, pathAdjusted.request);
		const commandAdjusted = this.applyCommandGrants(decision, pathAdjusted.request, localGrants.commandApproved);
		if (commandAdjusted) decision = commandAdjusted;
		if (decision.kind === "allow" && pathAdjusted.matchedPathGrants.length > 0) {
			decision = {
				kind: "allow",
				reason: appendReason(decision.reason, `path grant matched: ${formatGrants(pathAdjusted.matchedPathGrants)}`),
				request: pathAdjusted.request,
			};
		}
		return {
			decision,
			executionGrants: {
				pathGrants: pathAdjusted.matchedPathGrants,
				commandApproved: localGrants.commandApproved,
			},
		};
	}

	private applyPathGrants(
		request: SafetyRequest,
		localPathGrants: PathGrant[],
	): { request: SafetyRequest; matchedPathGrants: PathGrant[] } {
		const grants = [...localPathGrants, ...this.sessionPathGrants(), ...this.workspacePathGrants()];
		return applyPathGrantsToRequest(request, grants);
	}

	private applyCommandGrants(
		decision: ReinsDecision,
		request: SafetyRequest,
		commandApprovedOnce: boolean,
	): ReinsDecision | undefined {
		if (decision.kind !== "ask" || decision.requirement?.type !== "command") return undefined;
		if (hasBlockedPath(request)) return undefined;
		if (commandApprovedOnce) {
			return {
				kind: "allow",
				reason: "command approved once",
				request,
			};
		}
		if (!request.shell) return undefined;
		const commandGrants = this.commandGrants();
		const matchedGrants = coversShellWithGrants(request.shell, commandGrants, {
			cwd: request.cwd,
			workspaceRoot: request.workspaceRoot,
		});
		if (matchedGrants && matchedGrants.length > 0) {
			return {
				kind: "allow",
				reason: `command grant matched: ${formatGrants(matchedGrants)}`,
				request,
			};
		}
		const candidate = firstUncoveredGrantCandidate(request.shell, request.cwd, request.workspaceRoot, commandGrants);
		const requirement = candidate
			? { ...decision.requirement, candidate }
			: { type: "command" as const, reason: decision.requirement.reason };
		return { ...decision, requirement };
	}

	private async resolvePrompt(
		decision: ReinsDecision,
		ctx: ExtensionContext,
		localGrants: ExecutionGrants,
	): Promise<PromptResolution> {
		const approval = await requestApproval(ctx, decision, this.persistence);
		const interactive = canRequestApproval(ctx);
		switch (approval.choice) {
			case "interrupt":
				ctx.abort();
				return blockedPromptResult(decision, "user interrupted approval prompt");
			case "allow_once":
				applyAllowOnce(decision, localGrants);
				return { kind: "continue" };
			case "allow_session":
				if (!canStoreRequirementInScope(decision, "session")) {
					return blockedPromptResult(decision, "this approval cannot be reused for the session");
				}
				this.storeSessionRequirement(decision);
				return { kind: "continue" };
			case "allow_workspace":
				if (this.workspaceGrants && canStoreRequirementInScope(decision, "workspace")) {
					this.storeWorkspaceRequirement(decision);
					return { kind: "continue" };
				}
				if (!canStoreRequirementInScope(decision, "session")) {
					return blockedPromptResult(decision, "this approval cannot be reused without workspace persistence");
				}
				this.storeSessionRequirement(decision);
				ctx.ui.notify("Persistent approvals are unavailable; allowed for this session instead.", "info");
				return { kind: "continue" };
			case "deny":
				if (interactive) ctx.abort();
				return blockedPromptResult(decision, deniedReason(interactive, approval.note));
		}
	}

	private storeSessionRequirement(decision: ReinsDecision): void {
		const requirement = decision.requirement;
		if (!requirement) return;
		if (requirement.type === "pathAccess") {
			this.sessionGrants.addPathAccess(requirement.candidate, requirement.reason);
			return;
		}
		if (requirement.candidate) this.sessionGrants.addCommandCandidate(requirement.candidate, requirement.reason);
	}

	private storeWorkspaceRequirement(decision: ReinsDecision): void {
		const workspaceGrants = this.workspaceGrants;
		if (!workspaceGrants) throw new Error("workspace approval persistence is unavailable");
		const requirement = decision.requirement;
		if (!requirement) return;
		if (requirement.type === "pathAccess") {
			if (requirement.candidate.sensitivity === "normal") {
				workspaceGrants.addPathAccess(requirement.candidate, requirement.reason);
			}
			return;
		}
		if (requirement.candidate) workspaceGrants.addCommandCandidate(requirement.candidate, requirement.reason);
	}

	private sessionPathGrants(): PathGrant[] {
		return this.sessionGrants.list().filter((grant): grant is PathGrant => grant.type === "pathAccess");
	}

	private workspacePathGrants(): PathGrant[] {
		return this.workspaceGrants?.list().filter((grant): grant is PathGrant => grant.type === "pathAccess") ?? [];
	}

	private commandGrants(): CommandGrant[] {
		const session = this.sessionGrants.list().filter(isCommandGrant);
		const workspace = this.workspaceGrants?.list().filter(isCommandGrant) ?? [];
		return [...session, ...workspace];
	}

	statusText(): string {
		const session = this.sessionGrants.list();
		const lines = ["Session approvals:"];
		lines.push(...(session.length > 0 ? session.map((grant) => `  ${grant.id}: ${formatGrant(grant)} (${grant.reason})`) : ["  none"]));
		lines.push("Workspace approvals:");
		if (!this.workspaceGrants) {
			lines.push("  disabled for this session");
			return lines.join("\n");
		}
		const workspace = this.workspaceGrants.list();
		lines.push(...(workspace.length > 0 ? workspace.map((grant) => `  ${grant.id}: ${formatGrant(grant)} (${grant.reason})`) : ["  none"]));
		return lines.join("\n");
	}

	choices(): string[] {
		const session = this.sessionGrants.list().map((grant) => `session ${grant.id}: ${formatGrant(grant)}`);
		const workspace = this.workspaceGrants?.list().map((grant) => `workspace ${grant.id}: ${formatGrant(grant)}`) ?? [];
		return [...session, ...workspace];
	}

	saveableSessionApprovals(): number | undefined {
		return this.workspaceGrants ? this.saveableSessionGrants().length : undefined;
	}

	saveSessionApprovalsToWorkspace(): SaveSessionApprovalsResult {
		const workspaceGrants = this.workspaceGrants;
		if (!workspaceGrants) return { kind: "unavailable" };
		const grants = this.saveableSessionGrants();
		for (const grant of grants) {
			if (grant.type === "commandPrefix") {
				workspaceGrants.addCommandPrefix(grant.prefix, grant.reason);
			} else if (grant.type === "commandFamily") {
				workspaceGrants.addCommandFamily(
					{
						type: "commandFamily",
						family: grant.family,
						pathScope: grant.pathScope,
						description: formatGrant(grant),
						scopes: ["workspace"],
					},
					grant.reason,
				);
			} else if (grant.sensitivity === "normal") {
				workspaceGrants.addPathAccess(
					{
						type: "pathAccess",
						roots: grant.roots,
						operations: grant.operations,
						sensitivity: grant.sensitivity,
						description: formatGrant(grant),
						scopes: ["workspace"],
					},
					grant.reason,
				);
			}
		}
		return { kind: "saved", count: grants.length };
	}

	forget(choice: string): boolean {
		const [scope, id] = choice.split(":")[0]?.split(" ") ?? [];
		if (scope === "session" && id) return this.sessionGrants.remove(id);
		if (scope === "workspace" && id) return this.workspaceGrants?.remove(id) ?? false;
		return false;
	}

	reusableGrants(): StoredApprovalGrant[] {
		return [...this.sessionGrants.list(), ...(this.workspaceGrants?.list() ?? [])];
	}

	private saveableSessionGrants(): StoredApprovalGrant[] {
		const workspaceGrants = this.workspaceGrants;
		if (!workspaceGrants) return [];
		return this.sessionGrants.list().filter((grant) => workspaceEligibleGrant(grant) && !workspaceGrants.hasEquivalent(grant));
	}
}

function canStoreRequirementInScope(decision: ReinsDecision, scope: "session" | "workspace"): boolean {
	const requirement = decision.requirement;
	if (!requirement) return false;
	const candidate = requirement.candidate;
	return Boolean(candidate && candidate.scopes.includes(scope));
}

function applyAllowOnce(decision: ReinsDecision, localGrants: ExecutionGrants): void {
	const requirement = decision.requirement;
	if (!requirement) return;
	if (requirement.type === "pathAccess") {
		localGrants.pathGrants.push(pathGrantFromCandidate(requirement.candidate, requirement.reason, decision.request.workspaceRoot));
		return;
	}
	localGrants.commandApproved = true;
}

function pathGrantFromCandidate(candidate: PathAccessGrantCandidate, reason: string, workspaceRoot: string): PathGrant {
	const createdAt = nowIso();
	return {
		id: `request-${createdAt}`,
		type: "pathAccess",
		roots: normalizePathGrantRoots(workspaceRoot, candidate.roots),
		operations: [...candidate.operations],
		sensitivity: candidate.sensitivity,
		createdAt,
		reason,
	};
}

function approvalRequirementSignature(decision: ReinsDecision): string {
	const requirement = decision.requirement;
	if (!requirement) return `none:${decision.reason}`;
	if (requirement.type === "pathAccess") {
		const candidate = requirement.candidate;
		return `path:${candidate.sensitivity}:${sorted(candidate.operations).join(",")}:${sorted(candidate.roots).join("\0")}`;
	}
	const candidate = requirement.candidate;
	if (!candidate) return `command:${requirement.reason}:once`;
	if (candidate.type === "commandFamily") return `command-family:${candidate.family}:${candidate.pathScope}`;
	return `command-prefix:${candidate.prefix.join("\0")}`;
}

function approvalRequirementDescription(decision: ReinsDecision): string {
	const requirement = decision.requirement;
	if (!requirement) return decision.reason;
	if (requirement.type === "pathAccess") return requirement.candidate.description;
	const candidate = requirement.candidate;
	if (!candidate) return requirement.reason;
	if (candidate.type === "commandFamily") return candidate.description;
	return candidate.prefix.join(" ");
}

function isCommandGrant(grant: StoredApprovalGrant): grant is CommandGrant {
	return grant.type === "commandPrefix" || grant.type === "commandFamily";
}

function deniedReason(hasUI: boolean, note: string | undefined): string {
	if (!hasUI) return "approval required but no interactive UI is available";
	return note ? `user denied approval: ${note}` : "user denied approval";
}

function blockedPromptResult(
	decision: ReinsDecision,
	reason: string,
): { kind: "done"; decision: ReinsDecision } {
	return { kind: "done", decision: { ...decision, kind: "block", reason } };
}

function appendReason(left: string, right: string): string {
	return left.length > 0 ? `${left}; ${right}` : right;
}

function sorted(values: readonly string[]): string[] {
	return [...values].sort();
}
