import type { BashOperations } from "@earendil-works/pi-coding-agent";
import type { ContainmentMode, EffectiveSafetyPolicy, NetworkMode } from "../config/types.js";

export type ContainmentBackend = "darwin-seatbelt" | "linux-bwrap";

export interface ContainmentPlan {
	enabled: boolean;
	backend?: ContainmentBackend;
	mode: ContainmentMode;
	network: NetworkMode;
	readRoots: string[];
	writeRoots: string[];
	protectedPaths: string[];
}

export interface ContainedCommand {
	command: string;
	cleanup?: () => void;
}

export interface ContainmentSupport {
	available: boolean;
	backend?: ContainmentBackend;
	reason?: string;
}

export interface ContainmentEngine {
	plan(policy: EffectiveSafetyPolicy): ContainmentPlan;
	support(policy: EffectiveSafetyPolicy): ContainmentSupport;
	bashOperations(policy: EffectiveSafetyPolicy, shellPath?: string): BashOperations | undefined;
}
