import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, mkdtempSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test } from "vitest";

const checkout = process.env.PI_BTW_CHECKOUT!;
const extensionRoot = fileURLToPath(new URL("..", import.meta.url));
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

const providerSource = `
import {appendFileSync} from "node:fs";
import {fauxProvider, fauxAssistantMessage} from "@earendil-works/pi-ai";
export default function(pi) {
  const faux = fauxProvider({provider:"btw-fixture",models:[{id:"test",contextWindow:65536,maxTokens:8192}]});
  const actualNow = Date.now;
  let advance = 0;
  Date.now = () => actualNow() + advance;
  const text = (message) => typeof message?.content === "string" ? message.content : message?.content?.filter(p=>p.type==="text").map(p=>p.text).join("\\n") || "";
  const respond = async (context, options) => {
    const users = context.messages.filter(m=>m.role==="user").map(text);
    const observer = users.some(t=>t.includes("Take a fresh look"));
    const side = observer || users.some(t=>t.includes("This is a side question"));
    appendFileSync(process.env.BTW_AUDIT, JSON.stringify({pid:process.pid,home:process.env.HOME,agent:process.env.PI_CODING_AGENT_DIR,side,observer,transport:options?.transport,sessionId:options?.sessionId})+"\\n", {mode:0o600});
    if (users.at(-1)==="MAIN_WORK") await new Promise(r=>setTimeout(r,1500));
    const answer = observer ? "OBSERVATION_RESPONSE: this changes the comparison." : users.at(-1)?.includes("FOLLOWUP_QUESTION") ? "FOLLOWUP_RESPONSE" : side ? "SIDE_RESPONSE: the choices have different costs." : "MAIN_RESPONSE";
    return fauxAssistantMessage(answer);
  };
  faux.setResponses(Array.from({length:80},()=>respond));
  pi.registerProvider(faux.provider);
  pi.on("before_agent_start", () => { advance += 120001; });
  pi.on("session_start", (_event,ctx) => {
    if(!ctx.privacy.clientZdr) throw new Error("Fixture must be ephemeral");
  });
}
`;

test.each(["node", "bun"])(
	"%s source TUI supports BTW, follow-ups, forwarding, observer, and private teardown",
	async (runtime) => {
		const root = mkdtempSync(join(tmpdir(), "pi-btw-tui-"));
		chmodSync(root, 0o700);
		for (const dir of ["home", "agent", "workspace", "tmp", "extension"]) mkdirSync(join(root, dir), { mode: 0o700 });
		for (const name of ["index.ts", "panel.ts", "requests.ts", "package.json"])
			cpSync(join(extensionRoot, name), join(root, "extension", name));
		writeFileSync(join(root, "provider.ts"), providerSource, { mode: 0o600 });
		writeFileSync(
			join(root, "agent", "settings.json"),
			JSON.stringify({ quietStartup: true, retry: { enabled: false }, compaction: { enabled: false } }),
			{ mode: 0o600 },
		);
		const audit = join(root, "audit.jsonl");
		const env = {
			PATH: process.env.PATH,
			HOME: join(root, "home"),
			HISTFILE: "/dev/null",
			TMPDIR: join(root, "tmp"),
			XDG_CONFIG_HOME: join(root, "home", ".config"),
			PI_CODING_AGENT_DIR: join(root, "agent"),
			PI_OFFLINE: "1",
			BTW_AUDIT: audit,
			TERM: "xterm-256color",
			LANG: "en_US.UTF-8",
		};
		const socket = join(root, "tmux.sock");
		function tmux(args: string[]): string {
			const result = spawnSync("tmux", ["-S", socket, ...args], {
				cwd: join(root, "workspace"),
				env,
				encoding: "utf8",
			});
			if (result.status !== 0) throw new Error(result.stderr || result.error?.message || "tmux failed");
			return result.stdout;
		}
		function send(text: string) {
			tmux(["send-keys", "-t", "btw", "-l", text]);
			tmux(["send-keys", "-t", "btw", "Enter"]);
		}
		function capture() {
			return tmux(["capture-pane", "-p", "-t", "btw"]);
		}
		async function waitFor(text: string) {
			const deadline = performance.now() + 15000;
			let pane = "";
			while (performance.now() < deadline) {
				pane = capture();
				if (pane.includes(text)) return pane;
				await new Promise((resolve) => setTimeout(resolve, 80));
			}
			throw new Error(`Missing ${text} in synthetic fixture:\n${pane}`);
		}
		function records(): {
			pid: number;
			home: string;
			agent: string;
			side: boolean;
			observer: boolean;
			transport?: string;
			sessionId?: string;
		}[] {
			return existsSync(audit)
				? readFileSync(audit, "utf8")
						.trim()
						.split("\n")
						.filter(Boolean)
						.map((line) => JSON.parse(line))
				: [];
		}
		try {
			const args = [
				...(runtime === "node"
					? [
							"--import",
							pathToFileURL(join(checkout, "packages/coding-agent/src/experimental/source-resolver.ts")).href,
						]
					: []),
				join(checkout, "packages/coding-agent/src/cli.ts"),
				"--zdr-client",
				"--no-extensions",
				"--no-skills",
				"--no-context-files",
				"--no-prompt-templates",
				"--no-mcp",
				"--no-themes",
				"--extension",
				join(root, "provider.ts"),
				"--extension",
				join(root, "extension/index.ts"),
				"--model",
				"btw-fixture/test",
				"--thinking",
				"off",
				"--tools",
				"read",
			];
			const executable = runtime === "node" ? process.execPath : "bun";
			writeFileSync(join(root, "launch.sh"), `exec ${[executable, ...args].map(quote).join(" ")}\n`, {
				mode: 0o700,
			});
			tmux(["new-session", "-d", "-s", "btw", "-x", "100", "-y", "32", `zsh -f ${quote(join(root, "launch.sh"))}`]);
			await waitFor("test • zdr-c");
			send("MAIN_QUESTION");
			await waitFor("MAIN_RESPONSE");
			send("MAIN_WORK");
			await new Promise((resolve) => setTimeout(resolve, 150));
			send("/btw SIDE_QUESTION");
			await waitFor("SIDE_RESPONSE");
			await waitFor("enter reply");
			tmux(["send-keys", "-t", "btw", "Enter"]);
			await waitFor("enter send");
			send("FOLLOWUP_QUESTION");
			await waitFor("FOLLOWUP_RESPONSE");
			await waitFor("enter reply");
			tmux(["send-keys", "-t", "btw", "C-o"]);
			await waitFor("place in main composer");
			tmux(["send-keys", "-t", "btw", "Enter"]);
			await waitFor("You: FOLLOWUP_QUESTION");
			expect(capture()).not.toContain("enter reply");
			tmux(["send-keys", "-t", "btw", "C-c"]);
			send("/ysk");
			await waitFor("enabled for this session");
			for (let i = 0; i < 6; i++) {
				const before = records().filter((row) => !row.side).length;
				send(`OBSERVER_TASK_${i}`);
				const deadline = performance.now() + 5000;
				while (records().filter((row) => !row.side).length === before && performance.now() < deadline)
					await new Promise((resolve) => setTimeout(resolve, 50));
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			await waitFor("OBSERVATION_RESPONSE");
			const sideCount = records().filter((row) => row.side).length;
			send("/ysk");
			await waitFor("enter discuss");
			expect(records().filter((row) => row.side)).toHaveLength(sideCount);
			tmux(["resize-window", "-t", "btw", "-x", "48", "-y", "24"]);
			const narrow = await waitFor("enter discuss");
			tmux(["send-keys", "-t", "btw", "Escape"]);
			send("/ysk off");
			const rows = records();
			expect(rows.some((row) => row.observer)).toBe(true);
			for (const row of rows) {
				expect(row.home).toBe(env.HOME);
				expect(row.agent).toBe(env.PI_CODING_AGENT_DIR);
				if (row.side) expect(row.transport).toBe("sse");
			}
			expect(new Set(rows.map((row) => row.sessionId)).size).toBe(1);
			expect(existsSync(join(root, "agent", "sessions"))).toBe(false);
			expect(existsSync(join(root, "agent", "runs"))).toBe(false);
			// Preserve only a synthetic UI excerpt in successful test output for visual inspection.
			console.log(`${runtime} isolated 48-column panel:\n${narrow}`);
		} finally {
			spawnSync("tmux", ["-S", socket, "kill-server"], { env, encoding: "utf8" });
			for (const pid of new Set(records().map((row) => row.pid))) {
				const deadline = performance.now() + 3000;
				while (performance.now() < deadline) {
					try {
						process.kill(pid, 0);
					} catch {
						break;
					}
					await new Promise((resolve) => setTimeout(resolve, 50));
				}
				let alive = false;
				try {
					process.kill(pid, 0);
					alive = true;
				} catch {}
				if (alive) {
					process.kill(pid, "SIGKILL");
					throw new Error("Fixture CLI outlived its tmux session");
				}
			}
			rmSync(root, { recursive: true, force: true });
		}
	},
	60000,
);
