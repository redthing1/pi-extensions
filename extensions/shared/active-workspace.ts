import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const ACTIVE_WORKSPACE_CHANNEL = "rt1.active-workspace.v1";
const ACTIVE_WORKSPACE_QUERY_CHANNEL = "rt1.active-workspace.query.v1";

export interface WorkspaceIdentity {
	label: string;
	cwd: string;
	root: string;
	home?: string;
}

export interface WorkspacePathOperations {
	canonicalize(path: string): Promise<string>;
}

export interface WorkspaceFileOperations extends WorkspacePathOperations {
	resolveEntry(path: string): Promise<string>;
	exists(path: string): Promise<boolean>;
	read(path: string): Promise<Buffer>;
	write(path: string, content: Buffer): Promise<void>;
	ensureParent(path: string): Promise<void>;
	remove(path: string): Promise<void>;
	runExclusive<T>(path: string, operation: () => Promise<T>): Promise<T>;
}

export interface ChildWorkspaceAttachment {
	args: string[];
	hostCwd: string;
	env?: Record<string, string>;
	writeHandoff?(stream: NodeJS.WritableStream): void;
	dispose(): Promise<void>;
}

export interface ChildWorkspaceRequest {
	cwd: string;
}

export interface WorkspaceChildOperations {
	prepareChild(request: ChildWorkspaceRequest): Promise<ChildWorkspaceAttachment>;
}

export type IsolatedWorkspaceMode = "blank" | "copy";

export interface IsolatedWorkspaceRequest {
	namespace: string;
	date: string;
	id: string;
	source: string;
	mode: IsolatedWorkspaceMode;
	retention: "retain" | "ephemeral";
	stages: readonly string[];
}

export interface IsolatedWorkspaceLayout {
	root: string;
	base: string;
	digest: string;
	stages: Readonly<Record<string, string>>;
}

export interface IsolatedWorkspaceRun extends IsolatedWorkspaceLayout {
	dispose(): Promise<void>;
}

export interface WorkspaceIsolationOperations {
	prepare(request: IsolatedWorkspaceRequest): Promise<IsolatedWorkspaceRun>;
}

export interface ActiveWorkspace {
	identity: WorkspaceIdentity;
	files?: WorkspaceFileOperations;
	children?: WorkspaceChildOperations;
	isolation?: WorkspaceIsolationOperations;
	registerCompatibleTool(name: string): void;
	assertActive(): void;
}

export type ActiveWorkspaceState =
	| { phase: "connecting"; label: string }
	| { phase: "ready"; workspace: ActiveWorkspace }
	| { phase: "failed"; label: string; reason: string }
	| { phase: "cleared" };

export type WorkspaceAccess =
	| { kind: "local" }
	| { kind: "unavailable"; label: string; reason?: string }
	| { kind: "ready"; workspace: ActiveWorkspace };

export interface WorkspaceObserver {
	current(): WorkspaceAccess;
}

export interface WorkspacePublisher {
	publish(state: ActiveWorkspaceState): void;
}

export function createActiveWorkspacePublisher(
	pi: Pick<ExtensionAPI, "events">,
	initial?: ActiveWorkspaceState,
): WorkspacePublisher {
	let current = initial;
	pi.events.on(ACTIVE_WORKSPACE_QUERY_CHANNEL, () => {
		if (current) pi.events.emit(ACTIVE_WORKSPACE_CHANNEL, current);
	});
	if (current) pi.events.emit(ACTIVE_WORKSPACE_CHANNEL, current);
	return {
		publish(state) {
			current = state;
			pi.events.emit(ACTIVE_WORKSPACE_CHANNEL, state);
		},
	};
}

export function observeActiveWorkspace(
	pi: Pick<ExtensionAPI, "events">,
	onChange?: (access: WorkspaceAccess) => void,
): WorkspaceObserver {
	let access: WorkspaceAccess = { kind: "local" };
	pi.events.on(ACTIVE_WORKSPACE_CHANNEL, (value) => {
		const state = parseState(value);
		if (!state) return;
		if (state.phase === "ready") {
			access = { kind: "ready", workspace: state.workspace };
		} else if (state.phase === "connecting") {
			access = { kind: "unavailable", label: state.label };
		} else if (state.phase === "failed") {
			access = {
				kind: "unavailable",
				label: state.label,
				reason: state.reason,
			};
		} else {
			access = { kind: "local" };
		}
		onChange?.(access);
	});
	pi.events.emit(ACTIVE_WORKSPACE_QUERY_CHANNEL, undefined);
	return { current: () => access };
}

function parseState(value: unknown): ActiveWorkspaceState | undefined {
	if (typeof value !== "object" || value === null || !("phase" in value))
		return undefined;
	const state = value as Partial<ActiveWorkspaceState>;
	if (state.phase === "cleared") return { phase: "cleared" };
	if (state.phase === "connecting" && typeof state.label === "string") {
		return { phase: "connecting", label: state.label };
	}
	if (
		state.phase === "failed" &&
		typeof state.label === "string" &&
		typeof state.reason === "string"
	) {
		return { phase: "failed", label: state.label, reason: state.reason };
	}
	if (
		state.phase === "ready" &&
		typeof state.workspace === "object" &&
		state.workspace !== null
	) {
		return { phase: "ready", workspace: state.workspace as ActiveWorkspace };
	}
	return undefined;
}
