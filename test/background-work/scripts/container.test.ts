import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { initTheme } from "@earendil-works/pi-coding-agent";
import fixture from "./teleport-fixture.ts";
import { TeleportConnection } from "../../../extensions/teleport/transport/connection.ts";

const checkout = process.env.PI_BACKGROUND_CHECKOUT!;
const { createHarness, createTestUiContext, getMessageText, getToolResult } =
	await import(
		pathToFileURL(join(checkout, "packages/coding-agent/test/suite/harness.ts"))
			.href
	);
const harnesses: Awaited<ReturnType<typeof createHarness>>[] = [];
const containerTest = process.env.PI_BACKGROUND_SSH_CONFIG ? test : test.skip;
const call = (name: string, args: Record<string, unknown>) =>
	fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
const answer = (text: string) => fauxAssistantMessage(text);
async function setup(shell?: { timeoutSeconds: number; maxTimeoutSeconds: number }) {
	initTheme("dark", false);
	const h = await createHarness({
		extensionFactories: [fixture],
		settings: { compaction: { enabled: false }, retry: { enabled: false }, ...(shell ? { shell } : {}) },
	});
	harnesses.push(h);
	await h.session.bindExtensions({
		mode: "tui",
		uiContext: createTestUiContext(),
	});
	return h;
}
afterEach(async () => {
	for (const h of harnesses.splice(0)) {
		await h.session.extensionRunner.emit({
			type: "session_shutdown",
			reason: "exit",
		});
		h.cleanup();
	}
});

containerTest(
	"a foreground remote command yields automatically and stops at its original default deadline",
	async () => {
		const h = await setup({ timeoutSeconds: 40, maxTimeoutSeconds: 60 });
		h.setResponses([
			call("bash", { command: "printf '%s' \"$$\" > deadline.pid; printf partial-output; sleep 100" }),
			answer("Continued."),
		]);
		await h.session.prompt("Run the synthetic foreground command.");
		const receipt = h.eventsOfType("tool_execution_end").find((event) => event.toolName === "bash")!.result;
		expect(receipt.structuredContent).toEqual({ status: "running", jobId: "1" });
		expect(getMessageText(receipt)).toContain("is running in the background");
		h.setResponses([
			call("background_wait", { id: "1" }),
			call("bash", { command: 'if kill -0 "$(cat deadline.pid)" 2>/dev/null; then exit 1; else printf stopped; fi' }),
			answer("Inspected."),
		]);
		await h.session.prompt("Collect the result and confirm the process exited.");
		const result = getMessageText(getToolResult(h, "background_wait"));
		expect(result).toContain("Command timed out after 40 seconds");
		expect(result).toContain("partial-output");
		expect(getMessageText(getToolResult(h, "bash"))).toBe("stopped");
	},
	60_000,
);

containerTest("the remote worker enforces its own deadline and retains truncated output", async () => {
	const connection = new TeleportConnection({
		destination: "background-fixture",
		sshConfigPath: process.env.PI_BACKGROUND_SSH_CONFIG!,
		onFailure(error) {
			throw error;
		},
	});
	try {
		await connection.start(process.env.PI_BACKGROUND_REMOTE_CWD!);
		const result = await connection.workspace.exec(
			"trap '' TERM; head -c 60000 /dev/zero | tr '\\0' x; sleep 30",
			undefined,
			{ timeout: 0.2 },
		).promise;
		expect(result.timedOut).toBe(true);
		expect(result.fullOutputPath).toBeDefined();
		expect((await connection.workspace.read(result.fullOutputPath!)).length).toBe(60_000);
	} finally {
		await connection.close();
	}
});

containerTest(
	"Pi file tools and shell cannot access the synthetic host file or Docker socket",
	async () => {
		const h = await setup();
		const canary = join(h.tempDir, "host-canary");
		writeFileSync(canary, "synthetic-host-only", { mode: 0o600 });
		h.setResponses([
			call("read", { path: canary }),
			call("write", { path: canary, content: "must-stay-in-container" }),
			call("bash", {
				command:
					"set -e; id -u; test ! -S /var/run/docker.sock; test ! -e /Users; awk '/CapEff/ {print $2}' /proc/self/status; test -z \"$OPENAI_API_KEY$ANTHROPIC_API_KEY$OPENCODE_API_KEY\"; printf '\\nconfined\\n'",
			}),
			answer("Checked confinement."),
		]);
		await h.session.prompt("Probe only synthetic fixture paths.");
		expect(getToolResult(h, "read").isError).toBe(true);
		// A matching path may be created inside the container's private /tmp, never on the host.
		expect(readFileSync(canary, "utf8")).toBe("synthetic-host-only");
		const shell = getToolResult(h, "bash");
		expect(shell.isError).toBeFalsy();
		expect(getMessageText(shell)).toContain("10001");
		expect(getMessageText(shell)).toContain("0000000000000000");
		expect(getMessageText(shell)).toContain("confined");
	},
);

containerTest(
	"background work uses the container and wakes the idle parent",
	async () => {
		const h = await setup();
		h.setResponses([
			call("bash", {
				background: true,
				command: "sleep 0.3; id -u; printf container-result",
			}),
			answer("Started."),
			(context) => {
				expect(getMessageText(context.messages.at(-1))).toContain("10001");
				expect(getMessageText(context.messages.at(-1))).toContain(
					"container-result",
				);
				return answer("Consumed container completion.");
			},
		]);
		await h.session.prompt("Run synthetic work.");
		await vi.waitFor(() =>
			expect(
				h.session.messages.some(
					(m) => getMessageText(m) === "Consumed container completion.",
				),
			).toBe(true),
		);
		expect(h.session.messages.filter((m) => m.role === "custom")).toHaveLength(
			1,
		);
	},
);

containerTest("interrupting a Teleport command preserves partial output and the user interruption cause", async () => {
	const h = await setup();
	h.setResponses([call("bash", { command: "printf 'ready\\n'; sleep 30", timeout: 40 })]);
	const running = h.session.prompt("Run a foreground command.");
	await vi.waitFor(() => expect(
		h.eventsOfType("tool_execution_update").some((event) => getMessageText(event.partialResult).includes("ready")),
	).toBe(true), { timeout: 5000 });
	await h.session.abort("Interrupted by the user.");
	await running;
	const result = getToolResult(h, "bash");
	expect(result.isError).toBe(true);
	expect(getMessageText(result)).toContain("ready");
	expect(getMessageText(result)).toContain("Interrupted by the user.");
	expect(getMessageText(result)).not.toContain("Command aborted");
});

containerTest("monitor events arrive from Teleport before process completion and stop uses the same owner", async () => {
	const h = await setup();
	h.setResponses([
		call("monitor", { command: "sleep 0.2; id -u; sleep 30", timeout: 40 }),
		answer("Watching."),
		(context) => {
			expect(getMessageText(context.messages.at(-1))).toContain("10001");
			expect(getMessageText(context.messages.at(-1))).toContain("running");
			return call("background_stop", { id: "1" });
		},
		answer("Stopped the monitor."),
	]);
	await h.session.prompt("Monitor the synthetic container command.");
	await vi.waitFor(() => expect(h.getPendingResponseCount()).toBe(0), { timeout: 5000 });
	expect(getToolResult(h, "monitor").isError).toBeFalsy();
	expect(getMessageText(getToolResult(h, "background_stop"))).toContain("stopped");
	expect(h.session.messages.filter((m) => m.role === "custom")).toHaveLength(1);
});

containerTest("failed Teleport monitor delivers its final event without replaying earlier output", async () => {
	const h = await setup();
	h.setResponses([
		call("monitor", { command: "printf 'first-event\\n'; sleep 1; printf 'last-event\\n'; exit 7" }),
		answer("Watching."), answer("First event received."), answer("Failure received."),
	]);
	await h.session.prompt("Watch the synthetic failure.");
	await vi.waitFor(() => expect(h.getPendingResponseCount()).toBe(0), { timeout: 5000 });
	const notices = h.session.messages.filter((message) => message.role === "custom" && message.customType === "background-result");
	expect(notices).toHaveLength(2);
	expect(getMessageText(notices[0])).toContain("first-event");
	const final = getMessageText(notices[1]);
	expect(final.split("\n").slice(1)).toEqual(["last-event"]);
	expect(final).toContain("exit 7");
	expect(notices[1].details.backgroundWork.jobs[0].preview).toBe("last-event");
});

containerTest("monitor timeout settles a quiet Teleport process", async () => {
	const h = await setup();
	h.setResponses([
		call("monitor", { command: "sleep 30", timeout: 0.2 }), answer("Watching."),
		answer("Deadline reached."),
	]);
	await h.session.prompt("Test a quiet watcher deadline.");
	await vi.waitFor(() => expect(h.getPendingResponseCount()).toBe(0), { timeout: 5000 });
	const notice = h.session.messages.find((m) => m.role === "custom");
	expect(getMessageText(notice)).toMatch(/timed out|timeout/i);
});

containerTest.each([1500, 6000, 100000])(
	"background output of %i bytes has one usable opaque reference",
	async (bytes) => {
		const h = await setup();
		h.setResponses([
			call("bash", {
				background: true,
				command: `node -e 'process.stdout.write("BEGIN"+"x".repeat(${bytes})+"END")'`,
			}),
			answer("Started."),
			answer("Received output."),
		]);
		await h.session.prompt("Run output fixture.");
		await vi.waitFor(() =>
			expect(h.session.messages.some((m) => m.role === "custom")).toBe(true),
		);
		const notice = getMessageText(
			h.session.messages.find((m) => m.role === "custom"),
		);
		expect(notice.length).toBeLessThan(1400);
		const reference = notice.match(/pi-output:[a-f0-9]{32}/)?.[0];
		expect(reference).toBeTruthy();
		h.setResponses([
			call("read_output", { reference, encoding: "base64", limit: 16 }),
			answer("Read saved output."),
		]);
		await h.session.prompt("Retrieve the beginning.");
		expect(getToolResult(h, "read_output").isError).toBeFalsy();
		expect(getMessageText(getToolResult(h, "read_output"))).toContain(
			Buffer.from("BEGINxxxxxxxxxxx").toString("base64"),
		);
	},
);

containerTest(
	"background stop settles the container process and does not duplicate the result",
	async () => {
		const h = await setup();
		const pidFile = `stop-${Date.now()}.pid`;
		h.setResponses([
			call("bash", {
				background: true,
				command: `exec node -e 'require("fs").writeFileSync("${pidFile}",String(process.pid));console.log("partial");setInterval(()=>{},1000)'`,
			}),
			call("bash", {
				command: `while [ ! -f ${pidFile} ]; do sleep 0.01; done`,
			}),
			call("background_stop", { id: "1" }),
			call("bash", { command: `! kill -0 $(cat ${pidFile}) 2>/dev/null` }),
			answer("Stopped."),
		]);
		await h.session.prompt("Start and stop the fixture.");
		expect(getMessageText(getToolResult(h, "background_stop"))).toContain(
			"stopped",
		);
		expect(getMessageText(getToolResult(h, "background_stop"))).toContain(
			"partial",
		);
		expect(getToolResult(h, "bash").isError).toBeFalsy();
		expect(h.session.messages.filter((m) => m.role === "custom")).toHaveLength(
			0,
		);
	},
);

containerTest.each([false, true])(
	"worker loss settles work and disables host fallback (waiting=%s)",
	async (waiting) => {
		const h = await setup();
		const canary = join(h.tempDir, "host-canary");
		writeFileSync(canary, "synthetic-host-only", { mode: 0o600 });
		h.setResponses([
			call("bash", { command: "sleep 0.3; kill -KILL $PPID", background: waiting }),
			...(waiting ? [call("background_wait", { id: "1" })] : []),
			call("read", { path: canary }),
			answer("The remote workspace is unavailable."),
		]);
		await h.session.prompt(
			"Exercise worker loss inside the disposable container.",
		);
		if (waiting) {
			expect(getMessageText(getToolResult(h, "background_wait"))).toContain(": failed");
		} else {
			expect(getToolResult(h, "bash").isError).toBe(true);
		}
		expect(getToolResult(h, "read").isError).toBe(true);
		expect(
			h.session.messages.some((m) =>
				getMessageText(m).includes("synthetic-host-only"),
			),
		).toBe(false);
		expect(readFileSync(canary, "utf8")).toBe("synthetic-host-only");
	},
);

containerTest("wait collects remote completion and pages omitted lines through read_output", async () => {
	const h = await setup();
	h.setResponses([
		call("bash", { background: true, command: "sleep 0.3; seq 1 20; exit 7" }),
		call("background_wait", { id: "1" }),
		(context) => {
			const receipt = getMessageText(context.messages.at(-1));
			expect(receipt).toContain("exit 7");
			expect(receipt).toContain("[Earlier output omitted]");
			const reference = receipt.match(/pi-output:[a-f0-9]{32}/)?.[0];
			expect(reference).toBeTruthy();
			return call("read_output", { reference, offset: 2, limit: 3 });
		},
		answer("Collected and inspected."),
	]);
	await h.session.prompt("Run the prerequisite and inspect omitted lines.");
	expect(getToolResult(h, "background_wait").isError).toBeFalsy();
	expect(getToolResult(h, "read_output").isError).toBeFalsy();
	expect(getMessageText(getToolResult(h, "read_output"))).toContain("2\n3\n4");
	expect(h.session.messages.filter((m) => m.role === "custom")).toHaveLength(0);
});
