import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { EffectiveSafetyPolicy } from "../config/types.js";
import type { SafetyRequest } from "../controller/types.js";
import type { ReinsDecision } from "../reins/types.js";
import { nowIso } from "../util/time.js";
import type { SafetyAuditEvent } from "./types.js";

export class AuditRecorder {
	constructor(private readonly auditDir: string) {}

	record(policy: EffectiveSafetyPolicy, request: SafetyRequest, decision: ReinsDecision): void {
		if (!policy.audit.enabled) return;
		mkdirSync(this.auditDir, { recursive: true, mode: 0o700 });
		const event: SafetyAuditEvent = {
			version: 1,
			timestamp: nowIso(),
			workspaceRoot: policy.workspaceRoot,
			profile: policy.profile,
			reinsMode: policy.reins.mode,
			containment: {
				mode: policy.containment.mode,
				network: policy.containment.network,
			},
			source: request.source,
			toolName: request.toolName,
			summary: request.summary,
			effects: request.effects,
			risk: request.risk,
			decision: decision.kind,
			decisionReason: decision.reason,
			paths: request.paths.map((path) => ({
				path: path.path,
				operation: path.operation,
				allowed: path.allowed,
				reason: path.reason,
			})),
		};
		appendFileSync(join(this.auditDir, `${new Date().toISOString().slice(0, 10)}.jsonl`), `${JSON.stringify(event)}\n`, {
			encoding: "utf-8",
			mode: 0o600,
		});
	}
}

