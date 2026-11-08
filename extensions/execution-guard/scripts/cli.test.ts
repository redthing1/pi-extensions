import { strict as assert } from "node:assert";
import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { RpcCommand, RpcResponse } from "@earendil-works/pi-coding-agent";
import { it } from "vitest";

const checkout = process.env.PI_GUARD_TEST_CHECKOUT;
if (!checkout) throw new Error("PI_GUARD_TEST_CHECKOUT must name the source checkout");
const extensions = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const node = execFileSync("/usr/bin/which", ["node"], { encoding: "utf8" }).trim();
const bun = execFileSync("/usr/bin/which", ["bun"], { encoding: "utf8" }).trim();
const sshConfig = process.env.PI_GUARD_TEST_SSH_CONFIG;
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

const providerSource = `
import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { publishChildProviderRuntime } from "./shared/child-runtime.ts";
export default function(pi) {
  appendFileSync(process.env.GUARD_FIXTURE_PIDS, JSON.stringify({pid:process.pid, home:homedir(), agent:process.env.PI_CODING_AGENT_DIR})+"\\n", {mode:0o600});
  const faux = fauxProvider({provider:"guard-fixture", models:[{id:"test", name:"Guard Fixture"}]});
  const respond = (context) => {
    const last = context.messages.at(-1);
    const text = typeof last.content === "string" ? last.content : last.content.filter(p=>p.type==="text").map(p=>p.text).join("\\n");
    if (last.role === "user") {
      const marker = "GUARD_CASE:";
      const index = text.indexOf(marker);
      if (index < 0) throw new Error("Expected a synthetic guard case");
      const spec = JSON.parse(text.slice(index+marker.length).split("\\n")[0]);
      return fauxAssistantMessage(fauxToolCall(spec.tool, spec.input), {stopReason:"toolUse"});
    }
    return fauxAssistantMessage("GUARD_DONE:" + (last.isError ? "error:" : "ok:") + text);
  };
  faux.setResponses(Array.from({length:100},()=>respond));
  pi.registerProvider(faux.provider);
  pi.on("session_start", (_event, ctx) => ctx.ui.setStatus("guard-fixture", "GUARD_FIXTURE_READY"));
  publishChildProviderRuntime(pi, {
    id:"guard-fixture", providers:["guard-fixture"],
    async prepare() { return {id:"guard-fixture", args:["--extension",fileURLToPath(import.meta.url)],metadata:{},dispose:async()=>{}}; }
  });
}
`;

class Fixture {
	readonly root = realpathSync(mkdtempSync("/tmp/pi-guard-cli-"));
	readonly env: NodeJS.ProcessEnv;
	readonly dispatch: string;
	readonly pids: string;
	constructor() {
		chmodSync(this.root, 0o700);
		for (const folder of ["home", "agent", "workspace", "tmp", "bin", "extensions"])
			mkdirSync(join(this.root, folder), { mode: 0o700 });
		for (const name of ["execution-guard", "safety", "shared", "subagents", "teleport"])
			cpSync(join(extensions, name), join(this.root, "extensions", name), { recursive: true });
		this.dispatch = join(this.root, "dispatch.txt");
		this.pids = join(this.root, "pids.jsonl");
		const shell = join(this.root, "bin", "guard-shell");
		writeFileSync(
			shell,
			`#!/bin/sh\nprintf '%s\\n' "$2" >> ${quote(this.dispatch)}\nprintf 'SAFE_FIXTURE_DISPATCH\\n'\n`,
			{ mode: 0o700 },
		);
		writeFileSync(
			join(this.root, "agent", "settings.json"),
			JSON.stringify({ shellPath: shell, quietStartup: true, retry: { enabled: false } }),
			{ mode: 0o600 },
		);
		writeFileSync(join(this.root, "extensions", "faux-fixture.ts"), providerSource, { mode: 0o600 });
		if (sshConfig) {
			mkdirSync(join(this.root, "home", ".ssh"), { mode: 0o700 });
			cpSync(sshConfig, join(this.root, "home", ".ssh", "config"));
		}

		this.env = {
			PATH: [join(this.root, "bin"), dirname(node), dirname(bun), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(
				":",
			),
			HOME: join(this.root, "home"),
			TMPDIR: join(this.root, "tmp"),
			XDG_CONFIG_HOME: join(this.root, "home", ".config"),
			PI_CODING_AGENT_DIR: join(this.root, "agent"),
			PI_OFFLINE: "1",
			TERM: "xterm-256color",
			LANG: "en_US.UTF-8",
			GUARD_FIXTURE_PIDS: this.pids,
		};
	}
	invocation(runtime: "node" | "bun", remote = false): { command: string; args: string[] } {
		const args = [
			join(checkout!, "packages/coding-agent/src/cli.ts"),
			"--zdr-client",
			"--no-extensions",
			"--no-skills",
			"--no-context-files",
			"--no-prompt-templates",
			"--no-mcp",
			"--no-themes",
			"--model",
			"guard-fixture/test",
			"--thinking",
			"off",
			"--tools",
			"bash,find,grep,subagent",
			"--extension",
			join(this.root, "extensions/execution-guard/index.ts"),
			"--extension",
			join(this.root, "extensions/faux-fixture.ts"),
			"--extension",
			join(this.root, "extensions/subagents/index.ts"),
		];
		if (remote)
			args.push(
				"--extension",
				join(this.root, "extensions/teleport/index.ts"),
				"--teleport",
				"guard-fixture:/workspace",
			);
		if (runtime === "node")
			args.unshift(
				"--import",
				pathToFileURL(join(checkout!, "packages/coding-agent/src/experimental/source-resolver.ts")).href,
			);
		return { command: runtime === "node" ? node : bun, args };
	}
	assertPrivate(): void {
		assert(!existsSync(join(this.root, "agent", "sessions")), "ephemeral source CLI must not create session files");
		assert(!existsSync(join(this.root, "agent", "subagents", "runs")), "ephemeral children must not persist runs");
		for (const line of readFileSync(this.pids, "utf8").trim().split("\n")) {
			const identity = JSON.parse(line);
			assert.equal(identity.home, this.env.HOME);
			assert.equal(identity.agent, this.env.PI_CODING_AGENT_DIR);
			let alive = false;
			try {
				process.kill(identity.pid, 0);
				alive = true;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
			}
			assert(!alive, `fixture process ${identity.pid} survived shutdown`);
		}
	}
	cleanup(): void {
		rmSync(this.root, { recursive: true, force: true });
	}
}

async function until<T>(read: () => T | undefined, description: string, timeout = 30_000): Promise<T> {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		const result = read();
		if (result !== undefined) return result;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error(`Timed out: ${description}`);
}

class Rpc {
	readonly child: ChildProcessWithoutNullStreams;
	readonly events: (AgentEvent | RpcResponse)[] = [];
	stderr = "";
	constructor(fixture: Fixture, runtime: "node" | "bun", remote = false) {
		const { command, args } = fixture.invocation(runtime, remote);
		this.child = spawn(command, [...args, "--mode", "rpc"], {
			cwd: join(fixture.root, "workspace"),
			env: fixture.env,
			stdio: "pipe",
		});
		let buffer = "";
		this.child.stdout.on("data", (chunk) => {
			buffer += chunk.toString();
			let newline: number;
			while ((newline = buffer.indexOf("\n")) !== -1) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				try {
					this.events.push(JSON.parse(line));
				} catch {
					this.stderr += line;
				}
			}
		});
		this.child.stderr.on("data", (chunk) => {
			this.stderr = (this.stderr + chunk.toString()).slice(-8192);
		});
	}
	async request(input: RpcCommand): Promise<RpcResponse> {
		const id = `request-${this.events.length}-${Math.random()}`;
		this.child.stdin.write(JSON.stringify({ ...input, id }) + "\n");
		return until(() => {
			if (this.child.exitCode !== null || this.child.signalCode !== null)
				throw new Error(`CLI exited: ${this.stderr}`);
			return this.events.find((event): event is RpcResponse => event.type === "response" && event.id === id);
		}, `RPC ${input.type}: ${this.stderr}`);
	}
	async tool(tool: string, input: unknown): Promise<Extract<AgentEvent, { type: "tool_execution_end" }>> {
		const start = this.events.length;
		const accepted = await this.request({ type: "prompt", message: `GUARD_CASE:${JSON.stringify({ tool, input })}` });
		assert(accepted.success, JSON.stringify(accepted));
		await until(
			() => this.events.slice(start).find((event) => event.type === "agent_end"),
			`model turn: ${this.stderr}`,
		);
		const completed = this.events
			.slice(start)
			.find(
				(event): event is Extract<AgentEvent, { type: "tool_execution_end" }> =>
					event.type === "tool_execution_end" && event.toolName === tool,
			);
		assert(completed, JSON.stringify(this.events.slice(start)));
		return completed;
	}
	async close(): Promise<void> {
		this.child.stdin.end();
		try {
			await until(
				() => (this.child.exitCode !== null || this.child.signalCode !== null ? true : undefined),
				"source CLI shutdown",
				10_000,
			);
		} catch {
			this.child.kill("SIGKILL");
			throw new Error(`CLI did not shut down: ${this.stderr}`);
		}
		assert.equal(this.child.exitCode, 0, this.stderr);
		assert(!/Failed to load extension|Error loading extension/u.test(this.stderr), this.stderr);
	}
}

it.each(["node", "bun"] as const)(
	"guards actual %s source CLI and managed children with isolated state",
	async (runtime) => {
		const fixture = new Fixture();
		const rpc = new Rpc(fixture, runtime);
		try {
			assert((await rpc.request({ type: "get_state" })).success);
			for (const excludeFromContext of [false, true]) {
				const result = await rpc.request({ type: "bash", command: "find / -name needle", excludeFromContext });
				assert(!result.success);
				assert.match(result.error, /reckless/u);
			}
			for (const [tool, input, category] of [
				["bash", { command: `rm -r ${fixture.env.HOME}` }, "catastrophic"],
				["bash", { command: "find / -name needle" }, "reckless"],
				["find", { path: "/", pattern: "needle" }, "reckless"],
				["grep", { path: "/", pattern: "needle" }, "reckless"],
			] as const) {
				const result = await rpc.tool(tool, input);
				assert(result.isError);
				assert.match(JSON.stringify(result.result), new RegExp(category));
			}
			assert(!existsSync(fixture.dispatch));
			const child = await rpc.tool("subagent", {
				tasks: [
					{ task: 'GUARD_CASE:{"tool":"bash","input":{"command":"find / -name child-needle"}}', tools: ["bash"] },
				],
				background: false,
			});
			assert(!child.isError, JSON.stringify(child));
			assert.match(JSON.stringify(child.result), /reckless/u);
			const identities = readFileSync(fixture.pids, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			assert(new Set(identities.map((entry) => entry.pid)).size >= 2, "must run a real child process");
			assert(!existsSync(fixture.dispatch), "blocked child must not spawn a shell");
			assert((await rpc.request({ type: "bash", command: "printf GUARD_ALLOWED" })).success);
			assert.equal(readFileSync(fixture.dispatch, "utf8").trim(), "printf GUARD_ALLOWED");
		} finally {
			try {
				await rpc.close();
				fixture.assertPrivate();
			} finally {
				fixture.cleanup();
			}
		}
	},
	90_000,
);

it.skipIf(!sshConfig)(
	"guards real Teleport SSH dispatch and inherited remote children from source",
	async () => {
		const fixture = new Fixture();
		let rpc: Rpc | undefined;
		try {
			const shim = '#!/bin/sh\nprintf "%s\\n" "$0 $*" >> /workspace/rejected-dispatch.log\nexit 98\n';
			assert.equal(
				execFileSync(
					"/usr/bin/ssh",
					[
						"-F",
						sshConfig!,
						"guard-fixture",
						'test "$(command -v find)" = /usr/local/bin/find && test "$(command -v rm)" = /usr/local/bin/rm && cat /usr/local/bin/find /usr/local/bin/rm',
					],
					{ encoding: "utf8", env: fixture.env },
				),
				shim.repeat(2),
				"SSH acceptance requires the disposable fixture's harmless find/rm shims",
			);
			rpc = new Rpc(fixture, "node", true);
			assert((await rpc.request({ type: "get_state" })).success);
			for (const command of ["rm -r /home/teleport", "find / -name needle"]) {
				const result = await rpc.request({ type: "bash", command });
				assert(!result.success);
				assert.match(result.error, /Execution guard/u);
				const model = await rpc.tool("bash", { command });
				assert(model.isError);
				assert.match(JSON.stringify(model.result), /Execution guard/u);
			}
			for (const tool of ["find", "grep"]) {
				const result = await rpc.tool(tool, { path: "/", pattern: "needle" });
				assert(result.isError);
				assert.match(JSON.stringify(result.result), /reckless/u);
			}
			const child = await rpc.tool("subagent", {
				tasks: [
					{
						task: 'GUARD_CASE:{"tool":"bash","input":{"command":"find / -name remote-child-needle"}}',
						tools: ["bash"],
					},
				],
				background: false,
			});
			assert(!child.isError, JSON.stringify(child));
			assert.match(JSON.stringify(child.result), /reckless/u);
			const allowed = await rpc.request({ type: "bash", command: "pwd; cat sentinel.txt" });
			assert(allowed.success && allowed.command === "bash", JSON.stringify(allowed));
			assert.match(allowed.data.output, /\/workspace[\s\S]*REMOTE_FIXTURE_OK/u);
			assert.equal(
				execFileSync(
					"/usr/bin/ssh",
					[
						"-F",
						sshConfig!,
						"guard-fixture",
						"test ! -e /workspace/rejected-dispatch.log && printf NO_REJECTED_DISPATCH",
					],
					{ encoding: "utf8", env: fixture.env },
				),
				"NO_REJECTED_DISPATCH",
			);
			assert(!existsSync(fixture.dispatch), "remote operations must never spawn the local shell");
		} finally {
			try {
				if (rpc) {
					await rpc.close();
					fixture.assertPrivate();
				}
			} finally {
				fixture.cleanup();
			}
		}
	},
	90_000,
);

it("guards actual TUI ! and !! commands without loading personal state", async () => {
	const fixture = new Fixture();
	const session = `pi-guard-tui-${process.pid}-${Date.now()}`;
	const invocation = fixture.invocation("node");
	const shell = [
		"exec",
		"/usr/bin/env",
		"-i",
		...Object.entries(fixture.env).map(([key, value]) => quote(`${key}=${value}`)),
		quote(invocation.command),
		...invocation.args.map(quote),
	].join(" ");
	execFileSync("tmux", [
		"new-session",
		"-d",
		"-s",
		session,
		"-c",
		join(fixture.root, "workspace"),
		"-x",
		"100",
		"-y",
		"35",
		"zsh -f",
	]);
	const pane = `=${session}:0.0`;
	execFileSync("tmux", ["set-option", "-w", "-t", `=${session}:0`, "remain-on-exit", "on"]);
	const capture = () => execFileSync("tmux", ["capture-pane", "-t", pane, "-p", "-S", "-300"], { encoding: "utf8" });
	const enter = (text: string) => {
		execFileSync("tmux", ["send-keys", "-t", pane, "-l", text]);
		execFileSync("tmux", ["send-keys", "-t", pane, "Enter"]);
	};
	try {
		enter(shell);
		await until(() => {
			const text = capture();
			if (
				execFileSync("tmux", ["display-message", "-p", "-t", pane, "#{pane_dead}"], { encoding: "utf8" }).trim() ===
				"1"
			)
				throw new Error(`Source TUI exited: ${text}`);
			return text.includes("GUARD_FIXTURE_READY") ? true : undefined;
		}, "TUI startup");
		enter("!find / -name needle");
		await until(() => (capture().includes("Execution guard blocked reckless") ? true : undefined), "TUI ! rejection");
		enter("!!find / -name needle");
		await until(
			() => ((capture().match(/Execution guard blocked reckless/gu)?.length ?? 0) >= 2 ? true : undefined),
			"TUI !! rejection",
		);
		assert(!existsSync(fixture.dispatch));
		enter('GUARD_CASE:{"tool":"bash","input":{"command":"find / -name needle"}}');
		await until(() => (capture().includes("GUARD_DONE:error:") ? true : undefined), "TUI model turn");
		enter("/quit");
		await until(
			() =>
				execFileSync("tmux", ["display-message", "-p", "-t", pane, "#{pane_dead}"], { encoding: "utf8" }).trim() ===
				"1"
					? true
					: undefined,
			"TUI shutdown",
		);
		assert.equal(
			execFileSync("tmux", ["display-message", "-p", "-t", pane, "#{pane_dead_status}"], {
				encoding: "utf8",
			}).trim(),
			"0",
		);
		fixture.assertPrivate();
	} catch (error) {
		throw new Error(`Source TUI acceptance failed:\n${capture()}`, { cause: error });
	} finally {
		try {
			execFileSync("tmux", ["kill-session", "-t", `=${session}`], { stdio: "ignore" });
		} catch {}
		fixture.cleanup();
	}
}, 90_000);
