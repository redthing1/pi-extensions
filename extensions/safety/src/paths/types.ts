import type { ToolPathOperation } from "../../../shared/tool-effects.ts";

export type PathOperation = ToolPathOperation;

export type PathScope = "workspace" | "outside-workspace";
export type ProtectedPathKind = "secret" | "privacy" | "custom";

export type PathDecisionReason =
	| "allowed"
	| "outside-read-roots"
	| "outside-write-roots"
	| "protected-path"
	| "symlink-escapes-root";

export interface PathAccess {
	operation: PathOperation;
	path: string;
	absolutePath: string;
	resolvedPath: string;
	scope: PathScope;
	protected: boolean;
	protectedKind?: ProtectedPathKind;
	allowed: boolean;
	reason: PathDecisionReason;
	matchedPattern?: string;
}
