import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runCommand, runSuccessfulCommand } from "./util/process.js";

const DEFAULT_MODEL = "opencode-go/deepseek-v4-flash";
const model = process.env.SAFETY_TUI_MODEL ?? DEFAULT_MODEL;
const keepWorkspace = process.env.SAFETY_TUI_KEEP === "1";
const agentDir = process.env.SAFETY_TUI_AGENT_DIR ?? join(homedir(), ".pi", "agent");

async function main(): Promise<void> {
	const workspace = mkdtempSync(join(tmpdir(), "pi-safety-tui-"));
	const session = `pi-safety-tui-${process.pid}-${Date.now()}`;
	const markerPath = join(tmpdir(), `pi-safety-outside-${process.pid}-${Date.now()}`);
	const marker = `TUI_MARKER_SHOULD_NOT_LEAK_${process.pid}`;
	writeFileSync(markerPath, `${marker}\n`, "utf-8");

	try {
		await assertTmuxAvailable();
		await runSuccessfulCommand("tmux", ["new-session", "-d", "-s", session, "-x", "100", "-y", "30", "zsh -f"], workspace);
		await sendLine(session, `cd ${shellQuote(workspace)} && pi --model ${shellQuote(model)} --safety --safety-profile explore`);
		await waitForCapture(session, workspace, (capture) => capture.includes("Safety enabled: explore"), "Safety startup");
		await sendLine(session, "/safety");
		const panelCapture = await waitForCapture(
			session,
			workspace,
			(capture) => capture.includes("Safety") && capture.includes("Profile") && capture.includes("Reins"),
			"Safety panel",
		);
		writeFileSync(join(workspace, "panel-capture.txt"), panelCapture, "utf-8");
		assert(panelCapture.includes("Safety"), "TUI panel should show Safety title");
		assert(panelCapture.includes("Profile"), "TUI panel should show Profile row");
		assert(panelCapture.includes("Reins"), "TUI panel should show Reins row");
		assert(panelCapture.includes("Containment"), "TUI panel should show Containment row");
		assert(panelCapture.includes("Approvals"), "TUI panel should show Approvals row");
		await sendKey(session, "Down");
		await sendKey(session, "Enter");
		await sleep(500);
		const choiceCapture = await runSuccessfulCommand("tmux", ["capture-pane", "-t", session, "-p", "-S", "-200"], workspace);
		writeFileSync(join(workspace, "profile-choice-capture.txt"), choiceCapture, "utf-8");
		assert(choiceCapture.includes("Profile"), "profile chooser should render");
		assert(choiceCapture.includes("Read-only inspection with no network."), "profile chooser should render selected profile description");
		await sendKey(session, "Down");
		await sendKey(session, "Enter");
		await sleep(1000);
		const changedPanelCapture = await runSuccessfulCommand("tmux", ["capture-pane", "-t", session, "-p", "-S", "-200"], workspace);
		writeFileSync(join(workspace, "panel-profile-change-capture.txt"), changedPanelCapture, "utf-8");
		assert(changedPanelCapture.includes("code"), "TUI panel should update selected profile to code");
		await sendKey(session, "Escape");
		await sleep(500);
		await sendLine(session, "/safety status");
		await sleep(1000);
		const statusCapture = await runSuccessfulCommand("tmux", ["capture-pane", "-t", session, "-p", "-S", "-200"], workspace);
		assert(statusCapture.includes("Safety: Code"), "status should reflect profile changed from the panel");
		await sendLine(session, "!touch approval-loop-created.txt");
		await sleep(1000);
		const approvalCapture = await runSuccessfulCommand("tmux", ["capture-pane", "-t", session, "-p", "-S", "-200"], workspace);
		writeFileSync(join(workspace, "approval-choice-capture.txt"), approvalCapture, "utf-8");
		assert(approvalCapture.includes("Approve command?"), "approval prompt should render");
		assert(approvalCapture.includes("Deny"), "approval prompt should include Deny");
		await sendKey(session, "Up");
		await sendKey(session, "Enter");
		await sleep(1000);
		assert(!existsSync(join(workspace, "approval-loop-created.txt")), "approval prompt Up from first should wrap to Deny");
		await sendLine(session, "!touch approval-note-created.txt");
		await sleep(1000);
		await sendKey(session, "Up");
		await sendKey(session, "Tab");
		await sleep(500);
		const noteCapture = await runSuccessfulCommand("tmux", ["capture-pane", "-t", session, "-p", "-S", "-200"], workspace);
		writeFileSync(join(workspace, "approval-note-capture.txt"), noteCapture, "utf-8");
		assert(noteCapture.includes("Deny with note"), "approval prompt should open optional deny note input");
		await sendLiteral(session, "do not create the marker");
		await sendKey(session, "Enter");
		await sleep(1000);
		assert(!existsSync(join(workspace, "approval-note-created.txt")), "approval deny note should still deny the command");
		await sendLine(session, "!pwd");
		await sleep(1000);
		await sendLine(session, `!cat ${markerPath}`);
		await sleep(1000);
		await sendKey(session, "Up");
		await sendKey(session, "Enter");
		await sleep(1000);

		const capture = await runSuccessfulCommand("tmux", ["capture-pane", "-t", session, "-p", "-S", "-200"], workspace);
		writeFileSync(join(workspace, "tui-capture.txt"), capture, "utf-8");
		assert(capture.includes("Safety: Code"), "TUI capture should show the active Safety profile");
		assert(capture.includes(resolve(workspace)) || capture.includes(workspace), "TUI capture should show pwd output");
		assert(capture.includes("user denied approval: do not create the marker"), "TUI capture should show deny note in blocked result");
		assert(!capture.includes(marker), "TUI capture should not leak outside marker content");

		const auditLine = await waitForAuditEntry(markerPath);
		assert(auditLine.includes('"decision":"block"'), "audit should record outside marker read as blocked");
		assert(auditLine.includes("outside-read-roots"), "audit should explain outside marker read as outside-read-roots");

		console.log(keepWorkspace ? `safety tui smoke: ok (${workspace})` : "safety tui smoke: ok");
		if (!keepWorkspace) rmSync(workspace, { recursive: true, force: true });
	} catch (error) {
		console.error(`safety tui smoke workspace kept for inspection: ${workspace}`);
		throw error;
	} finally {
		await runCommand("tmux", ["kill-session", "-t", session], workspace).catch(() => undefined);
		rmSync(markerPath, { force: true });
	}
}

async function assertTmuxAvailable(): Promise<void> {
	const result = await runCommand("tmux", ["-V"], process.cwd(), 10_000);
	assert(result.exitCode === 0, "tmux must be installed for the TUI smoke test");
}

async function sendLine(session: string, line: string): Promise<void> {
	await sendLiteral(session, line);
	await sendKey(session, "Enter");
}

async function sendLiteral(session: string, text: string): Promise<void> {
	await runSuccessfulCommand("tmux", ["send-keys", "-t", session, "-l", text], process.cwd());
}

async function sendKey(session: string, key: string): Promise<void> {
	await runSuccessfulCommand("tmux", ["send-keys", "-t", session, key], process.cwd());
}

async function waitForAuditEntry(needle: string): Promise<string> {
	const auditPath = join(agentDir, "safety", "audit", `${new Date().toISOString().slice(0, 10)}.jsonl`);
	for (let attempt = 0; attempt < 20; attempt += 1) {
		if (existsSync(auditPath)) {
			const audit = readFileSync(auditPath, "utf-8");
			const line = audit
				.split("\n")
				.find((entry) => entry.includes(needle));
			if (line) return line;
		}
		await sleep(250);
	}
	throw new Error(`audit did not include ${needle}`);
}

async function waitForCapture(
	session: string,
	cwd: string,
	matches: (capture: string) => boolean,
	label: string,
): Promise<string> {
	for (let attempt = 0; attempt < 40; attempt += 1) {
		const capture = await runSuccessfulCommand("tmux", ["capture-pane", "-t", session, "-p", "-S", "-200"], cwd);
		if (matches(capture)) return capture;
		await sleep(250);
	}
	throw new Error(`timed out waiting for ${label}`);
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function assert(condition: boolean, message: string): asserts condition {
	if (!condition) {
		throw new Error(message);
	}
}

await main();
