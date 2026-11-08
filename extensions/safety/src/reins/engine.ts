import type { EffectiveSafetyPolicy } from "../config/types.js";
import type { SafetyRequest } from "../controller/types.js";
import type { ApprovalRequirement } from "./requirements.js";
import type { ReinsDecision } from "./types.js";
import { pathDecisionForRequest } from "./path-access.js";
import { deniedByPrefix, firstGrantCandidate } from "./rules.js";

export function decideWithReins(policy: EffectiveSafetyPolicy, request: SafetyRequest): ReinsDecision {
	if (!policy.enabled || policy.reins.mode === "off") {
		return allow(request, "Safety is off");
	}

	if (request.shell) {
		const denied = deniedByPrefix(request.shell, policy.denyCommandPrefixes);
		if (denied) return block(request, denied);
	}

	if (request.risk === "catastrophic") {
		return block(request, request.reason);
	}

	const pathDecision = pathDecisionForRequest(request);
	if (pathDecision.kind === "block") return block(request, pathDecision.reason);

	if (policy.reins.mode === "observe") {
		return allow(request, "observe mode allows after audit");
	}

	if (policy.reins.mode === "read-only") {
		const readOnlyBlock = readOnlyBlockReason(request);
		if (readOnlyBlock) return block(request, readOnlyBlock);
		if (pathDecision.kind === "ask") return ask(request, pathDecision.reason, pathDecision.requirement);
		return decideReadOnly(request);
	}

	if (pathDecision.kind === "ask") return ask(request, pathDecision.reason, pathDecision.requirement);

	if (policy.reins.mode === "accept-edits") {
		return decideAcceptEdits(request);
	}

	return decideGuarded(request);
}

function decideReadOnly(request: SafetyRequest): ReinsDecision {
	const reason = readOnlyBlockReason(request);
	if (reason) return block(request, reason);
	if (request.risk === "safe") return allow(request, "read-only safe action");
	if (request.risk === "safe_read") return allow(request, "read-only safe read");
	return block(request, `read-only mode blocks ${request.risk} actions`);
}

function readOnlyBlockReason(request: SafetyRequest): string | undefined {
	if (request.effects.includes("write_files")) return "read-only mode blocks file writes";
	if (request.effects.includes("network")) return "read-only mode blocks network-capable commands";
	if (request.effects.includes("external_state")) return "read-only mode blocks external-state commands";
	if (request.effects.includes("run_command") && request.risk !== "safe_read") {
		return `read-only mode blocks ${request.risk} commands`;
	}
	return undefined;
}

function decideAcceptEdits(request: SafetyRequest): ReinsDecision {
	if (request.effects.includes("run_command")) {
		if (request.risk === "safe_read" && !request.effects.includes("network") && !request.effects.includes("external_state")) {
			return allow(request, "safe local read-only command");
		}
		if (request.risk === "dangerous") return block(request, `dangerous command requires approval: ${request.reason}`);
		if (request.risk === "unknown") return askCommand(request, `command requires approval: ${request.reason}`);
	}
	if (request.risk === "unknown") return askCommand(request, request.reason);
	if (request.risk === "dangerous") return block(request, request.reason);
	return allow(request, "accept-edits mode allows known workspace action");
}

function decideGuarded(request: SafetyRequest): ReinsDecision {
	if (request.risk === "safe" || request.risk === "safe_read" || request.risk === "mutating") {
		return allow(request, "guarded mode allows known action");
	}
	if (request.risk === "dangerous") return askCommand(request, `dangerous action requires approval: ${request.reason}`);
	return askCommand(request, request.reason);
}

function allow(request: SafetyRequest, reason: string): ReinsDecision {
	return { kind: "allow", reason, request };
}

function ask(request: SafetyRequest, reason: string, requirement: ApprovalRequirement): ReinsDecision {
	return {
		kind: "ask",
		reason,
		request,
		requirement,
	};
}

function block(request: SafetyRequest, reason: string): ReinsDecision {
	return { kind: "block", reason, request };
}

function askCommand(request: SafetyRequest, reason: string): ReinsDecision {
	return ask(request, reason, {
		type: "command",
		reason,
		candidate: request.shell ? firstGrantCandidate(request.shell, request.cwd, request.workspaceRoot) : undefined,
	});
}
