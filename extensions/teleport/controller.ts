import { SessionOutputs, type RemoteOutputs } from "./outputs.ts";
import { assertMatchingMarker, type TeleportMarker } from "./session-marker.ts";
import { teleportStartupPath, type parseTeleportTarget } from "./target.ts";
import { TeleportConnection } from "./transport/connection.ts";
import type { RemoteScratch } from "./transport/scratch.ts";
import type {
	WorkspaceClient,
	WorkspaceContextFile,
	WorkspacePromptDocument,
	WorkspaceSkillDocument,
} from "./workspace/client.ts";
import { createChildWorkspaceOperations } from "./workspace/child.ts";
import { createWorkspaceProvider, type TeleportWorkspaceProvider } from "./workspace/provider.ts";

const RESOURCE_DISCOVERY_TIMEOUT_MS = 15_000;

export interface WorkspaceResources {
	contextFiles: WorkspaceContextFile[];
	skillDocuments: WorkspaceSkillDocument[];
	promptDocuments: WorkspacePromptDocument[];
}

export interface ConnectedWorkspace {
	connection: TeleportConnection;
	client: WorkspaceClient;
	provider: TeleportWorkspaceProvider;
	resources: WorkspaceResources;
	outputs: RemoteOutputs;
}

export type TeleportState =
	| { phase: "disconnected"; reason?: string }
	| { phase: "connecting" }
	| { phase: "connected"; workspace: ConnectedWorkspace }
	| { phase: "disconnecting"; reason?: string }
	| { phase: "closed" };

interface ControllerOptions {
	target: ReturnType<typeof parseTeleportTarget>;
	marker?: TeleportMarker;
	borrowedSocketPath?: string;
	extensionPath: string;
	prepare(workspace: ConnectedWorkspace): Promise<void>;
	onChange(previous: TeleportState): void;
}

/** Session ownership stays here; every transport and capability belongs to one connection. */
export class TeleportController {
	readonly outputs = new SessionOutputs();
	private currentState: TeleportState = { phase: "disconnected" };
	private binding: TeleportMarker | undefined;
	private owner: TeleportConnection | undefined;
	private candidate: ConnectedWorkspace | undefined;
	private attempt: Promise<void> | undefined;
	private retirement: Promise<void> | undefined;
	private disposal: Promise<void> | undefined;
	private readonly residue: RemoteScratch[] = [];
	private untrackedResidue = false;
	private cleanupWarning: string | undefined;
	private readonly options: ControllerOptions;

	constructor(options: ControllerOptions) {
		this.options = options;
		this.binding = options.marker;
	}

	get state(): TeleportState {
		return this.currentState;
	}

	get marker(): TeleportMarker | undefined {
		return this.binding;
	}

	get label(): string {
		return `${this.options.target.destination}:${this.marker?.cwd ?? teleportStartupPath(this.options.target)}`;
	}

	get workspace(): ConnectedWorkspace | undefined {
		return this.state.phase === "connected" ? this.state.workspace : undefined;
	}

	get resources(): WorkspaceResources {
		return this.candidate?.resources ?? emptyWorkspaceResources();
	}

	get cleanup(): string | undefined {
		return this.residue.length || this.untrackedResidue
			? "Previous remote scratch removal could not be confirmed"
			: this.cleanupWarning;
	}

	reconnect(): Promise<void> {
		if (this.disposal) return Promise.reject(new Error("Teleport session is closed"));
		if (this.state.phase === "connected") return Promise.resolve();
		if (this.retirement) return this.retirement.then(() => this.reconnect());
		if (this.attempt) return this.attempt;
		const connection = new TeleportConnection({
			destination: this.options.target.destination,
			...(this.options.borrowedSocketPath ? { borrowedSocketPath: this.options.borrowedSocketPath } : {}),
			onFailure: (error) => {
				if (this.owner === connection)
					void this.disconnect(
						`Connection lost: ${error.message}. Interrupted operations may have taken effect remotely.`,
					);
			},
		});
		this.owner = connection;
		const attempt = Promise.resolve()
			.then(() => this.connect(connection))
			.finally(() => {
				if (this.attempt === attempt) this.attempt = undefined;
			});
		this.attempt = attempt;
		this.setState({ phase: "connecting" });
		return attempt;
	}

	private async connect(connection: TeleportConnection): Promise<void> {
		const assertOwner = () => {
			if (this.owner !== connection || this.disposal) throw new Error("Teleport connection attempt was canceled");
			connection.assertReady();
		};
		try {
			if (this.owner !== connection) return;
			await connection.start(this.marker?.cwd ?? teleportStartupPath(this.options.target));
			assertOwner();
			const ready = connection.ready;
			const marker: TeleportMarker = {
				protocolVersion: 1,
				destination: this.options.target.destination,
				cwd: ready.cwd,
			};
			if (this.marker) assertMatchingMarker(this.marker, marker);
			const client = connection.workspace;
			const resources = await loadWorkspaceResources(client);
			assertOwner();
			const provider = createWorkspaceProvider({
				client,
				identity: {
					label: `${marker.destination}:${marker.cwd}`,
					cwd: ready.cwd,
					root: ready.root,
					home: ready.home,
				},
				children: createChildWorkspaceOperations(connection.master, this.options.extensionPath),
			});
			this.binding = marker;
			this.candidate = {
				connection,
				client,
				provider,
				resources,
				outputs: this.outputs.attachRemote(client, connection.scratch.path),
			};
			// Cleanup never authenticates on its own. Only a validated replacement may retry
			// exact, nonce-owned residue retained by this living client instance.
			await Promise.all(
				this.residue.map(async (scratch) => {
					try {
						await scratch.remove(connection.master);
						const index = this.residue.indexOf(scratch);
						if (index !== -1) this.residue.splice(index, 1);
					} catch {
						/* Keep the exact owned path; cleanup failure cannot prevent recovery. */
					}
				}),
			);
			assertOwner();
			await this.options.prepare(this.candidate);
			assertOwner();
			this.setState({ phase: "connected", workspace: this.candidate });
		} catch (error) {
			if (this.owner !== connection) return;
			await this.disconnect(error instanceof Error ? error.message : String(error));
			throw error;
		}
	}

	disconnect(reason?: string): Promise<void> {
		if (this.retirement) return this.retirement;
		const connection = this.owner;
		if (!connection) return Promise.resolve();
		this.owner = undefined;
		this.attempt = undefined;
		this.candidate?.provider.invalidate();
		this.candidate?.outputs.invalidate();
		this.candidate = undefined;
		const retirement = Promise.resolve()
			.then(async () => {
				try {
					await connection.close();
				} catch {
					if (connection.scratch.needsCleanup) {
						if (this.residue.length < 16) this.residue.push(connection.scratch);
						else this.untrackedResidue = true;
					} else this.cleanupWarning = "Previous connection cleanup was incomplete";
				}
				if (!this.disposal) this.setState({ phase: "disconnected", ...(reason ? { reason } : {}) });
			})
			.finally(() => {
				if (this.retirement === retirement) this.retirement = undefined;
			});
		this.retirement = retirement;
		this.setState({ phase: "disconnecting", ...(reason ? { reason } : {}) });
		return retirement;
	}

	dispose(): Promise<void> {
		this.disposal ??= Promise.resolve().then(async () => {
			await this.disconnect();
			try {
				await this.outputs.close();
			} finally {
				this.residue.length = 0;
				this.setState({ phase: "closed" });
			}
		});
		return this.disposal;
	}

	private setState(state: TeleportState): void {
		const previous = this.state;
		this.currentState = state;
		try {
			this.options.onChange(previous);
		} catch {
			/* UI/reporting cannot interrupt ownership transitions or cleanup. */
		}
	}
}

export function emptyWorkspaceResources(): WorkspaceResources {
	return { contextFiles: [], skillDocuments: [], promptDocuments: [] };
}

export async function loadWorkspaceResources(
	client: Pick<WorkspaceClient, "context" | "skills" | "prompts">,
): Promise<WorkspaceResources> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const [contextFiles, skillDocuments, promptDocuments] = await Promise.race([
			Promise.all([client.context(), client.skills(), client.prompts()]),
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error("Teleport resource discovery timed out")), RESOURCE_DISCOVERY_TIMEOUT_MS);
			}),
		]);
		return { contextFiles, skillDocuments, promptDocuments };
	} finally {
		clearTimeout(timer);
	}
}
