import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import { registerSafetyCommands } from "./src/commands/register.js";
import { SafetyController } from "./src/controller/controller.js";
import type { SafetySessionSettings } from "./src/config/session-settings.js";
import { safetyProfileListText } from "./src/profiles/presets.js";
import { createSafetyChildPolicyContributor } from "./src/child/contributor.js";
import { readSafetyChildContext, type SafetyChildContext } from "./src/child/context.js";
import { readProvidedProjectSafetyConfig } from "./src/child/project-config.js";
import { observeActiveWorkspace, type WorkspaceAccess } from "../shared/active-workspace.ts";
import { publishChildPolicyContributor } from "../shared/child-runtime.ts";
import { observeToolEffectAnalyzers } from "../shared/tool-effects.ts";

export default function safetyExtension(pi: ExtensionAPI): void {
	const toolEffects = observeToolEffectAnalyzers(pi);
	pi.registerFlag("safety", {
		description: "Enable the Safety extension",
		type: "boolean",
		default: false,
	});
	pi.registerFlag("safety-profile", {
		description: `Safety profile: ${safetyProfileListText()}`,
		type: "string",
		default: "",
	});
	pi.registerFlag("safety-reins", {
		description: "Safety Reins override",
		type: "string",
		default: "",
	});
	pi.registerFlag("safety-containment", {
		description: "Safety Containment override",
		type: "string",
		default: "",
	});
	pi.registerFlag("safety-network", {
		description: "Safety network override: none or host",
		type: "string",
		default: "",
	});
	pi.registerFlag("safety-context", {
		description: "Inherited Safety context for a managed child process",
		type: "string",
		default: "",
	});

	let controller: SafetyController | undefined;
	let sessionSettings: SafetySessionSettings | undefined;
	let inheritedContext: SafetyChildContext | undefined;
	let inheritedContextLoaded = false;
	let latestContext: ExtensionContext | undefined;
	let workspaceAccess: WorkspaceAccess = { kind: "local" };
	const workspaces = observeActiveWorkspace(pi, (access) => {
		if (sameWorkspaceAccess(workspaceAccess, access)) return;
		workspaceAccess = access;
		if (controller) sessionSettings = controller.sessionSettingsSnapshot();
		controller = undefined;
		if (!latestContext) return;
		if (safetyUnavailableReason(access)) latestContext.ui.setStatus("safety", undefined);
		else if (access.kind === "ready") activate(latestContext);
	});
	workspaceAccess = workspaces.current();

	const makeController = (ctx: ExtensionContext): SafetyController => {
		if (controller) return controller;
		const unavailable = safetyUnavailableReason(workspaceAccess);
		if (unavailable) throw new Error(unavailable);
		const workspace = workspaceAccess.kind === "ready" ? workspaceAccess.workspace : undefined;
		const inherited = loadInheritedContext();
		controller = SafetyController.create({
			agentDir: getAgentDir(),
			cwd: ctx.cwd,
			workspace: workspace ? { cwd: workspace.identity.cwd, root: workspace.identity.root, home: workspace.identity.home } : undefined,
			pathOperations: workspace?.files,
			toolEffects,
			clientZdr: ctx.privacy.clientZdr,
			ephemeral: Boolean(inherited),
			initialGrants: inherited?.grants,
			approvedTools: inherited?.approvedTools,
			inheritedConfig: inherited?.policy,
			inheritedProjectConfig: inherited?.project?.config,
			inheritedProjectConfigPath: inherited?.project?.path,
			enabledOverride: Boolean(pi.getFlag("safety")),
			profileOverride: flagString(pi.getFlag("safety-profile")),
			reinsModeOverride: flagString(pi.getFlag("safety-reins")),
			containmentModeOverride: flagString(pi.getFlag("safety-containment")),
			networkOverride: flagString(pi.getFlag("safety-network")),
			sessionSettings,
		});
		return controller;
	};
	const loadInheritedContext = (): SafetyChildContext | undefined => {
		if (inheritedContextLoaded) return inheritedContext;
		inheritedContextLoaded = true;
		const contextPath = flagString(pi.getFlag("safety-context"));
		inheritedContext = contextPath ? readSafetyChildContext(contextPath) : undefined;
		return inheritedContext;
	};

	publishChildPolicyContributor(pi, createSafetyChildPolicyContributor({
		extensionPath: fileURLToPath(new URL(".", import.meta.url)),
		async contextFor(intent) {
			if (!latestContext) throw new Error("Safety cannot prepare a child before session start");
			const workspace = workspaceAccess.kind === "ready" ? workspaceAccess.workspace : undefined;
			const project = workspace?.files
				? await readProvidedProjectSafetyConfig(workspace.files, intent.cwd, workspace.identity.root)
				: undefined;
			return makeController(latestContext).childContext(intent, project);
		},
	}));

	const updateStatus = (ctx: ExtensionContext): void => {
		const active = makeController(ctx);
		ctx.ui.setStatus("safety", active.themedStatusLine(statusTheme(ctx)));
	};
	const activate = (ctx: ExtensionContext): void => {
		const active = makeController(ctx);
		active.notifyWarnings(ctx);
		updateStatus(ctx);
		if (active.policy().enabled) ctx.ui.notify(`Safety enabled: ${active.policy().profile}`, "info");
	};

	registerSafetyCommands(pi, {
		getController: (ctx: ExtensionCommandContext) => makeController(ctx),
		updateStatus,
	});

	pi.on("session_start", (_event, ctx) => {
		latestContext = ctx;
		if (!safetyUnavailableReason(workspaceAccess)) activate(ctx);
	});

	pi.on("tool_call", (event, ctx) => safetyUnavailableReason(workspaceAccess)
		? { block: true, reason: "blocked by Safety: active workspace is unavailable" }
		: makeController(ctx).handleToolCall(event, ctx));
	pi.on("bash_launch", (event, ctx) => safetyUnavailableReason(workspaceAccess)
		? { block: true, reason: "blocked by Safety: active workspace is unavailable" }
		: makeController(ctx).handleBashLaunch(event, ctx));
	pi.on("tool_result", (event) => {
		controller?.releaseChildAuthorization(event.toolCallId);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		controller = undefined;
		sessionSettings = undefined;
		inheritedContext = undefined;
		inheritedContextLoaded = false;
		latestContext = undefined;
		ctx.ui.setStatus("safety", undefined);
	});
}

function sameWorkspaceAccess(
	left: WorkspaceAccess,
	right: WorkspaceAccess,
): boolean {
	if (left.kind !== right.kind) return false;
	if (left.kind === "local" && right.kind === "local") return true;
	if (left.kind === "ready" && right.kind === "ready") {
		return left.workspace === right.workspace;
	}
	return left.kind === "unavailable" &&
		right.kind === "unavailable" &&
		left.label === right.label &&
		left.reason === right.reason;
}

function safetyUnavailableReason(access: WorkspaceAccess): string | undefined {
	if (access.kind === "unavailable") return "active workspace is unavailable";
	if (access.kind === "ready" && !access.workspace.files) return "active workspace does not provide path operations";
	return undefined;
}

function flagString(value: boolean | string | undefined): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function statusTheme(ctx: ExtensionContext): { fg(color: string, text: string): string } | undefined {
	const ui = ctx.ui as unknown as { theme?: { fg?: (color: string, text: string) => string } };
	return typeof ui.theme?.fg === "function" ? { fg: ui.theme.fg.bind(ui.theme) } : undefined;
}
