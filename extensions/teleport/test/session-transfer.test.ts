import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import {
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	initTheme,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import teleport from "../index.ts";
import { readTeleportMarker } from "../session-marker.ts";
import { TeleportConnection } from "../transport/connection.ts";
import type { WorkspaceClient } from "../workspace/client.ts";

const cleanups: Array<() => Promise<void>> = [];
const closed = new Set<TeleportConnection>();
const opened = new Set<TeleportConnection>();

beforeEach(() => {
	initTheme("dark", false);
	closed.clear();
	opened.clear();
	vi.spyOn(TeleportConnection.prototype, "start").mockImplementation(async function (this: TeleportConnection) {
		opened.add(this);
	});
	vi.spyOn(TeleportConnection.prototype, "close").mockImplementation(async function (this: TeleportConnection) {
		closed.add(this);
	});
	vi.spyOn(TeleportConnection.prototype, "assertReady").mockImplementation(function (this: TeleportConnection) {
		if (closed.has(this)) throw new Error("Workspace is closed");
	});
	vi.spyOn(TeleportConnection.prototype, "ready", "get").mockReturnValue({
		cwd: "/workspace/project",
		root: "/workspace/project",
		home: "/home/fixture",
		pid: 1,
		runtime: "node",
		shell: "/bin/sh",
		capabilities: { find: true, grep: true },
	});
	vi.spyOn(TeleportConnection.prototype, "workspace", "get").mockReturnValue({
		context: async () => [{ path: "/workspace/project/AGENTS.md", content: "Remote project instructions" }],
		skills: async () => [],
		prompts: async () => [],
	} as unknown as WorkspaceClient);
});

afterEach(async () => {
	try {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
		expect([...opened].every((connection) => closed.has(connection))).toBe(true);
	} finally {
		vi.restoreAllMocks();
	}
});

async function createRuntime(clientZdr: boolean, target: string | null = "fixture:/workspace/project") {
	const root = mkdtempSync(join(tmpdir(), "pi-session-transfer-"));
	const cwd = join(root, "client");
	const agentDir = join(root, "agent");
	mkdirSync(cwd);
	const faux = fauxProvider();
	let runtime: AgentSessionRuntime | undefined;
	cleanups.push(async () => {
		try {
			await runtime?.dispose();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	const model = faux.getModel();
	const create: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({
			cwd,
			agentDir,
			settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }),
			extensionFlagValues: target ? new Map([["teleport", target]]) : undefined,
			resourceLoaderOptions: {
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				extensionFactories: [
					(pi) =>
						pi.registerProvider(model.provider, {
							api: model.api,
							apiKey: "fixture-key",
							baseUrl: model.baseUrl,
							models: [{ ...model, zdr: true }],
							streamSimple: faux.provider.streamSimple,
						}),
					teleport,
				],
			},
		});
		return {
			...(await createAgentSessionFromServices({
				services,
				sessionManager,
				sessionStartEvent,
				model,
				privacy: { clientZdr, remoteZdr: false },
			})),
			services,
			diagnostics: services.diagnostics,
		};
	};
	runtime = await createAgentSessionRuntime(create, {
		cwd,
		agentDir,
		sessionManager: clientZdr ? SessionManager.inMemory(cwd) : SessionManager.create(cwd, join(root, "sessions")),
	});
	const failures: string[] = [];
	const bind = async () => {
		await runtime!.session.bindExtensions({
			mode: "rpc",
			shutdownHandler: (reason) => {
				failures.push(reason ?? "shutdown");
			},
			onError: (error) => {
				failures.push(error.error);
			},
		});
		expect(failures).toEqual([]);
	};
	runtime.setRebindSession(bind);
	await bind();
	if (target)
		expect(readTeleportMarker(runtime.session.sessionManager.getEntries())).toEqual({
			protocolVersion: 1,
			destination: "fixture",
			cwd: "/workspace/project",
		});
	return { runtime, faux, root, failures };
}

test.each([
	[true, false],
	[true, true],
	[false, true],
	[false, false],
])("continues an exported Teleport session (client ZDR %s to %s)", async (sourceZdr, targetZdr) => {
	const source = await createRuntime(sourceZdr);
	source.faux.setResponses([fauxAssistantMessage("Before transfer")]);
	await source.runtime.session.prompt("Remember the project name: maple.");
	const jsonl = join(source.root, "export with spaces.jsonl");
	source.runtime.session.exportToJsonl(jsonl);
	const original = readFileSync(jsonl, "utf8");
	const html = join(source.root, "export with spaces.html");
	await source.runtime.session.exportToHtml(html);
	const payload = readFileSync(html, "utf8").match(
		/<script id="session-data" type="application\/json">([^<]+)<\/script>/,
	)?.[1];
	expect(payload).toBeDefined();
	expect(Buffer.from(payload ?? "", "base64").toString("utf8")).toContain("maple");
	const target = await createRuntime(targetZdr);
	await expect(target.runtime.importFromJsonl(jsonl)).resolves.toEqual({ cancelled: false });
	expect(target.runtime.session.sessionManager.isPersisted()).toBe(!targetZdr);
	expect(readTeleportMarker(target.runtime.session.sessionManager.getEntries())).toEqual({
		protocolVersion: 1,
		destination: "fixture",
		cwd: "/workspace/project",
	});
	let received = "";
	target.faux.setResponses([
		(context) => {
			received = JSON.stringify(context.messages);
			return fauxAssistantMessage("After transfer");
		},
	]);
	await target.runtime.session.prompt("Continue after importing.");
	expect(received).toContain("Remember the project name: maple.");
	expect(readFileSync(jsonl, "utf8")).toBe(original);
	expect(target.failures).toEqual([]);
	if (targetZdr) expect(existsSync(join(target.root, "sessions"))).toBe(false);
	const repeated = join(target.root, "continued.jsonl");
	target.runtime.session.exportToJsonl(repeated);
	await expect(target.runtime.importFromJsonl(repeated)).resolves.toEqual({ cancelled: false });
	expect(readTeleportMarker(target.runtime.session.sessionManager.getEntries())?.cwd).toBe("/workspace/project");
});

test.each([
	["ordinary", undefined],
	["host", { protocolVersion: 1, destination: "different", cwd: "/workspace/project" }],
	["cwd", { protocolVersion: 1, destination: "fixture", cwd: "/workspace/different" }],
])("refuses an incompatible %s binding without replacing the conversation", async (_label, marker) => {
	const target = await createRuntime(false);
	const original = target.runtime.session;
	const source = SessionManager.inMemory(target.runtime.cwd);
	if (marker) source.appendCustomEntry("pi.teleport.workspace.v1", marker);
	const jsonl = join(target.root, "different.jsonl");
	writeFileSync(
		jsonl,
		[source.getHeader(), ...source.getEntries()].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
	);
	await expect(target.runtime.importFromJsonl(jsonl)).resolves.toEqual({ cancelled: true });
	expect(target.runtime.session).toBe(original);
});

test("refuses a Teleport import when no target was requested", async () => {
	const source = await createRuntime(true);
	const jsonl = join(source.root, "teleport.jsonl");
	source.runtime.session.exportToJsonl(jsonl);
	const target = await createRuntime(false, null);
	const original = target.runtime.session;
	await expect(target.runtime.importFromJsonl(jsonl)).resolves.toEqual({ cancelled: true });
	expect(target.runtime.session).toBe(original);
	expect(target.failures).toEqual([]);
});

test("preserves a disconnected session until its workspace is reconnected", async () => {
	const target = await createRuntime(true);
	const jsonl = join(target.root, "teleport.jsonl");
	target.runtime.session.exportToJsonl(jsonl);
	const original = target.runtime.session;
	const runner = original.extensionRunner;
	const command = runner.getCommand("teleport")!;
	await command.handler("disconnect", runner.createCommandContext());
	await expect(target.runtime.importFromJsonl(jsonl)).resolves.toEqual({ cancelled: true });
	expect(target.runtime.session).toBe(original);
	await command.handler("reconnect", runner.createCommandContext());
	await expect(target.runtime.importFromJsonl(jsonl)).resolves.toEqual({ cancelled: false });
	expect(target.failures).toEqual([]);
});
