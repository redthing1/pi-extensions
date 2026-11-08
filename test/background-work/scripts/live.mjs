// Explicitly invoked, synthetic CLI experiments. Never loads ambient Pi state.
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { ContainerFixture } from "./container.mjs";

const checkout = process.env.PI_BACKGROUND_CHECKOUT;
const authSource = process.env.PI_BACKGROUND_AUTH_SOURCE;
if (!checkout || !authSource)
	throw new Error("Explicit checkout and selected-provider auth source required");
const prototype = fileURLToPath(new URL("..", import.meta.url));
const agentSource = resolve(prototype, "../..");
// Explicit short fixture base avoids Unix socket path limits under nested TMPDIRs.
const root = fs.mkdtempSync(join(process.env.PI_BACKGROUND_FIXTURE_BASE || tmpdir(), "pi-bg-"));
const socket = join(root, "tmux.sock");
const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;
let activePid;
let container;
let interrupted = false;
process.on("SIGTERM", () => {
	interrupted = true;
});
process.on("SIGINT", () => {
	interrupted = true;
});
const reports = [];
const scenarios = process.env.PI_BACKGROUND_SCENARIOS?.split(",") || ["independent", "idle", "failure", "service"];
if (
	scenarios.some(
		(s) =>
			![
				"independent",
				"monitor",
				"monitor-interrupted",
				"monitor-idle-muted",
				"monitor-released",
				"waiting",
				"wait-interrupted",
				"wait-released",
				"wait-timeout",
				"idle",
				"failure",
				"service",
				"responsive",
				"panel",
				"promotion",
				"interrupted",
				"reload",
				"new",
				"shutdown",
			].includes(s),
	)
) {
	fs.rmSync(root, { recursive: true, force: true });
	throw new Error("Unknown synthetic scenario");
}
const observer = `
import {appendFileSync} from 'node:fs';
export default function(pi){
 const record=(event,extra={})=>appendFileSync(process.env.BACKGROUND_AUDIT,JSON.stringify({at:Date.now(),event,...extra})+'\\n',{mode:0o600});
 const seen=new Set();
 const completions=ctx=>{for(const entry of ctx.sessionManager.getEntries()){if(entry.type==='custom_message'&&entry.customType==='background-result'&&!seen.has(entry.id)){seen.add(entry.id);record('completion',{entryAt:Date.parse(entry.timestamp),expectedFailure:typeof entry.content==='string'&&/exit 7/.test(entry.content)&&/fictional batch has no schema version/.test(entry.content)});}}};
 pi.on('session_start',(_e,ctx)=>{if(!ctx.privacy.clientZdr)throw Error('client ZDR required');record('ready',{pid:process.pid,tools:pi.getActiveTools()});});
 pi.on('before_agent_start',(_e,ctx)=>{if(ctx.model?.provider!=='opencode-go'||ctx.model?.id!=='deepseek-v4.1-flash')throw Error('unexpected model');});
 pi.on('agent_start',()=>record('start'));
 pi.on('ui_prompt_start',()=>record('prompt_open'));
 pi.on('ui_prompt_end',()=>record('prompt_close'));
 pi.on('ui_interrupt',()=>record('interrupt'));
 pi.on('turn_start',(_e,ctx)=>completions(ctx));
 pi.on('agent_settled',(e,ctx)=>{completions(ctx);record('settled',{aborted:e.aborted});});
 pi.on('tool_execution_start',e=>record('tool',{id:e.toolCallId,name:e.toolName,polling:e.toolName==='bash'&&typeof e.args.command==='string'&&/^\\s*sleep\\b/.test(e.args.command),outline:e.toolName==='write'&&typeof e.args.path==='string'&&e.args.path.split('/').at(-1)==='outline.md'}));
 pi.on('tool_execution_end',e=>record('tool_end',{id:e.toolCallId,name:e.toolName,error:e.isError,durationMs:e.durationMs,waitOutcome:e.toolName==='background_wait'?e.result?.details?.backgroundWork?.receipt:undefined,receiptBytes:e.toolName==='background_wait'?Buffer.byteLength(e.result?.content?.filter(p=>p.type==='text').map(p=>p.text).join('\\n')||''):undefined,retained:e.toolName==='background_wait'?e.result?.content?.some(p=>p.type==='text'&&/pi-output:/.test(p.text)):undefined,backgrounded:e.toolName==='bash'&&e.result?.structuredContent?.status==='running',missingFile:e.isError&&e.result?.content?.some(p=>p.type==='text'&&/ENOENT|no such file/i.test(p.text))}));
 pi.on('message_end',e=>{if(e.message.role==='assistant')record('assistant',{reason:e.message.stopReason,usage:e.message.usage,answersSix:e.message.content.some(p=>p.type==='text'&&/(?:6|six)/i.test(p.text)),explainsFailure:e.message.content.some(p=>p.type==='text'&&/schema/i.test(p.text)&&/version/i.test(p.text))});});
}
`;

function tmux(args, env) {
	const result = spawnSync("tmux", ["-S", socket, ...args], {
		env,
		encoding: "utf8",
		timeout: 5000,
	});
	if (result.status !== 0) throw new Error(result.stderr || result.error?.message || "tmux failed");
	return result.stdout;
}
function records(path) {
	if (!fs.existsSync(path)) return [];
	return fs
		.readFileSync(path, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.flatMap((line) => {
			try {
				return [JSON.parse(line)];
			} catch {
				return [];
			}
		});
}
async function until(predicate, milliseconds = 180000) {
	const end = Date.now() + milliseconds;
	while (!predicate()) {
		if (interrupted) throw new Error("Experiment interrupted");
		if (Date.now() > end) throw new Error("Synthetic scenario deadline exceeded");
		await delay(100);
	}
}

try {
	// Extract precisely one explicitly selected provider; never print or copy other entries.
	const credential = JSON.parse(fs.readFileSync(authSource, "utf8"))["opencode-go"];
	if (
		credential?.type !== "api_key" ||
		typeof credential.key !== "string" ||
		!credential.key ||
		credential.key.startsWith("!")
	)
		throw new Error("Selected provider needs a literal stored API key");
	for (const scenario of scenarios) {
		const fixture = join(root, scenario);
		for (const name of ["home", "agent", "tmp", "workspace"])
			fs.mkdirSync(join(fixture, name), { recursive: true, mode: 0o700 });
		const cwd = join(fixture, "workspace");
		container = new ContainerFixture(fixture);
		container.start();
		const waiting = ["waiting", "wait-interrupted", "wait-released", "wait-timeout"].includes(scenario);
		const monitoring = scenario.startsWith("monitor");
		const idleMuted = scenario === "monitor-idle-muted";
		const interruption = ["interrupted", "wait-interrupted", "monitor-interrupted"].includes(scenario) || idleMuted;
		const lifecycle = ["reload", "new", "shutdown"].includes(scenario);
		const promotion = scenario === "promotion" || scenario === "interrupted" || lifecycle;
		const remoteCwd = `/workspace/${scenario}`;
		container.exec(`mkdir ${quote(remoteCwd)}`);
		const audit = join(fixture, "audit.jsonl");
		fs.writeFileSync(join(fixture, "agent", "auth.json"), JSON.stringify({ "opencode-go": credential }), {
			mode: 0o600,
		});
		fs.writeFileSync(
			join(fixture, "agent", "settings.json"),
			JSON.stringify({
				quietStartup: true,
				retry: { enabled: false },
				compaction: { enabled: false },
			}),
			{ mode: 0o600 },
		);
		fs.writeFileSync(join(fixture, "observer.ts"), observer, { mode: 0o600 });
		fs.writeFileSync(
			join(cwd, "records.json"),
			JSON.stringify([
				{ region: "north", value: 41 },
				{ region: "south", value: 57 },
			]),
			{ mode: 0o600 },
		);
		fs.writeFileSync(
			join(cwd, "analyze.mjs"),
			`import fs from 'node:fs';import {setTimeout as delay} from 'node:timers/promises';fs.appendFileSync('launches','one\\n');fs.writeFileSync('job.pid',String(process.pid));fs.writeFileSync('started',String(Date.now()));console.log("Analysis started");await delay(${scenario === "wait-timeout" ? 90000 : promotion || waiting ? 60000 : ["responsive", "panel"].includes(scenario) ? 45000 : 15000});${waiting ? "for(let n=1;n<=80;n++)console.log('Progress line '+n);" : ""}const rows=JSON.parse(fs.readFileSync('records.json','utf8'));console.log(JSON.stringify({count:rows.length,total:rows.reduce((n,r)=>n+r.value,0)}));fs.writeFileSync('completed',String(Date.now()));`,
			{ mode: 0o600 },
		);
		fs.writeFileSync(
			join(cwd, "fail.mjs"),
			`import fs from 'node:fs';import {setTimeout as delay} from 'node:timers/promises';fs.writeFileSync('job.pid',String(process.pid));fs.writeFileSync('started',String(Date.now()));await delay(15000);console.error('Input rejected: fictional batch has no schema version. No report generated.');fs.writeFileSync('completed',String(Date.now()));process.exitCode=7;`,
			{ mode: 0o600 },
		);
		fs.writeFileSync(
			join(cwd, "server.mjs"),
			`import fs from 'node:fs';import http from 'node:http';fs.writeFileSync('service.pid',String(process.pid));fs.writeFileSync('started',String(Date.now()));setTimeout(()=>{const s=http.createServer((_q,r)=>r.end('synthetic-service-ok'));s.listen(0,'127.0.0.1',()=>{fs.writeFileSync('endpoint.txt','http://127.0.0.1:'+s.address().port);console.log('Ready on loopback');});},2000);`,
			{ mode: 0o600 },
		);
		fs.writeFileSync(
			join(cwd, "ready.mjs"),
			`import fs from 'node:fs';import {setTimeout as delay} from 'node:timers/promises';for(let n=0;n<200;n++){if(fs.existsSync('endpoint.txt')){console.log(fs.readFileSync('endpoint.txt','utf8'));process.exit(0);}await delay(50);}console.error('Service was not ready');process.exit(1);`,
			{ mode: 0o600 },
		);
		fs.writeFileSync(join(cwd, "watch.mjs"),
			`import fs from 'node:fs';import {setTimeout as delay} from 'node:timers/promises';fs.writeFileSync('job.pid',String(process.pid));fs.writeFileSync('started',String(Date.now()));await delay(${idleMuted ? 30000 : 15000});console.log('north: 41');await delay(15000);console.log('south: 57');fs.writeFileSync('completed',String(Date.now()));await delay(60000);`,
			{ mode: 0o600 });
		const prompt = idleMuted
			? "Start node watch.mjs using monitor, then finish your reply. I want to test an idle keyboard action before its first event. Do not wait or inspect its status."
			: scenario === "monitor-released"
			? "Start node watch.mjs using monitor, then use background_wait to wait for that process to finish. I may release the wait. When the watcher reports both fictional regional updates, write findings.md with the region count and combined total, then stop the watcher."
			: monitoring
			? "Use monitor to run node watch.mjs. It emits two fictional regional updates and then stays alive. Tell me each update when it arrives; once both arrive, write findings.md with the region count and combined total, then stop the watcher. Keep our conversation available meanwhile."
			: waiting
			? "Start node analyze.mjs in the background on the fictional records. While it runs, write outline.md with sections Input, Findings, and Caveats. Then wait for the analysis result, write findings.md with its count and total, and tell me the result."
			: promotion
				? "Run node analyze.mjs in foreground Bash on the fictional records. I will decide whether to move it to the background. When it finishes, write findings.md with its count and total, and tell me the result."
				: ["responsive", "panel"].includes(scenario)
					? "Start node analyze.mjs on the fictional records. Keep our conversation available while this longer analysis runs; I may ask something else meanwhile. When it finishes, write findings.md with the count and total and tell me the result."
					: scenario === "independent"
						? "Run node analyze.mjs on the fictional records. While that analysis runs, write outline.md with sections Input, Findings, and Caveats. When it finishes, write findings.md containing its count and total, and tell me the result."
						: scenario === "idle"
							? "Run node analyze.mjs on the fictional records, then write findings.md containing its count and total and tell me the result. The analysis may take a little while."
							: scenario === "failure"
								? "Run node fail.mjs once. While it runs, write outline.md with sections Input, Findings, and Caveats. Tell me whether it succeeded and explain any failure; do not alter the supplied script or inputs."
								: "Start the fictional service with node server.mjs. Once ready, endpoint.txt contains its loopback URL; node ready.mjs waits for readiness. Fetch the endpoint and write its response into response.txt. Then stop the service and report the outcome.";
		for (const name of ["records.json", "analyze.mjs", "fail.mjs", "server.mjs", "ready.mjs", "watch.mjs"])
			container.copyFile(join(cwd, name), `${remoteCwd}/${name}`);
		const snapshot = () =>
			JSON.parse(
				container.exec(
					`cd ${quote(remoteCwd)} && node -e ${quote(`
const fs=require('fs');const result={};
for(const name of ['started','job.pid','launches','completed','findings.md','response.txt'])if(fs.existsSync(name)){if(fs.statSync(name).size>8192)throw Error('Oversized synthetic result');result[name]=fs.readFileSync(name,'utf8');}
if(result['job.pid']){try{process.kill(Number(result['job.pid']),0);result.jobAlive=true;}catch{result.jobAlive=false;}}
if(fs.existsSync('service.pid')){try{process.kill(Number(fs.readFileSync('service.pid','utf8')),0);result.serviceAlive=true;}catch{result.serviceAlive=false;}}
console.log(JSON.stringify(result));`)} `,
				),
			);
		fs.mkdirSync(join(fixture, "home", ".ssh"), { mode: 0o700 });
		fs.copyFileSync(container.config, join(fixture, "home", ".ssh", "config"));
		const env = {
			PATH: process.env.PATH,
			HOME: join(fixture, "home"),
			TMPDIR: join(fixture, "tmp"),
			XDG_CONFIG_HOME: join(fixture, "home", ".config"),
			PI_CODING_AGENT_DIR: join(fixture, "agent"),
			BACKGROUND_AUDIT: audit,
			HISTFILE: "/dev/null",
			LANG: "en_US.UTF-8",
			TERM: "xterm-256color",
		};
		const args = [
			...(process.env.PI_BACKGROUND_CLI
				? [process.env.PI_BACKGROUND_CLI]
				: [
						process.execPath,
						"--import",
						pathToFileURL(join(checkout, "packages/coding-agent/src/experimental/source-resolver.ts")).href,
						join(checkout, "packages/coding-agent/src/cli.ts"),
					]),
			"--zdr-client",
			"--no-extensions",
			"--no-skills",
			"--no-context-files",
			"--no-prompt-templates",
			"--no-mcp",
			"--no-themes",
			"--extension",
			join(agentSource, "extensions/execution-guard/index.ts"),
			"--extension",
			join(agentSource, "extensions/teleport/index.ts"),
			"--extension",
			join(agentSource, "extensions/safety/index.ts"),
			"--extension",
			join(agentSource, "extensions/background-work/index.ts"),
			"--extension",
			join(agentSource, "extensions/goal/index.ts"),
			"--extension",
			join(agentSource, "extensions/subagents/index.ts"),
			"--extension",
			join(agentSource, "extensions/you-should-know/index.ts"),
			"--teleport",
			`background-fixture:${remoteCwd}`,
			"--safety",
			"--safety-profile",
			"monitor",
			"--extension",
			join(fixture, "observer.ts"),
			"--model",
			"opencode-go/deepseek-v4.1-flash",
			"--thinking",
			"low",
			"--tools",
			"read,bash,write,edit,read_output,monitor,background_status,background_wait,background_stop",
		];
		if (scenario === "interrupted")
			fs.writeFileSync(
				join(fixture, "agent", "keybindings.json"),
				JSON.stringify({ "extension.background.promote": "ctrl+q" }),
				{ mode: 0o600 },
			);
		fs.writeFileSync(join(fixture, "launch.sh"), `cd ${quote(cwd)}\nexec ${args.map(quote).join(" ")}\n`, {
			mode: 0o600,
		});
		tmux(
			[
				"-f",
				"/dev/null",
				"new-session",
				"-d",
				"-s",
				scenario,
				"-x",
				"100",
				"-y",
				"35",
				"zsh",
				"-f",
				join(fixture, "launch.sh"),
			],
			env,
		);
		console.log(JSON.stringify({ event: "scenario", scenario, socket, fixture }));
		await until(() => records(audit).some((r) => r.event === "ready"), 20000);
		const ready = records(audit).find((r) => r.event === "ready");
		activePid = ready.pid;
		if (
			!["bash", "background_status", "background_wait", "background_stop"].every((name) =>
				ready.tools.includes(name),
			)
		)
			throw new Error("Prototype tools were not exposed");
		tmux(["send-keys", "-t", scenario, "-l", prompt], env);
		tmux(["send-keys", "-t", scenario, "Enter"], env);
		let result;
		let promotedPid;
		let quietAfterInterruption;
		let silentOnNextUserRequest;
		let heldWhilePanelOpen;
		let jobStopped;
		let answeredAfterReplacement;
		if (scenario === "panel") {
			await until(() => records(audit).some((r) => r.event === "tool_end" && r.backgrounded));
			tmux(["send-keys", "-t", scenario, "-l", "/btw What is two plus two?"], env);
			tmux(["send-keys", "-t", scenario, "Enter"], env);
			await delay(1000);
			tmux(["send-keys", "-t", scenario, "-l", "/btw"], env);
			tmux(["send-keys", "-t", scenario, "Enter"], env);
			await until(() => records(audit).some((r) => r.event === "prompt_open"), 10000);
			await until(() => Boolean(snapshot().completed));
			await delay(500);
			heldWhilePanelOpen = !records(audit).some((r) => r.event === "completion");
			if (!heldWhilePanelOpen) throw Error("Completion bypassed the blocking BTW panel");
			tmux(["send-keys", "-t", scenario, "Escape"], env);
			await until(() => records(audit).some((r) => r.event === "prompt_close"), 10000);
		}
		let waitVisible;
		if (waiting || scenario === "monitor-released") {
			await until(() => records(audit).some((r) => r.event === "tool" && r.name === "background_wait"));
			waitVisible = /Background wait/.test(tmux(["capture-pane", "-t", scenario, "-p", "-S", "-100"], env));
		}
		let releasedWhileAlive;
		if (scenario === "wait-released" || scenario === "monitor-released") {
			tmux(["send-keys", "-t", scenario, "C-b"], env);
			await until(() => records(audit).some((r) => r.event === "tool_end" && r.waitOutcome === "released"), 10000);
			releasedWhileAlive = snapshot().jobAlive === true;
		}
		if (promotion || interruption) {
			if (monitoring) await until(() => records(audit).some((r) => r.event === "tool_end" && r.name === "monitor"));
			if (promotion) {
				await until(() => Boolean(snapshot().started));
				promotedPid = snapshot()["job.pid"];
				tmux(["send-keys", "-t", scenario, scenario === "interrupted" ? "C-q" : "C-b"], env);
				await until(() => records(audit).some((r) => r.event === "tool_end" && r.backgrounded), 10000);
			}
			if (lifecycle) {
				if (scenario === "shutdown") {
					process.kill(activePid, "SIGTERM");
					await until(() => {
						try {
							process.kill(activePid, 0);
							return false;
						} catch {
							return true;
						}
					}, 15000);
					activePid = undefined;
				} else {
					tmux(["send-keys", "-t", scenario, "Escape"], env);
					await until(() => records(audit).some((r) => r.event === "settled" && r.aborted), 10000);
					tmux(["send-keys", "-t", scenario, "-l", `/${scenario}`], env);
					tmux(["send-keys", "-t", scenario, "Enter"], env);
					await until(() => records(audit).filter((r) => r.event === "ready").length === 2, 30000);
					const settled = records(audit).filter((r) => r.event === "settled").length;
					tmux(["send-keys", "-t", scenario, "-l", "New topic: what is three plus three?"], env);
					tmux(["send-keys", "-t", scenario, "Enter"], env);
					await until(() => records(audit).filter((r) => r.event === "settled").length > settled);
					answeredAfterReplacement =
						records(audit).findLast((r) => r.event === "assistant")?.answersSix === true;
				}
				await until(() => snapshot().jobAlive === false, 10000);
				result = snapshot();
				jobStopped = result.jobAlive === false && !result.completed;
			} else if (interruption) {
				if (idleMuted) {
					await until(() => records(audit).at(-1)?.event === "settled", 25000);
					if (!snapshot().jobAlive || records(audit).some((r) => r.event === "completion"))
						throw Error("Idle interruption requires a live watcher before its first event");
				}
				tmux(["send-keys", "-t", scenario, "Escape"], env);
				await until(() => records(audit).some((r) => idleMuted ? r.event === "interrupt" : r.event === "settled" && r.aborted), 10000);
				if (idleMuted) {
					for (const width of [140, 60, 100]) {
						tmux(["resize-window", "-t", scenario, "-x", String(width)], env);
						await delay(150);
						const screen = tmux(["capture-pane", "-t", scenario, "-p"], env);
						console.log(JSON.stringify({ event: "footer", width, lines: screen.trimEnd().split("\n").slice(-3) }));
						if (width === 140 && (!screen.includes("automatic updates off") || !screen.includes("│ teleport background-fixture:")))
							throw Error("Muted footer or status grouping missing");
					}
					if (!snapshot().jobAlive) throw Error("Idle interruption stopped the watcher");
				}
				const settled = records(audit).filter((r) => r.event === "settled").length;
				tmux(["send-keys", "-t", scenario, "-l", "Different topic: what is two plus two?"], env);
				tmux(["send-keys", "-t", scenario, "Enter"], env);
				await until(() => records(audit).filter((r) => r.event === "settled").length > settled);
				const starts = records(audit).filter((r) => r.event === "start").length;
				await until(() => Boolean(snapshot().completed));
				await delay(1500);
				quietAfterInterruption =
					records(audit).filter((r) => r.event === "start").length === starts &&
					!records(audit).some((r) => r.event === "completion");
				if (!quietAfterInterruption) throw Error("Interrupted job woke the agent");
				const nextSettled = records(audit).filter((r) => r.event === "settled").length;
				tmux(["send-keys", "-t", scenario, "-l", "What is three plus three?"], env);
				tmux(["send-keys", "-t", scenario, "Enter"], env);
				await until(() => records(audit).filter((r) => r.event === "settled").length > nextSettled);
				silentOnNextUserRequest =
					records(audit).filter((r) => r.event === "completion").length === 0 &&
					records(audit).filter((r) => r.event === "start").length === starts + 1;
				result = snapshot();
			} else {
				await until(() => records(audit).some((r) => r.event === "settled"));
			}
		}
		if (!interruption && !lifecycle)
			await until(() => {
				const events = records(audit);
				const last = events.at(-1);
				if (events.some((r) => r.event === "assistant" && r.reason === "error"))
					throw new Error("Live provider or agent error");
				if (last?.event !== "settled") return false;
				result = snapshot();
				return scenario === "service"
					? "response.txt" in result
					: scenario === "failure"
						? "completed" in result && last.at > Number(result.completed)
						: "findings.md" in result;
			});
		const events = records(audit);
		const completeAt = result.completed ? Number(result.completed) : undefined;
		const delivered = events.find((r) => r.event === "completion");
		const findings = result["findings.md"] || "";
		const response = result["response.txt"]?.trim();
		const firstOutline = events.find((r) => r.event === "tool" && r.outline);
		const outlineCreatedAt =
			firstOutline &&
			events.find((r) => r.event === "tool_end" && r.id === firstOutline.id && !r.error)?.at;
		const report = {
			scenario,
			backgroundReceipts: events.filter((r) => r.event === "tool_end" && r.backgrounded).length,
			sameProcess: promotion
				? result["job.pid"] === promotedPid && result.launches === "one\n"
				: undefined,
			quietAfterInterruption,
			silentOnNextUserRequest,
			heldWhilePanelOpen,
			jobStopped,
			answeredAfterReplacement,
			oldTaskResumed: interruption ? Boolean(result["findings.md"]) : undefined,
			answeredNewQuestion: interruption ? events.findLast((r) => r.event === "assistant")?.answersSix : undefined,
			waitVisible,
			releasedWhileAlive,
			waitResults: events
				.filter((r) => r.event === "tool_end" && r.name === "background_wait")
				.map((r) => ({
					error: r.error,
					outcome: r.waitOutcome,
					durationMs: r.durationMs,
					receiptBytes: r.receiptBytes,
					retained: r.retained,
				})),
			pollingCalls: events.filter((r) => r.event === "tool" && (r.polling || r.name === "background_status")).length,
			tools: events.filter((r) => r.event === "tool").map((r) => r.name),
			foregroundDurationsMs: events
				.filter((r) => r.event === "tool_end" && r.name === "bash")
				.map((r) => r.durationMs),
			toolErrors: events.filter((r) => r.event === "tool_end" && r.error).length,
			errorTools: events
				.filter((r) => r.event === "tool_end" && r.error)
				.map((r) => ({ name: r.name, missingFile: r.missingFile })),
			failureDelivered: scenario === "failure" ? delivered?.expectedFailure === true : undefined,
			failureExplained:
				scenario === "failure"
					? events.findLast((r) => r.event === "assistant")?.explainsFailure === true
					: undefined,
			completions: events.filter((r) => r.event === "completion").length,
			completionDuringRun: delivered
				? !events.some((r) => r.event === "settled" && r.at < delivered.at)
				: undefined,
			settledBeforeCompletion: completeAt
				? events.some((r) => r.event === "settled" && r.at < completeAt)
				: undefined,
			independentWorkBeforeCompletion:
				completeAt && outlineCreatedAt !== undefined ? outlineCreatedAt < completeAt : undefined,
			deliveryDelayMs: delivered && completeAt ? delivered.entryAt - completeAt : undefined,
			findingsCorrect: findings ? /98/.test(findings) && /2/.test(findings) : undefined,
			responseCorrect: scenario === "service" ? response === "synthetic-service-ok" : undefined,
			serviceAlive: result.serviceAlive,
			monitorStopped: monitoring ? result.jobAlive === false : undefined,
			monitorVisible: monitoring ? /watching|Monitor #\d+ · update|monitoring/.test(tmux(["capture-pane", "-t", scenario, "-p", "-S", "-150"], env)) : undefined,
			usage: events.filter((r) => r.event === "assistant").map((r) => r.usage),
		};
		console.log(JSON.stringify(report));
		if (
			lifecycle &&
			(!jobStopped ||
				report.completions !== 0 ||
				(scenario !== "shutdown" && !answeredAfterReplacement))
		)
			throw Error("Lifecycle cleanup or replacement failed");
		if (promotion && !report.sameProcess) throw Error("Promotion did not preserve one process");
		if (
			interruption &&
			(!report.quietAfterInterruption ||
				!report.silentOnNextUserRequest ||
				report.oldTaskResumed ||
				!report.answeredNewQuestion)
		)
			throw Error("Interruption contract failed");
		if (scenario === "service" && (!report.responseCorrect || report.serviceAlive !== false))
			throw Error("Service result or cleanup failed");
		if (scenario === "failure" && (!report.failureDelivered || !report.failureExplained))
			throw Error("Failure was not delivered and explained");
		if (
			!interruption && !["service", "failure", "reload", "new", "shutdown"].includes(scenario) &&
			!report.findingsCorrect
		)
			throw Error("Analysis findings are incorrect");
		if (["monitor", "monitor-released"].includes(scenario) && (!report.monitorStopped || !report.monitorVisible || report.completions < 2 || report.pollingCalls))
			throw Error("Monitor delivery, rendering or stop failed");
		if (
			scenario === "waiting" &&
			(report.waitResults.length !== 1 ||
				report.waitResults[0].error ||
				!report.waitResults[0].retained ||
				report.waitResults[0].receiptBytes > 1500 ||
				report.completions !== 0 ||
				report.pollingCalls !== 0 ||
				!report.independentWorkBeforeCompletion ||
				!waitVisible)
		)
			throw Error("Prerequisite waiting contract failed");
		if (["wait-released", "monitor-released"].includes(scenario) && (!releasedWhileAlive || !report.waitResults.some((r) => r.outcome === "released" && !r.error))) throw Error("Wait release failed");
		if (scenario === "wait-timeout" && !report.waitResults.some((r) => r.outcome === "timeout" && !r.error && r.durationMs >= 59000 && r.durationMs < 65000)) throw Error("Wait deadline failed");
		reports.push(report);
		// Leave a short window to inspect synthetic terminal text; no screenshots or saved transcript.
		await delay(1000);
		if (activePid) {
			tmux(["send-keys", "-t", scenario, "C-d"], env);
			await delay(300);
			try {
				process.kill(activePid, 0);
				tmux(["send-keys", "-t", scenario, "C-d"], env);
			} catch {}
			await until(() => {
				try {
					process.kill(activePid, 0);
					return false;
				} catch {
					return true;
				}
			}, 10000);
			activePid = undefined;
		}

		if (fs.existsSync(join(fixture, "agent", "sessions")))
			throw new Error("Live session was persisted");
		if (
			fs
				.readdirSync(join(fixture, "tmp"))
				.some((n) =>
					["pi-background-", "pi-session-output-", "pi-teleport-output-"].some((prefix) => n.startsWith(prefix)),
				)
		)
			throw new Error("Owned job output was not cleaned");
		const residue = container.exec("find /tmp -maxdepth 1 -name 'pi-teleport-*' -print").trim();
		if (residue) throw new Error("Container worker scratch was not cleaned");
		container.close();
		container = undefined;
		fs.rmSync(fixture, { recursive: true, force: true });
	}
	console.log(JSON.stringify({ event: "complete", scenarios: reports.length }));
} finally {
	if (activePid) {
		try {
			process.kill(activePid, "SIGTERM");
		} catch {}
		await delay(1000);
	}
	try {
		container?.close();
	} finally {
		spawnSync("tmux", ["-S", socket, "kill-server"], {
			stdio: "ignore",
			timeout: 5000,
		});
		if (activePid) {
			try {
				process.kill(activePid, "SIGKILL");
			} catch {}
		}
		fs.rmSync(root, { recursive: true, force: true });
	}
}
