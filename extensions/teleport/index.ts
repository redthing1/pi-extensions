import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { getCurrentSystemMessage } from "@earendil-works/pi-ai";
import { safeTerminalLabel, safeTerminalText } from "@earendil-works/pi-tui";
import {
	type BashOperations,
	type BuildSystemPromptOptions,
	buildSystemPrompt,
	type ExtensionAPI,
	parseArgs,
	parseSessionEntries,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { createActiveWorkspacePublisher } from "../shared/active-workspace.ts";
import { createRemoteAutocompleteProvider } from "./autocomplete.ts";
import { registerTeleportCommand } from "./command.ts";
import { TeleportController, loadWorkspaceResources, emptyWorkspaceResources } from "./controller.ts";
import { teleportCustomPrompt } from "./prompt.ts";
import {
	assertMatchingMarker,
	hasTeleportMarker,
	readTeleportMarker,
	TELEPORT_MARKER_TYPE,
	type TeleportMarker,
} from "./session-marker.ts";
import { parseTeleportTarget } from "./target.ts";
import {
	createRemoteBashOperations,
	isTeleportClientTool,
	isTeleportToolAllowed,
	registerRemoteTools,
} from "./tools.ts";
import { consumeChildHandoff } from "./workspace/child.ts";

const EXTENSION_PATH = fileURLToPath(import.meta.url);

export default function teleportExtension(pi: ExtensionAPI): void {
	const cliArgs = process.argv.slice(2);
	const consumedHandoff = consumeChildHandoff();
	const teleportRequested =
		cliArgs.some((arg) => arg === "--teleport" || arg.startsWith("--teleport=")) || consumedHandoff.present;
	const publisher = createActiveWorkspacePublisher(
		pi,
		teleportRequested ? { phase: "connecting", label: "Teleport" } : undefined,
	);
	let controller: TeleportController | undefined;
	let bound = false;
	let selectedTools = new Set<string>();
	let toolsInstalled = false;
	let resourceRefresh = Promise.resolve();

	pi.registerFlag("teleport", { description: "Use a remote workspace through SSH: host[:path]", type: "string" });
	registerTeleportCommand(pi, () => controller);
	pi.on("project_trust", () => ({ trusted: teleportRequested ? "no" : "undecided" }));
	if (teleportRequested && parseArgs(cliArgs).fileArgs.length > 0) {
		pi.reportStartupError("Teleport does not support @file arguments because they read from the local filesystem");
	}

	pi.on("session_start", async (_event, ctx) => {
		const requested = pi.getFlag("teleport");
		bound =
			typeof requested === "string" || consumedHandoff.present || hasTeleportMarker(ctx.sessionManager.getEntries());
		if (!bound) return;
		selectedTools = new Set(pi.getActiveTools());
		pi.setActiveTools([...selectedTools].filter(isTeleportClientTool));
		try {
			const handoff = consumedHandoff.present ? await consumedHandoff.value : undefined;
			if (typeof requested === "string" && handoff)
				throw new Error("Explicit target and child handoff cannot be combined");
			const marker = readTeleportMarker(ctx.sessionManager.getEntries());
			if (typeof requested !== "string" && !handoff)
				throw new Error("This session is bound to Teleport; resume it with a matching --teleport target.");
			const target = handoff
				? { destination: handoff.destination, requestedPath: handoff.cwd }
				: parseTeleportTarget(requested as string);
			if (marker && marker.destination !== target.destination)
				throw new Error(`Session target mismatch: expected ${marker.destination}, received ${target.destination}`);
			if (!marker && hasConversation(ctx.sessionManager.getEntries()))
				throw new Error("Cannot activate Teleport on a nonempty ordinary session");
			let markerWritten = Boolean(marker);
			const report = (message: string, type: "info" | "warning" | "error") => {
				try {
					ctx.ui.notify(safeTerminalText(message), type);
				} catch {
					/* Notification failures must not interrupt recovery or cleanup. */
				}
			};
			const refresh = () => {
				resourceRefresh = resourceRefresh
					.catch(() => {})
					.then(async () => {
						if (controller === current) await ctx.refreshResources();
					});
				return resourceRefresh;
			};
			const current = new TeleportController({
				target,
				marker,
				...(handoff ? { borrowedSocketPath: handoff.socketPath } : {}),
				extensionPath: EXTENSION_PATH,
				async prepare(workspace) {
					await refresh();
					workspace.connection.assertReady();
					workspace.provider.workspace.assertActive();
					if (controller !== current) throw new Error("Teleport session was closed");
					const ready = workspace.connection.ready;
					registerRemoteTools(pi, workspace.client, { cwd: ready.cwd, home: ready.home }, workspace.outputs);
					if (!toolsInstalled) {
						selectedTools = new Set([...selectedTools, ...pi.getActiveTools()]);
						toolsInstalled = true;
					}
					if (!markerWritten) {
						pi.appendEntry(TELEPORT_MARKER_TYPE, current.marker);
						markerWritten = true;
					}
				},
				onChange(previous) {
					if (controller !== current) return;
					const state = current.state;
					const workspace = current.workspace;
					if (previous.phase === "connected" && !workspace) selectedTools = new Set(pi.getActiveTools());
					if (workspace) {
						publisher.publish({ phase: "ready", workspace: workspace.provider.workspace });
						const allowed = new Set(
							[
								...selectedTools,
								...pi.getActiveTools().filter((name) => workspace.provider.compatibleTools.has(name)),
							].filter((name) => isTeleportToolAllowed(name, workspace.provider.compatibleTools)),
						);
						if (selectedTools.size) allowed.add("read_output");
						pi.setActiveTools([...allowed]);
						const marker = current.marker!;
						ctx.ui.setWorkspaceInfo?.({ label: current.label, projectTrust: "isolated" });
						ctx.ui.setTitle(`${basename(marker.cwd)} — ${marker.destination}`);
						ctx.ui.setStatus(
							"teleport",
							ctx.ui.theme.fg("accent", `teleport ${safeTerminalLabel(current.label)}`),
						);
						report(`Teleport ready: ${current.label}`, "info");
					} else if (state.phase !== "closed") {
						pi.setActiveTools([...selectedTools].filter(isTeleportClientTool));
						if (state.phase === "disconnecting") ctx.abort();
						void refresh().catch((error) => {
							if (controller === current) report(`Teleport resource refresh failed: ${String(error)}`, "error");
						});
						publisher.publish(
							state.phase === "connecting"
								? { phase: "connecting", label: current.label }
								: {
										phase: "failed",
										label: current.label,
										reason:
											state.phase === "disconnected" || state.phase === "disconnecting"
												? (state.reason ?? "Disconnected")
												: "Disconnected",
									},
						);
						ctx.ui.setStatus("teleport", `teleport ${state.phase}`);
						if (state.phase === "disconnected") {
							if (state.reason) report(`Teleport: ${state.reason}`, "warning");
							if (current.cleanup) report(current.cleanup, "warning");
						}
					}
				},
			});
			controller = current;
			current.outputs.register(pi);
			ctx.ui.addAutocompleteProvider((base) =>
				createRemoteAutocompleteProvider(base, () =>
					controller === current ? current.workspace?.client : undefined,
				),
			);
			try {
				await current.reconnect();
			} catch {
				// A live interactive client must remain recoverable after a failed connection.
			}
			if (ctx.mode === "print" && !current.workspace && controller === current)
				ctx.shutdown("Teleport workspace is unavailable");
		} catch (error) {
			pi.setActiveTools([]);
			const reason = error instanceof Error ? error.message : String(error);
			publisher.publish({ phase: "failed", label: "Teleport", reason });
			ctx.ui.setStatus("teleport", "teleport failed");
			ctx.shutdown(safeTerminalText(`Teleport startup failed: ${reason}`));
		}
	});

	pi.on("resources_discover", async (event, ctx) => {
		if (!bound) return;
		const current = controller;
		const workspace = current?.workspace;
		if (event.reason === "reload" && workspace) {
			try {
				const resources = await loadWorkspaceResources(workspace.client);
				if (controller === current && current?.workspace === workspace) workspace.resources = resources;
			} catch (error) {
				workspace.resources = emptyWorkspaceResources();
				ctx.ui.notify(safeTerminalText(`Teleport resource reload failed: ${String(error)}`), "error");
			}
		}
		const resources = current?.resources ?? emptyWorkspaceResources();
		return { replaceSkills: resources.skillDocuments, replacePrompts: resources.promptDocuments };
	});

	function remotePromptOptions(options: BuildSystemPromptOptions) {
		const current = controller;
		const workspace = current?.workspace;
		const selected = pi
			.getActiveTools()
			.filter((name) =>
				workspace ? isTeleportToolAllowed(name, workspace.provider.compatibleTools) : isTeleportClientTool(name),
			);
		const customPrompt = teleportCustomPrompt(consumedHandoff.present, options.customPrompt);
		return {
			...options,
			customPrompt: workspace
				? customPrompt
				: `${customPrompt}\nTeleport is disconnected. Remote workspace tools are unavailable. The user can restore access with /teleport reconnect.`,
			forceSystemPrompt: undefined,
			appendSystemPrompt: "",
			cwd: current?.marker?.cwd ?? "/",
			contextFiles: workspace?.resources.contextFiles ?? [],
			skills: workspace ? (options.skills ?? []) : [],
			includePiDocumentation: false,
			selectedTools: selected,
		};
	}
	pi.on("before_agent_start", (event) => {
		if (!bound) return;
		Object.assign(event.systemPromptOptions, remotePromptOptions(event.systemPromptOptions));
		pi.setActiveTools(event.systemPromptOptions.selectedTools);
		return { systemPrompt: buildSystemPrompt(event.systemPromptOptions) };
	});
	pi.on("context_with_system", (event, ctx) => {
		if (!bound) return;
		const options = remotePromptOptions(ctx.getSystemPromptOptions());
		const current = getCurrentSystemMessage(event.messages);
		return {
			messages: [
				{
					role: "system" as const,
					content: buildSystemPrompt(options),
					toolsAdded: current?.toolsAdded?.filter((tool) => options.selectedTools.includes(tool.name)),
					timestamp: current?.timestamp ?? 0,
				},
				...event.messages.filter((message) => message.role !== "system"),
			],
		};
	});
	pi.on("output_file", async (event) => {
		if (!bound) return;
		if (!controller) throw new Error("Teleport session is unavailable");
		return { path: await controller.outputs.save(event.prefix, event.extension, event.data) };
	});
	pi.on("tool_call", (event) => {
		if (!bound) return;
		if (controller && isTeleportClientTool(event.toolName)) return;
		const workspace = controller?.workspace;
		if (!workspace) return { block: true, reason: "Teleport workspace is unavailable" };
		if (!isTeleportToolAllowed(event.toolName, workspace.provider.compatibleTools))
			return { block: true, reason: `Tool ${event.toolName} is not classified for Teleport` };
	});
	pi.on("user_bash", () => {
		if (!bound) return;
		const workspace = controller?.workspace;
		return {
			operations: workspace
				? createRemoteBashOperations(workspace.client, workspace.connection.ready, workspace.outputs)
				: unavailableBashOperations(),
		};
	});
	pi.on("session_before_switch", async (event, ctx) => {
		if (!bound) {
			if (event.reason === "new" || !event.targetSessionFile) return;
			try {
				if (!await readSessionMarker(event.targetSessionFile)) return;
				ctx.ui.notify("Resume this Teleport session with a matching --teleport target.", "error");
			} catch (error) {
				ctx.ui.notify(safeTerminalText(`Teleport session switch refused: ${String(error)}`), "error");
			}
			return { cancel: true };
		}
		const current = controller;
		if (!current?.workspace) {
			ctx.ui.notify("Teleport workspace is unavailable", "error");
			return { cancel: true };
		}
		if (event.reason === "new") return;
		try {
			if (!event.targetSessionFile) throw new Error("Teleport cannot resume a session without a file");
			const marker = await readSessionMarker(event.targetSessionFile);
			if (!marker) throw new Error("Selected session is not bound to Teleport");
			assertMatchingMarker(current.marker!, marker);
		} catch (error) {
			ctx.ui.notify(safeTerminalText(`Teleport session switch refused: ${String(error)}`), "error");
			return { cancel: true };
		}
	});
	pi.on("session_before_fork", (_event, ctx) => {
		if (!bound || controller?.workspace) return;
		ctx.ui.notify("Teleport workspace is unavailable", "error");
		return { cancel: true };
	});
	pi.on("session_shutdown", async (_event, ctx) => {
		const current = controller;
		controller = undefined;
		try {
			await current?.dispose();
		} catch {
			ctx.ui.notify("Teleport client output cleanup was incomplete", "warning");
		} finally {
			if (current?.cleanup) ctx.ui.notify(current.cleanup, "warning");
			bound = false;
			toolsInstalled = false;
			ctx.ui.setWorkspaceInfo?.(undefined);
			ctx.ui.setStatus("teleport", undefined);
			publisher.publish({ phase: "cleared" });
		}
	});
}

function hasConversation(entries: SessionEntry[]): boolean {
	return entries.some(
		(entry) => entry.type === "message" || entry.type === "custom_message" || entry.type === "compaction",
	);
}
async function readSessionMarker(path: string): Promise<TeleportMarker | undefined> {
	return readTeleportMarker(
		parseSessionEntries(await readFile(path, "utf8")).filter(
			(entry): entry is SessionEntry => entry.type !== "session",
		),
	);
}
function unavailableBashOperations(): BashOperations {
	return {
		exec: async () => {
			throw new Error("Teleport workspace is unavailable");
		},
	};
}
