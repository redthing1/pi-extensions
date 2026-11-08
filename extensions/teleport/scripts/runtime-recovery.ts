import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import teleportExtension from "../index.ts";
import { MasterConnection } from "../transport/master.ts";

const config = process.env.PI_TELEPORT_FIXTURE_CONFIG;
if (
	!config ||
	(await readFile(join(config, "..", ".fixture-marker"), "utf8")).trim() !== "pi-teleport-isolated-fixture"
)
	throw new Error("Disposable SSH fixture required");
const root = await mkdtemp(join(config, "..", "pi-teleport-runtime-recovery-"));
const cwd = join(root, "project");
const agentDir = join(root, "agent");
await mkdir(cwd);
await mkdir(agentDir);
const argv = process.argv;
process.argv = ["bun", "pi", "--teleport", "teleport-test:/workspace"];
const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
const modelRuntime = await ModelRuntime.create({
	authPath: join(agentDir, "auth.json"),
	modelsPath: null,
	allowModelNetwork: false,
});
const faux = fauxProvider();
modelRuntime.registerNativeProvider(faux.provider);
const loader = new DefaultResourceLoader({
	cwd,
	agentDir,
	settingsManager,
	noExtensions: true,
	noSkills: true,
	noPromptTemplates: true,
	noThemes: true,
	noContextFiles: true,
	extensionFactories: [teleportExtension],
});
await loader.reload();
loader.getExtensions().runtime.flagValues.set("teleport", "teleport-test:/workspace");
const { session } = await createAgentSession({
	cwd,
	agentDir,
	modelRuntime,
	model: faux.getModel(),
	resourceLoader: loader,
	sessionManager: SessionManager.inMemory(cwd),
	settingsManager,
	tools: ["read", "bash", "read_output"],
	privacy: { clientZdr: true },
});
const initialMasterStart = MasterConnection.prototype.start;
let master: MasterConnection | undefined;
MasterConnection.prototype.start = async function () {
	await initialMasterStart.call(this);
	master = this;
};
const mutation = "/workspace/teleport-runtime-recovery-once.txt";
try {
	await session.bindExtensions({ mode: "rpc" });
	assert(session.getActiveToolNames().includes("bash"));
	assert.notEqual(session.getAllTools().find((tool) => tool.name === "bash")?.sourceInfo.path, "builtin:bash");
	const probe = await session.agent.state.tools
		.find((tool) => tool.name === "bash")!
		.execute("verify-fixture-target", { command: "pwd" });
	assert.equal(
		probe.content[0]?.type === "text" && probe.content[0].text.trim(),
		"/workspace",
		"verify remote binding before injecting a fault",
	);
	const runner = session.extensionRunner;
	const command = runner.getCommand("teleport")!;
	const context = runner.createContext();
	const saved = await context.writeOutputFile("fixture", ".txt", "synthetic client output retained across SSH loss");
	session.setActiveToolsByName(["bash", "read_output"]);
	faux.setResponses([
		fauxAssistantMessage("Synthetic remembered reply"),
		fauxAssistantMessage(
			fauxToolCall("bash", {
				command: `test "$PWD" = /workspace && test -f /workspace/sentinel.txt && printf 'once\\n' >> ${mutation} && kill -KILL $PPID`,
			}),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("Must remain unrequested after transport loss"),
	]);
	await session.prompt("Remember synthetic token RUNTIME-RECOVERY-CANARY");
	const id = session.sessionId;
	await session.prompt("Run the synthetic disconnect operation");
	await session.waitForIdle();
	assert.equal(faux.getPendingResponseCount(), 1, "connection loss must stop the autonomous run");
	await waitFor(() => !session.getActiveToolNames().includes("bash"), "worker loss");
	assert.equal(session.sessionFile, undefined);
	assert.equal(session.sessionId, id);
	const before = structuredClone(session.messages);
	await command.handler("reconnect", runner.createCommandContext());
	assert(session.getActiveToolNames().includes("bash"));
	assert(!session.getActiveToolNames().includes("read"), "reconnect must preserve explicit tool deselection");
	session.setActiveToolsByName([...session.getActiveToolNames(), "read"]);
	assert.deepEqual(session.messages, before, "reconnect must not rebuild, persist, or replace the conversation");
	const read = session.agent.state.tools.find((tool) => tool.name === "read")!;
	const result = await read.execute("verify-once", { path: mutation });
	assert(JSON.stringify(result).includes("once"));
	assert.equal(
		execFileSync("/usr/bin/ssh", ["-F", config, "teleport-test", `cat ${mutation}`], { encoding: "utf8" }),
		"once\n",
	);
	const output = session.agent.state.tools.find((tool) => tool.name === "read_output")!;
	assert(
		JSON.stringify(await output.execute("local-output", { reference: saved })).includes(
			"synthetic client output retained",
		),
	);
	faux.setResponses([fauxAssistantMessage("Synthetic continuation after reconnect")]);
	await session.prompt("Continue with the same synthetic conversation");
	assert(JSON.stringify(session.messages).includes("RUNTIME-RECOVERY-CANARY"));
	assert(JSON.stringify(session.messages).includes("Synthetic continuation after reconnect"));
	// Lose the master itself: old cleanup cannot reconnect, but explicit recovery can
	// retry only the exact recorded scratch after validating the new target.
	assert(master);
	await master.close();
	await waitFor(() => !session.getActiveToolNames().includes("bash"), "master loss");
	await command.handler("reconnect", runner.createCommandContext());
	assert(session.getActiveToolNames().includes("bash"));
	assert.equal(session.sessionId, id);
	const container = "pi-teleport-test-sshd";
	const expectedId = (await readFile(join(config, "..", "container-id"), "utf8")).trim();
	assert.equal(
		execFileSync("docker", ["container", "inspect", "--format", "{{.Id}}", container], { encoding: "utf8" }).trim(),
		expectedId,
	);
	execFileSync("docker", ["restart", container], { stdio: "ignore" });
	await waitFor(() => !session.getActiveToolNames().includes("bash"), "endpoint loss");
	const port = execFileSync(
		"docker",
		[
			"container",
			"inspect",
			"--format",
			'{{(index (index .NetworkSettings.Ports "2222/tcp") 0).HostPort}}',
			container,
		],
		{ encoding: "utf8" },
	).trim();
	assert.match(port, /^[0-9]+$/);
	// Docker may reassign an automatically published port. Update only the two
	// fixture configs and retain the already trusted key of this exact container.
	const clientConfig = fileURLToPath(new URL("../../../home/.ssh/config", import.meta.url));
	for (const path of [config, clientConfig]) {
		await writeFile(path, (await readFile(path, "utf8")).replace(/^\s*Port\s+[0-9]+\s*$/m, `  Port ${port}`));
	}
	const knownHosts = join(config, "..", "known_hosts");
	await writeFile(
		knownHosts,
		(await readFile(knownHosts, "utf8")).replace(/^\[127\.0\.0\.1\]:[0-9]+ /gm, `[127.0.0.1]:${port} `),
	);
	await waitFor(() => {
		try {
			execFileSync("/usr/bin/ssh", ["-F", config, "teleport-test", "true"], { stdio: "ignore" });
			return true;
		} catch {
			return false;
		}
	}, "endpoint restart readiness");
	await command.handler("reconnect", runner.createCommandContext());
	assert(session.getActiveToolNames().includes("bash"));
	assert.equal(session.sessionId, id);
	assert.equal(
		execFileSync("/usr/bin/ssh", ["-F", config, "teleport-test", `cat ${mutation}`], { encoding: "utf8" }),
		"once\n",
	);
	await command.handler("disconnect", runner.createCommandContext());
	assert(!session.getActiveToolNames().includes("bash"));
	assert(
		JSON.stringify(await output.execute("local-disconnected-output", { reference: saved, release: true })).includes(
			"synthetic client output retained",
		),
	);
	await runner.emit({ type: "session_shutdown", reason: "quit" });
	assert.equal(session.sessionFile, undefined);
	assert(!(await readdir(agentDir)).some((name) => /session|log/i.test(name)));
	console.log(
		"teleport client-ZDR runtime recovery passed: same conversation, stopped loop, no replay, local output survival, master/endpoint loss, and teardown",
	);
} finally {
	MasterConnection.prototype.start = initialMasterStart;
	process.argv = argv;
	await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
	session.dispose();
	try {
		execFileSync("/usr/bin/ssh", ["-F", config, "teleport-test", `rm -f -- ${mutation}`], { stdio: "ignore" });
	} catch {}
	await rm(root, { recursive: true, force: true });
}
async function waitFor(condition: () => boolean, label: string) {
	for (let attempt = 0; attempt < 200; attempt++) {
		if (condition()) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error(`Timed out waiting for synthetic runtime state: ${label}`);
}
