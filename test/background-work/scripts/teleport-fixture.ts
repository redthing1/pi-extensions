// Test-only composition of the real Teleport transport and workspace tools.
// No Docker control, host file tools, or provider credentials are exposed here.
import {
	buildSystemPrompt,
	type BashOperations,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { createActiveWorkspacePublisher } from "../../../extensions/shared/active-workspace.ts";
import { TeleportConnection } from "../../../extensions/teleport/transport/connection.ts";
import { SessionOutputs } from "../../../extensions/teleport/outputs.ts";
import {
	createRemoteBashOperations,
	registerRemoteTools,
} from "../../../extensions/teleport/tools.ts";
import { registerBackgroundWork } from "../../../extensions/background-work/index.ts";

const allowed = [
	"read",
	"bash",
	"write",
	"edit",
	"read_output",
	"background_status",
	"background_wait",
	"background_stop",
	"monitor",
];

export default function teleportFixture(pi: ExtensionAPI): void {
	const config = process.env.PI_BACKGROUND_SSH_CONFIG;
	const cwd = process.env.PI_BACKGROUND_REMOTE_CWD;
	if (!config || !cwd?.startsWith("/workspace/"))
		throw new Error(
			"Explicit synthetic SSH configuration and workspace required",
		);
	const publisher = createActiveWorkspacePublisher(pi, {
		phase: "connecting",
		label: "Docker fixture",
	});
	const outputs = new SessionOutputs();
	let shell: BashOperations | undefined;
	const connection = new TeleportConnection({
		destination: "background-fixture",
		sshConfigPath: config,
		onFailure(error) {
			shell = undefined;
			pi.setActiveTools([]);
			publisher.publish({
				phase: "failed",
				label: "Docker fixture",
				reason: error.message,
			});
		},
	});
	const getShell = () => {
		connection.assertReady();
		if (!shell) throw new Error("Container workspace is unavailable");
		return shell;
	};
	outputs.register(pi);
	pi.on("session_start", async () => {
		pi.setActiveTools([]);
		await connection.start(cwd);
		const remoteOutputs = outputs.attachRemote(
			connection.workspace,
			connection.scratch.path,
		);
		shell = createRemoteBashOperations(
			connection.workspace,
			connection.ready,
			remoteOutputs,
		);
		registerRemoteTools(
			pi,
			connection.workspace,
			connection.ready,
			remoteOutputs,
		);
		publisher.publish({
			phase: "ready",
			workspace: {
				identity: { label: "Docker fixture", ...connection.ready },
				assertActive: () => connection.assertReady(),
				registerCompatibleTool() {
					// The fixture allowlist below remains authoritative.
				},
			},
		});
		pi.setActiveTools(allowed);
	});
	pi.on("tool_call", (event) => {
		if (!allowed.includes(event.toolName))
			return { block: true, reason: "Not a container fixture tool" };
		try {
			getShell();
		} catch {
			return { block: true, reason: "Container workspace is unavailable" };
		}
	});
	pi.on("user_bash", () => ({ operations: getShell() }));
	pi.on("output_file", async (event) => ({
		path: await outputs.save(event.prefix, event.extension, event.data),
	}));
	pi.on("project_trust", () => ({ trusted: "no" }));
	pi.on("before_agent_start", (event) => {
		getShell();
		Object.assign(event.systemPromptOptions, {
			cwd,
			contextFiles: [],
			skills: [],
			selectedTools: allowed,
			includePiDocumentation: false,
			forceSystemPrompt: undefined,
			appendSystemPrompt: "",
		});
		return { systemPrompt: buildSystemPrompt(event.systemPromptOptions) };
	});
	registerBackgroundWork(pi);
	pi.on("session_shutdown", async () => {
		shell = undefined;
		try {
			await outputs.close();
		} finally {
			await connection.close();
		}
	});
}
