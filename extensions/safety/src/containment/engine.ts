import type { BashOperations } from "@earendil-works/pi-coding-agent";
import type { EffectiveSafetyPolicy } from "../config/types.js";
import { readRootsForPolicy, protectedPathsForPolicy, writeRootsForPolicy } from "./filesystem.js";
import { createContainedBashOperations } from "./operations.js";
import { containmentSupport } from "./support.js";
import type { ContainmentEngine, ContainmentPlan, ContainmentSupport } from "./types.js";

export class DefaultContainmentEngine implements ContainmentEngine {
	plan(policy: EffectiveSafetyPolicy): ContainmentPlan {
		const support = this.support(policy);
		return {
			enabled: policy.enabled && policy.containment.mode !== "off" && support.available,
			backend: support.backend,
			mode: policy.containment.mode,
			network: policy.containment.network,
			readRoots: readRootsForPolicy(policy, process.platform),
			writeRoots: writeRootsForPolicy(policy),
			protectedPaths: protectedPathsForPolicy(policy),
		};
	}

	support(policy: EffectiveSafetyPolicy): ContainmentSupport {
		return containmentSupport(policy);
	}

	bashOperations(policy: EffectiveSafetyPolicy, shellPath?: string): BashOperations | undefined {
		return createContainedBashOperations(policy, shellPath);
	}
}
