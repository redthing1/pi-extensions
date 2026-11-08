import { lstat, readFile, realpath, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createFileOperations } from "./files.mjs";
import { createPathResolver, findGitRoot, firstExecutable, resolveStartupPath } from "./paths.mjs";
import { createProcessOperations } from "./processes.mjs";
import { createProtocol, FRAME, PROTOCOL_VERSION } from "./protocol.mjs";
import { createResourceOperations } from "./resources.mjs";

const [nonce, requestedCwd, cleanupDirectory] = process.argv.slice(2);
let closing = false;
let exiting;
let processes;
let handleFile;
let resources;
let cwd;
const requests = new Set();
const FILE_OPERATIONS = new Set([
	"read",
	"write",
	"stat",
	"canonicalize",
	"mime",
	"list",
	"mkdir",
	"remove",
	"rename",
	"prepare_isolated_workspace",
]);
const protocol = createProtocol(acceptRequest, fatal);
const { writeFrame, writeStreamingFrame } = protocol;

async function ownsScratch() {
	if (!cleanupDirectory || !nonce) return false;
	try {
		const directory = await lstat(cleanupDirectory);
		const marker = await lstat(join(cleanupDirectory, ".owner"));
		return (
			directory.isDirectory() &&
			!directory.isSymbolicLink() &&
			marker.isFile() &&
			!marker.isSymbolicLink() &&
			marker.size === Buffer.byteLength(nonce) &&
			(await readFile(join(cleanupDirectory, ".owner"), "utf8")) === nonce
		);
	} catch {
		return false;
	}
}

async function cleanupAndExit(code) {
	if (exiting) return exiting;
	exiting = (async () => {
		closing = true;
		protocol.stop();
		process.stdin.pause();
		try {
			await processes?.stopActiveCommands();
			if (await ownsScratch()) await rm(cleanupDirectory, { recursive: true, force: true });
		} catch {
			process.stderr.write("Teleport worker scratch cleanup failed\n");
			code ||= 1;
		}
		process.exit(code);
	})();
	return exiting;
}

function fatal(error) {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	void cleanupAndExit(1);
}

function errorCode(error) {
	return (
		{
			ENOENT: "NOT_FOUND",
			EACCES: "PERMISSION_DENIED",
			EEXIST: "ALREADY_EXISTS",
			EISDIR: "IS_DIRECTORY",
			ENOTDIR: "NOT_DIRECTORY",
		}[error?.code] ?? (["ABORTED", "LIMIT_EXCEEDED", "UNSUPPORTED"].includes(error?.code) ? error.code : "INTERNAL")
	);
}

function acceptRequest(frame) {
	const { header } = frame;
	if (
		!header ||
		typeof header !== "object" ||
		Array.isArray(header) ||
		typeof header.id !== "string" ||
		!/^r[1-9][0-9]{0,15}$/u.test(header.id) ||
		typeof header.op !== "string" ||
		!header.params ||
		typeof header.params !== "object" ||
		Array.isArray(header.params) ||
		requests.has(header.id) ||
		requests.size >= 64
	)
		throw new Error("malformed, duplicate, or excessive worker request");
	requests.add(header.id);
	void handleRequest(frame)
		.catch(fatal)
		.finally(() => requests.delete(header.id));
}

async function handleRequest(frame) {
	const { id, op, params } = frame.header;
	try {
		if (closing) throw Object.assign(new Error("worker is shutting down"), { code: "ABORTED" });
		if (FILE_OPERATIONS.has(op)) return await handleFile(id, op, params, frame);
		if (op === "context" || op === "skills" || op === "prompts") {
			const documents = await resources[op]();
			writeFrame(FRAME.result, { id, result: { count: documents.length } }, Buffer.from(JSON.stringify(documents)));
			return;
		}
		switch (op) {
			case "ping":
				writeFrame(FRAME.result, { id, result: { cwd, pid: process.pid } });
				return;
			case "exec":
				await processes.executeCommand(id, params);
				return;
			case "grep":
			case "find":
				await processes.search(id, op, params);
				return;
			case "cancel":
				if (typeof params.targetId !== "string") throw new Error("invalid cancellation target");
				writeFrame(FRAME.result, { id, result: { accepted: processes.cancelCommand(params.targetId) } });
				return;
			case "shutdown":
				closing = true;
				await processes.stopActiveCommands();
				writeFrame(FRAME.result, { id, result: { closing: true } });
				return;
			default:
				throw Object.assign(new Error(`unsupported operation: ${op}`), { code: "UNSUPPORTED" });
		}
	} catch (error) {
		writeFrame(FRAME.error, {
			id,
			code: errorCode(error),
			message: error instanceof Error ? error.message : String(error),
		});
	}
}

// Install teardown before filesystem discovery so early startup failures are owned.
process.once("SIGTERM", () => void cleanupAndExit(143));
process.once("SIGINT", () => void cleanupAndExit(130));
process.once("SIGHUP", () => void cleanupAndExit(129));
process.stdin.on("end", () => {
	try {
		protocol.finish();
	} catch (error) {
		fatal(error);
		return;
	}
	void cleanupAndExit(0);
});

try {
	if (!nonce || !requestedCwd || !(await ownsScratch()))
		throw new Error("worker requires an owned scratch directory, nonce, and cwd");
	// All first-party modules are statically imported above. Retire their files
	// before readiness; only the ownership marker and live overflow need storage.
	for (const name of ["worker.mjs", "protocol.mjs", "paths.mjs", "files.mjs", "processes.mjs", "resources.mjs"]) {
		await rm(join(cleanupDirectory, name));
	}
	cwd = await realpath(resolveStartupPath(requestedCwd));
	const gitRoot = await findGitRoot(cwd);
	const resolveRemotePath = createPathResolver(cwd);
	const rgPath = await firstExecutable(["rg", "/usr/local/bin/rg", "/usr/bin/rg"]);
	const fdPath = await firstExecutable(["fd", "fdfind", "/usr/local/bin/fd", "/usr/bin/fd", "/usr/bin/fdfind"]);
	const shellPath = await firstExecutable([process.env.SHELL, "/bin/bash", "/usr/bin/bash", "/bin/sh", "/usr/bin/sh"]);
	if (!shellPath) throw new Error("no supported remote shell is available");
	processes = createProcessOperations({
		cwd,
		shellPath,
		cleanupDirectory,
		resolveRemotePath,
		writeFrame,
		writeStreamingFrame,
		rgPath,
		fdPath,
	});
	handleFile = createFileOperations({ resolveRemotePath, writeFrame });
	resources = createResourceOperations({ cwd, gitRoot });
	process.stdin.on("data", protocol.accept);
	writeFrame(FRAME.ready, {
		nonce,
		protocolVersion: PROTOCOL_VERSION,
		cwd,
		root: gitRoot ?? cwd,
		home: homedir(),
		pid: process.pid,
		runtime: process.version,
		shell: shellPath,
		capabilities: { find: fdPath !== undefined, grep: rgPath !== undefined },
	});
} catch (error) {
	fatal(error);
}
