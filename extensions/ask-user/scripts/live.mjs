// Trusted controller: synthetic inputs only, with all agent execution in Docker.
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { ContainerFixture } from "../../../test/background-work/scripts/container.mjs";

const checkout = process.env.PI_ASK_CHECKOUT;
const authSource = process.env.PI_ASK_AUTH_SOURCE;
if (!checkout || !authSource || !process.env.PI_ASK_DOCKER_IMAGE)
	throw Error(
		"Explicit checkout, authorized auth source, and reviewed local image required",
	);
process.env.PI_BACKGROUND_DOCKER_IMAGE = process.env.PI_ASK_DOCKER_IMAGE;
const extension = fileURLToPath(new URL("..", import.meta.url));
const agent = resolve(extension, "../..");
const root = fs.mkdtempSync(join(tmpdir(), "pi-ask-live-"));
const socket = join(root, "tmux.sock");
const audit = join(root, "audit.jsonl");
const container = new ContainerFixture(root);
const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;
let interrupted = false;
process.on("SIGTERM", () => {
	interrupted = true;
});
process.on("SIGINT", () => {
	interrupted = true;
});
const env = {
	PATH: process.env.PATH,
	HOME: join(root, "home"),
	TMPDIR: join(root, "tmp"),
	XDG_CONFIG_HOME: join(root, "home", ".config"),
	PI_CODING_AGENT_DIR: join(root, "agent"),
	ASK_AUDIT: audit,
	HISTFILE: "/dev/null",
	LANG: "en_US.UTF-8",
	TERM: "xterm-256color",
};
const tmux = (...args) => {
	const r = spawnSync("tmux", ["-S", socket, ...args], {
		env,
		cwd: join(root, "workspace"),
		encoding: "utf8",
		timeout: 5000,
	});
	if (r.status !== 0)
		throw Error(r.stderr || r.error?.message || "tmux failed");
	return r.stdout;
};
const capture = () => tmux("capture-pane", "-p", "-t", "ask");
const records = () =>
	fs.existsSync(audit)
		? fs
				.readFileSync(audit, "utf8")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((s) => JSON.parse(s))
		: [];
const until = async (condition, ms = 120000) => {
	const end = Date.now() + ms;
	while (!condition()) {
		if (interrupted || Date.now() > end)
			throw Error("Live fixture interrupted or deadline exceeded");
		await delay(100);
	}
};
const send = async (...keys) => {
	tmux("send-keys", "-t", "ask", ...keys);
	await delay(150);
};
const type = (text) => tmux("send-keys", "-t", "ask", "-l", text);
try {
	for (const name of ["home", "agent", "tmp", "workspace"])
		fs.mkdirSync(join(root, name), { mode: 0o700 });
	// Copy precisely the authorized provider entry, never log or expose it to the worker.
	const credential = JSON.parse(fs.readFileSync(authSource, "utf8"))[
		"opencode-go"
	];
	if (
		credential?.type !== "api_key" ||
		typeof credential.key !== "string" ||
		!credential.key ||
		credential.key.startsWith("!")
	)
		throw Error("Selected provider requires a literal stored key");
	fs.writeFileSync(
		join(root, "agent", "auth.json"),
		JSON.stringify({ "opencode-go": credential }),
		{ mode: 0o600 },
	);
	fs.writeFileSync(
		join(root, "agent", "settings.json"),
		JSON.stringify({
			quietStartup: true,
			retry: { enabled: false },
			compaction: { enabled: false },
		}),
		{ mode: 0o600 },
	);
	container.start();
	container.exec("mkdir /workspace/ask");
	fs.mkdirSync(join(root, "home", ".ssh"), { mode: 0o700 });
	fs.copyFileSync(container.config, join(root, "home", ".ssh", "config"));
	fs.writeFileSync(
		join(root, "observer.ts"),
		`
import {appendFileSync} from 'node:fs';
export default function(pi){
 const record=(event,data={})=>appendFileSync(process.env.ASK_AUDIT,JSON.stringify({event,...data})+'\\n',{mode:0o600});
 pi.on('session_start',(_e,ctx)=>{if(!ctx.privacy.clientZdr)throw Error('client ZDR required');record('ready',{pid:process.pid,tools:pi.getActiveTools()});});
 pi.on('before_agent_start',(_e,ctx)=>{if(ctx.model?.provider!=='opencode-go'||ctx.model?.id!=='deepseek-v4.1-flash')throw Error('Unexpected live model');});
 pi.on('tool_execution_start',e=>record('tool',{name:e.toolName,count:e.toolName==='ask_user'?e.args.questions.length:undefined}));
 pi.on('tool_execution_end',e=>record('result',{name:e.toolName,error:e.isError,status:e.result.details?.status,answers:e.toolName==='ask_user'?e.result.details?.answers:undefined}));
 pi.on('agent_settled',e=>record('settled',{aborted:e.aborted}));
}
`,
		{ mode: 0o600 },
	);
	const args = process.env.PI_ASK_CLI
		? [process.env.PI_ASK_CLI]
		: [
				process.execPath,
				"--import",
				pathToFileURL(
					join(
						checkout,
						"packages/coding-agent/src/experimental/source-resolver.ts",
					),
				).href,
				join(checkout, "packages/coding-agent/src/cli.ts"),
			];
	args.push(
		"--zdr-client",
		"--no-extensions",
		"--no-skills",
		"--no-context-files",
		"--no-prompt-templates",
		"--no-mcp",
		"--no-themes",
	);
	for (const name of [
		"execution-guard",
		"teleport",
		"safety",
		"background-work",
		"goal",
		"subagents",
		"you-should-know",
		"ask-user",
	])
		args.push("--extension", join(agent, "extensions", name, "index.ts"));
	args.push(
		"--teleport",
		"background-fixture:/workspace/ask",
		"--safety",
		"--safety-profile",
		"monitor",
		"--extension",
		join(root, "observer.ts"),
		"--model",
		"opencode-go/deepseek-v4.1-flash",
		"--thinking",
		"low",
		"--tools",
		"read,bash,write,edit,ask_user,read_output,background_status,background_wait,background_stop",
	);
	fs.writeFileSync(
		join(root, "launch.sh"),
		`exec ${args.map(quote).join(" ")}\n`,
		{ mode: 0o600 },
	);
	tmux(
		"-f",
		"/dev/null",
		"new-session",
		"-d",
		"-s",
		"ask",
		"-x",
		"100",
		"-y",
		"35",
		"zsh",
		"-f",
		join(root, "launch.sh"),
	);
	console.log(JSON.stringify({ event: "fixture", root, socket }));
	await until(() => records().some((r) => r.event === "ready"), 30000);
	if (
		!records()
			.find((r) => r.event === "ready")
			.tools.includes("ask_user")
	)
		throw Error("Question tool unavailable in Teleport");
	type(
		"We are designing a fictional preference setting. Before writing preferences.md, ask me two questions together in a form: where the setting should apply, and how to roll it out. Offer choices for each. Then write my two answers verbatim to preferences.md and briefly acknowledge them.",
	);
	await send("Enter");
	await until(() => capture().includes("Chat about this"));
	console.log("Live form:\n" + capture());
	const answers = [
		"Project-local, with an inherited global default",
		"A two-week opt-in pilot",
	];
	for (const [i, answer] of answers.entries()) {
		await send("C-e", "C-a", "C-k");
		type(answer);
		await send("Enter");
		await until(
			() =>
				capture().includes(i === 0 ? "Chat about this" : "Review your answers"),
			5000,
		);
	}
	tmux("resize-window", "-t", "ask", "-x", "48", "-y", "28");
	await delay(200);
	console.log("Live review at 48 columns:\n" + capture());
	await send("Enter");
	await until(() => records().some((r) => r.event === "settled"));
	const receipt = records().find(
		(r) => r.event === "result" && r.name === "ask_user",
	);
	if (
		JSON.stringify(receipt?.answers?.map((a) => a.answer)) !==
		JSON.stringify(answers)
	)
		throw Error("Answers changed during submission");
	const written = container.exec("cat /workspace/ask/preferences.md");
	if (!answers.every((answer) => written.includes(answer)))
		throw Error("Model did not preserve answers in the container file");
	const settled = records().filter((r) => r.event === "settled").length;
	type(
		"Now ask me one free-text question for a display name before creating name.txt. If I cancel, leave that file absent and acknowledge the cancellation.",
	);
	await send("Enter");
	await until(
		() =>
			capture().includes("Your answer") ||
			capture().includes("Chat about this"),
	);
	await send("Escape");
	if (capture().includes("Chat about this")) await send("Escape");
	await until(
		() => records().filter((r) => r.event === "settled").length > settled,
	);
	const cancelled = records()
		.filter((r) => r.event === "result" && r.name === "ask_user")
		.at(-1);
	if (cancelled?.status !== "cancelled")
		throw Error("Cancellation did not reach the model");
	container.exec("test ! -e /workspace/ask/name.txt");
	const beforeDiscussion = records().filter(
		(r) => r.event === "settled",
	).length;
	type(
		"Ask whether the fictional setting should be project-local or global before writing scope.txt. If I choose to chat about it, explain the tradeoff without writing the file or opening another form yet.",
	);
	await send("Enter");
	await until(() => capture().includes("Chat about this"));
	await send(...Array(10).fill("Down"), "Enter");
	await until(
		() =>
			records().filter((r) => r.event === "settled").length > beforeDiscussion,
	);
	const discussion = records()
		.filter((r) => r.event === "result" && r.name === "ask_user")
		.at(-1);
	if (discussion?.status !== "discuss")
		throw Error("Discussion intent did not reach the model");
	container.exec("test ! -e /workspace/ask/scope.txt");
	console.log("Live discussion:\n" + capture());
	if (records().some((r) => r.event === "result" && r.error))
		throw Error("A tool failed in live composition");
	if (fs.existsSync(join(root, "agent", "sessions")))
		throw Error("Session persistence detected");
	console.log(
		JSON.stringify({
			event: "passed",
			exactAnswers: true,
			containerFile: true,
			cancelledWithoutWrite: true,
			discussedWithoutWrite: true,
			toolCalls: records()
				.filter((r) => r.event === "tool")
				.map((r) => r.name),
		}),
	);
} catch (error) {
	try {
		console.error("Synthetic live fixture:\n" + capture());
	} catch {}
	throw error;
} finally {
	const pid = records().find((r) => r.event === "ready")?.pid;
	if (pid) {
		try {
			process.kill(pid, "SIGTERM");
		} catch {}
		await delay(500);
	}
	spawnSync("tmux", ["-S", socket, "kill-server"], {
		env,
		stdio: "ignore",
		timeout: 5000,
	});
	try {
		container.close();
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
	console.log(JSON.stringify({ event: "cleaned", root }));
}
