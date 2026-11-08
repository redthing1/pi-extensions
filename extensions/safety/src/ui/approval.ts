import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PathAccess } from "../paths/types.js";
import type { ApprovalPersistence } from "../reins/grant-types.js";
import type { ApprovalRequirement } from "../reins/requirements.js";
import type { GrantCandidate, ReinsDecision } from "../reins/types.js";
import type { ChoiceOption } from "./panel-types.js";
import { ApprovalPromptView } from "./approval-view.js";

export type ApprovalDecision = "allow_once" | "allow_session" | "allow_workspace" | "deny";
export type ApprovalChoice = ApprovalDecision | "interrupt";

export interface ApprovalResult {
	choice: ApprovalChoice;
	note?: string;
}

export async function requestApproval(
	ctx: ExtensionContext,
	decision: ReinsDecision,
	persistence: ApprovalPersistence,
): Promise<ApprovalResult> {
	if (!canRequestApproval(ctx)) return { choice: "deny" };
	if (ctx.signal?.aborted) return { choice: "interrupt" };

	const options = approvalOptions(decision, persistence);
	const signal = ctx.signal;
	let closePrompt: ((result?: ApprovalResult) => void) | undefined;
	const onAbort = (): void => closePrompt?.({ choice: "interrupt" });
	signal?.addEventListener("abort", onAbort, { once: true });
	try {
		const result = await ctx.ui.custom<ApprovalResult | undefined>((_tui, theme, keybindings, done) => {
			closePrompt = done;
			if (signal?.aborted) done({ choice: "interrupt" });
			return new ApprovalPromptView(
				theme,
				keybindings,
				approvalTitle(decision),
				options,
				approvalDetails(decision),
				done,
			);
		});
		return result ?? { choice: "interrupt" };
	} finally {
		signal?.removeEventListener("abort", onAbort);
	}
}

export function canRequestApproval(ctx: ExtensionContext): boolean {
	return ctx.hasUI && ctx.mode === "tui";
}

export function approvalOptions(decision: ReinsDecision, persistence: ApprovalPersistence): ChoiceOption[] {
	const options: ChoiceOption[] = [{ value: "allow_once", label: "Allow once" }];
	const candidate = grantCandidateForRequirement(decision.requirement);
	if (candidate) {
		if (candidate.scopes.includes("session")) {
			const qualifier = persistence === "session" ? " (not saved)" : "";
			options.push({ value: "allow_session", label: `Allow for session${qualifier}: ${grantCandidateDescription(candidate)}` });
		}
		if (persistence === "workspace" && candidate.scopes.includes("workspace")) {
			options.push({ value: "allow_workspace", label: `Allow in workspace: ${grantCandidateDescription(candidate)}` });
		}
	}
	options.push({ value: "deny", label: "Deny" });
	return options;
}

function approvalTitle(decision: ReinsDecision): string {
	if (decision.requirement?.type === "pathAccess") {
		return decision.requirement.candidate.sensitivity === "privacy" ? "Approve privacy path access?" : "Approve path access?";
	}
	return decision.request.command ? "Approve command?" : "Approve action?";
}

function approvalDetails(decision: ReinsDecision): string[] {
	const request = decision.request;
	const lines = [
		request.summary,
		`Reason: ${decision.reason}`,
		`Effects: ${request.effects.join(", ") || "none"}`,
	];
	const candidate = grantCandidateForRequirement(decision.requirement);
	if (candidate) lines.push(`Grant: ${grantCandidateDescription(candidate)}`);
	const blockedPaths = request.paths.filter((path) => !path.allowed);
	if (blockedPaths.length === 0) return lines;
	return [...lines, ...pathDetailLines(blockedPaths)];
}

function grantCandidateDescription(candidate: GrantCandidate): string {
	if (candidate.description.length > 0) return candidate.description;
	if (candidate.type === "commandPrefix") return candidate.prefix.join(" ");
	if (candidate.type === "commandFamily") return `${candidate.family} (${candidate.pathScope})`;
	return `${candidate.operations.join("/")} ${candidate.roots.join(", ")}`;
}

function grantCandidateForRequirement(requirement: ApprovalRequirement | undefined): GrantCandidate | undefined {
	return requirement?.candidate;
}

function pathDetailLines(paths: PathAccess[]): string[] {
	const lines = [`Paths: ${paths.length}`];
	for (const path of paths.slice(0, 4)) {
		lines.push(`- ${path.operation} ${path.path}`);
		if (path.resolvedPath !== path.absolutePath) lines.push(`  resolves to ${path.resolvedPath}`);
	}
	if (paths.length > 4) lines.push(`- ${paths.length - 4} more`);
	return lines;
}
