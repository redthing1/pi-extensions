import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { expect, test } from "vitest";

const checkout = process.env.PI_ASK_CHECKOUT!;
const root = fileURLToPath(new URL("..", import.meta.url));
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

test("real TUI: batch review, custom answers, resize, cancellation, and return to the composer", async () => {
	const fixture = mkdtempSync(join(tmpdir(), "ask-tui-"));
	const socket = join(fixture, "t.sock");
	const audit = join(fixture, "audit.jsonl");
	for (const name of ["home", "agent", "workspace", "tmp"])
		mkdirSync(join(fixture, name), { mode: 0o700 });
	const env = {
		PATH: process.env.PATH,
		HOME: join(fixture, "home"),
		TMPDIR: join(fixture, "tmp"),
		XDG_CONFIG_HOME: join(fixture, "home", ".config"),
		PI_CODING_AGENT_DIR: join(fixture, "agent"),
		HISTFILE: "/dev/null",
		PI_OFFLINE: "1",
		TERM: "xterm-256color",
		LANG: "en_US.UTF-8",
		ASK_AUDIT: audit,
	};
	writeFileSync(
		join(fixture, "agent", "settings.json"),
		JSON.stringify({
			quietStartup: true,
			retry: { enabled: false },
			compaction: { enabled: false },
		}),
	);
	writeFileSync(
		join(fixture, "provider.ts"),
		`
import {appendFileSync} from 'node:fs';
import {fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai';
export default function(pi){
 const record = value => appendFileSync(process.env.ASK_AUDIT,JSON.stringify(value)+'\\n',{mode:0o600});
 const faux = fauxProvider({provider:'ask-fixture',models:[{id:'test',contextWindow:65536,maxTokens:8192}]});
 const questions = [
  {label:'Scope',question:'Where should this setting apply?',options:[{label:'Per project',description:'Each project chooses independently.'},{label:'Globally',description:'One default across projects.'}]},
  {label:'Rollout',question:'How should we roll it out?',options:[{label:'Gradually',description:'Start with a small group before wider availability.'},{label:'Immediately',description:'Enable it for everyone at once.'}]}
 ];
 faux.setResponses(Array.from({length:8},(_,i)=>fauxAssistantMessage(i%2===0?fauxToolCall('ask_user',{questions}):'SYNTHETIC_FINISHED',{stopReason:i%2===0?'toolUse':'stop'})));
 pi.registerProvider(faux.provider);
 pi.on('session_start',(_e,ctx)=>{if(!ctx.privacy.clientZdr)throw Error('ZDR required');record({event:'ready',pid:process.pid});});
 pi.on('tool_execution_end',e=>{if(e.toolName==='ask_user')record({event:'answer',details:e.result.details,error:e.isError});});
}
`,
		{ mode: 0o600 },
	);
	const tmux = (...args: string[]) => {
		const r = spawnSync("tmux", ["-S", socket, ...args], {
			cwd: join(fixture, "workspace"),
			env,
			encoding: "utf8",
			timeout: 5000,
		});
		if (r.status !== 0)
			throw Error(r.stderr || r.error?.message || "tmux failed");
		return r.stdout;
	};
	const capture = () => tmux("capture-pane", "-p", "-t", "ask");
	const records = () =>
		existsSync(audit)
			? readFileSync(audit, "utf8")
					.trim()
					.split("\n")
					.filter(Boolean)
					.map((s) => JSON.parse(s))
			: [];
	const until = async (predicate: () => boolean, ms = 15000) => {
		const end = Date.now() + ms;
		while (!predicate()) {
			if (Date.now() > end)
				throw Error(`Synthetic TUI deadline:\n${capture()}`);
			await delay(80);
		}
	};
	const send = async (...keys: string[]) => {
		tmux("send-keys", "-t", "ask", ...keys);
		await delay(120);
	};
	const type = (text: string) => tmux("send-keys", "-t", "ask", "-l", text);
	try {
		const args = [
			process.execPath,
			"--import",
			pathToFileURL(
				join(
					checkout,
					"packages/coding-agent/src/experimental/source-resolver.ts",
				),
			).href,
			join(checkout, "packages/coding-agent/src/cli.ts"),
			"--zdr-client",
			"--no-extensions",
			"--no-skills",
			"--no-context-files",
			"--no-prompt-templates",
			"--no-mcp",
			"--no-themes",
			"--extension",
			join(root, "index.ts"),
			"--extension",
			join(fixture, "provider.ts"),
			"--model",
			"ask-fixture/test",
			"--thinking",
			"off",
			"--tools",
			"ask_user",
		];
		writeFileSync(
			join(fixture, "launch.sh"),
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
			join(fixture, "launch.sh"),
		);
		await until(() => records().some((r) => r.event === "ready"));
		type("Help choose the scope and rollout.");
		await send("Enter");
		await until(() => capture().includes("Chat about this"));
		expect(capture()).toContain("Each project chooses independently.");
		tmux("resize-window", "-t", "ask", "-x", "48", "-y", "28");
		await delay(200);
		expect(capture()).toContain("Where should this setting apply?");
		await send("C-e");
		type(", with a shared default");
		await send("Tab", "BTab");
		expect(capture()).toContain("Draft: Per project, with a shared");
		await send("Enter");
		await send("Enter");
		await until(() => capture().includes("How should we roll it out?"));
		await send("Down", "Down", "Enter");
		type("After a two-week pilot");
		await send("Enter");
		await until(() => capture().includes("Review your answers"));
		expect(records().filter((r) => r.event === "answer")).toHaveLength(0);
		expect(capture()).toContain("After a two-week pilot");
		await send("Left", "Left");
		expect(capture()).toContain("with a shared");
		await send("Right", "Right", "Enter");
		await until(() => records().some((r) => r.event === "answer"));
		const answer = records().find((r) => r.event === "answer");
		expect(answer.error).toBe(false);
		expect(
			answer.details.answers.map((a: { answer: string }) => a.answer),
		).toEqual(["Per project, with a shared default", "After a two-week pilot"]);
		await until(() => capture().includes("SYNTHETIC_FINISHED"));
		type("Ask again.");
		await send("Enter");
		await until(() => capture().includes("Where should this setting apply?"));
		await send("Enter", "Escape");
		await until(
			() => records().filter((r) => r.event === "answer").length === 2,
		);
		expect(records().filter((r) => r.event === "answer")[1].details).toEqual({
			status: "cancelled",
		});
		expect(existsSync(join(fixture, "agent", "sessions"))).toBe(false);
	} finally {
		const pid = records().find((r) => r.event === "ready")?.pid;
		if (pid) {
			try {
				process.kill(pid, "SIGTERM");
			} catch {}
			await delay(250);
		}
		spawnSync("tmux", ["-S", socket, "kill-server"], { env, stdio: "ignore" });
		rmSync(fixture, { recursive: true, force: true });
	}
}, 45000);
