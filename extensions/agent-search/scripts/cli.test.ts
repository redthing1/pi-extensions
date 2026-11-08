import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test, vi } from "vitest";
import { ContainerFixture } from "../../../test/background-work/scripts/container.mjs";

const checkout = process.env.PI_SEARCH_CHECKOUT!;
const root = fileURLToPath(new URL("..", import.meta.url));
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const containerTest = process.env.PI_SEARCH_DOCKER_IMAGE ? test : test.skip;

async function assertExited(pid: number): Promise<void> {
	const alive = () => {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	};
	try {
		await vi.waitFor(() => expect(alive()).toBe(false), { timeout: 3000 });
	} catch {
		if (alive()) process.kill(pid, "SIGKILL");
		throw new Error("Fixture CLI outlived its tmux session");
	}
}

containerTest.each(["node", "bun"])(
	"%s TUI toggles search in a real Teleport session with Docker confinement",
	async (runtime) => {
		// A short owned base keeps SSH and tmux Unix sockets below the platform limit.
		const fixture = mkdtempSync("/tmp/pi-ws-");
		chmodSync(fixture, 0o700);
		for (const name of ["home", "agent", "workspace", "tmp"]) mkdirSync(join(fixture, name), { mode: 0o700 });
		mkdirSync(join(fixture, "home/.ssh"), { mode: 0o700 });
		vi.stubEnv("PI_BACKGROUND_DOCKER_IMAGE", process.env.PI_SEARCH_DOCKER_IMAGE!);
		const container = new ContainerFixture(fixture);
		const socket = join(fixture, "tmux.sock");
		const audit = join(fixture, "audit.jsonl");
		const canary = join(fixture, "host-canary");
		writeFileSync(canary, "synthetic-host-only", { mode: 0o600 });
		const requests: { path: string; body: unknown }[] = [];
		const server = createServer(async (req, res) => {
			let raw = "";
			for await (const chunk of req) raw += chunk;
			const body = JSON.parse(raw);
			requests.push({ path: req.url!, body });
			res.setHeader("Content-Type", "application/json");
			res.end(
				JSON.stringify(
					req.url === "/v1/search"
						? {
								requestId: "fixture",
								source: "web",
								query: body.query,
								searchedAt: "2026-10-27T00:00:00Z",
								requestedMaxResults: 8,
								resultCount: 1,
								results: [
									{
										rank: 1,
										title: "Synthetic source",
										url: "https://example.invalid/synthetic",
										snippet: "Synthetic result",
									},
								],
							}
						: {
								requestId: "fixture",
								requestedUrl: body.url,
								finalUrl: body.url,
								title: "Synthetic page",
								fetchedAt: "2026-10-27T00:00:00Z",
								contentType: "text/html",
								text: "Synthetic content",
								offset: 0,
								returnedChars: 17,
								totalChars: 17,
								truncated: false,
							},
				),
			);
		});
		const env = {
			PATH: process.env.PATH,
			HOME: join(fixture, "home"),
			TMPDIR: join(fixture, "tmp"),
			XDG_CONFIG_HOME: join(fixture, "home/.config"),
			PI_CODING_AGENT_DIR: join(fixture, "agent"),
			PI_OFFLINE: "1",
			TERM: "xterm-256color",
			LANG: "en_US.UTF-8",
			SEARCH_AUDIT: audit,
			SEARCH_CANARY: canary,
		};
		function tmux(args: string[]) {
			const result = spawnSync("tmux", ["-S", socket, ...args], {
				cwd: join(fixture, "workspace"),
				env,
				encoding: "utf8",
				timeout: 5000,
			});
			if (result.status !== 0) throw new Error(result.stderr || result.error?.message || "tmux failed");
			return result.stdout;
		}
		function send(text: string) {
			tmux(["send-keys", "-t", "search", "-l", text]);
			tmux(["send-keys", "-t", "search", "Enter"]);
		}
		function records(): { kind: string; pid?: number; tools?: string[]; searchGuidance?: boolean }[] {
			return existsSync(audit)
				? readFileSync(audit, "utf8")
						.trim()
						.split("\n")
						.filter(Boolean)
						.map((line) => JSON.parse(line))
				: [];
		}
		async function waitFor(text: string) {
			let pane = "";
			await vi.waitFor(
				() => {
					pane = tmux(["capture-pane", "-p", "-t", "search"]);
					expect(pane).toContain(text);
				},
				{ timeout: 20000, interval: 100 },
			);
			return pane;
		}
		async function prompt(text: string, answer: string) {
			const settled = records().filter((row) => row.kind === "settled").length;
			send(text);
			await waitFor(answer);
			await vi.waitFor(() => expect(records().filter((row) => row.kind === "settled").length).toBe(settled + 1));
		}
		try {
			container.start();
			container.exec("mkdir /workspace/search");
			writeFileSync(join(fixture, "home/.ssh/config"), readFileSync(container.config), { mode: 0o600 });
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			const port = (server.address() as { port: number }).port;
			writeFileSync(
				join(fixture, "agent/tokens.json"),
				JSON.stringify({
					"agent-search": { token: "synthetic-token-000000000000000000", baseUrl: `http://127.0.0.1:${port}` },
				}),
				{ mode: 0o600 },
			);
			writeFileSync(
				join(fixture, "agent/settings.json"),
				JSON.stringify({ quietStartup: true, compaction: { enabled: false }, retry: { enabled: false } }),
				{ mode: 0o600 },
			);

			writeFileSync(join(fixture, "tmux.conf"), "set -g remain-on-exit on\n", { mode: 0o600 });
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
				join(root, "../teleport/index.ts"),
				"--extension",
				join(root, "index.ts"),
				"--extension",
				join(root, "scripts/faux-provider.ts"),
				"--teleport",
				"background-fixture:/workspace/search",
				"--model",
				"search-fixture/test",
				"--thinking",
				"off",
				...(runtime === "bun" ? ["--search"] : []),
			];
			writeFileSync(
				join(fixture, "launch.sh"),
				`exec ${[runtime === "node" ? process.execPath : "bun", ...args].map(quote).join(" ")}\n`,
				{ mode: 0o700 },
			);
			tmux([
				"-f",
				join(fixture, "tmux.conf"),
				"new-session",
				"-d",
				"-s",
				"search",
				"-x",
				"100",
				"-y",
				"32",
				`zsh -f ${quote(join(fixture, "launch.sh"))}`,
			]);
			await waitFor("test • zdr-c");
			if (runtime === "bun") {
				send("/websearch");
				expect(await waitFor("Search & fetch")).toMatch(/Search & fetch\s+On/);
				tmux(["send-keys", "-t", "search", "Escape"]);
				send("/websearch off");
				await waitFor("Web search is off for this session");
			}
			await prompt("PROBE", "CONFINEMENT_CONFIRMED");
			expect(readFileSync(canary, "utf8")).toBe("synthetic-host-only");
			await prompt("CHECK_OFF", "OFF_CONFIRMED");
			send("/websearch");
			expect(await waitFor("Search & fetch")).toMatch(/Search & fetch\s+Off/);
			expect(requests).toEqual([]);
			tmux(["resize-window", "-t", "search", "-x", "48", "-y", "24"]);
			await waitFor("Search & fetch");
			tmux(["send-keys", "-t", "search", "Enter"]);
			expect(await waitFor("Search & fetch")).toMatch(/Search & fetch\s+On/);
			expect(requests).toEqual([]);
			tmux(["send-keys", "-t", "search", "Escape"]);
			tmux(["resize-window", "-t", "search", "-x", "100", "-y", "32"]);
			await prompt("SEARCH", "SEARCH_COMPLETE");
			expect(requests).toEqual([
				{ path: "/v1/search", body: { query: "synthetic public topic" } },
				{ path: "/v1/fetch", body: { url: "https://example.invalid/synthetic" } },
			]);
			send("BUSY");
			await waitFor("BUSY");
			await new Promise((resolve) => setTimeout(resolve, 250));
			send("/websearch off");
			await waitFor("Wait for the current request");
			await waitFor("BUSY_COMPLETE");
			send("/websearch off");
			await waitFor("Web search is off for this session");
			await prompt("STALE", "STALE_BLOCKED");
			expect(requests).toHaveLength(2);
			const calls = records().filter((row) => row.kind === "request");
			expect(calls.some((row) => row.tools?.includes("web_search") && row.searchGuidance)).toBe(true);
			expect(calls.at(-1)?.tools).not.toContain("web_search");
			expect(calls.at(-1)?.searchGuidance).toBe(false);
			if (runtime === "node") {
				send("/websearch on");
				await waitFor("Web search is on for this session");
			}
			send("/reload");
			await waitFor("Reloaded");
			if (runtime === "bun") {
				send("/websearch");
				expect(await waitFor("Search & fetch")).toMatch(/Search & fetch\s+On/);
				tmux(["send-keys", "-t", "search", "Escape"]);
				send("/websearch off");
				await waitFor("Web search is off for this session");
			}
			await prompt("CHECK_OFF", "OFF_CONFIRMED");
			expect(
				records()
					.filter((row) => row.kind === "request")
					.at(-1)?.tools,
			).not.toContain("web_search");
			expect(existsSync(join(fixture, "agent/sessions"))).toBe(false);
			expect(existsSync(join(fixture, "agent/runs"))).toBe(false);
			// Shut down normally so Teleport can close its worker and SSH master.
			send("/quit");
			await vi.waitFor(() =>
				expect(tmux(["display-message", "-p", "-t", "search", "#{pane_dead}"]).trim()).toBe("1"),
			);
		} finally {
			spawnSync("tmux", ["-S", socket, "kill-server"], { env, encoding: "utf8" });
			try {
				for (const pid of new Set(records().flatMap((row) => (row.pid ? [row.pid] : [])))) {
					await assertExited(pid);
				}
			} finally {
				server.closeAllConnections();
				await new Promise<void>((resolve) => server.close(() => resolve()));
				try {
					container.close();
				} finally {
					vi.unstubAllEnvs();
					rmSync(fixture, { recursive: true, force: true });
				}
			}
		}
	},
	90000,
);
