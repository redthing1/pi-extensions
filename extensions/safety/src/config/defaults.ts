import type { SafetyConfig } from "./types.js";
import { DEFAULT_PROTECTED_PATHS } from "./protected-paths.js";

export const DEFAULT_SAFETY_CONFIG: SafetyConfig = {
	enabled: false,
	profile: "code",
	audit: {
		enabled: true,
	},
	reins: {
		mode: "accept-edits",
		catastrophic: "block",
	},
	containment: {
		mode: "workspace-write",
		network: "none",
		environment: "minimal",
		filesystem: {
			read: ["."],
			write: ["."],
		},
	},
	protectedPaths: DEFAULT_PROTECTED_PATHS,
	denyCommandPrefixes: [],
};
