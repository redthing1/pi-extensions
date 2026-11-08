import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
	chmod,
	copyFile,
	lstat,
	mkdir,
	open,
	opendir,
	readFile,
	readdir,
	readlink,
	realpath,
	rename,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { FRAME, MAX_PAYLOAD_BYTES } from "./protocol.mjs";

export function createFileOperations({ resolveRemotePath, writeFrame }) {
	function fileKind(metadata) {
		if (metadata.isFile()) return "file";
		if (metadata.isDirectory()) return "directory";
		if (metadata.isSymbolicLink()) return "symlink";
		if (metadata.isBlockDevice()) return "block";
		if (metadata.isCharacterDevice()) return "character";
		if (metadata.isFIFO()) return "fifo";
		if (metadata.isSocket()) return "socket";
		return "other";
	}

	function metadataResult(path, metadata) {
		return {
			path,
			kind: fileKind(metadata),
			bytes: metadata.size,
			mode: metadata.mode,
			mtimeMs: metadata.mtimeMs,
		};
	}

	async function detectImageMimeType(path) {
		const handle = await open(path, "r");
		try {
			const bytes = Buffer.alloc(16);
			const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
			const header = bytes.subarray(0, bytesRead);
			if (
				header.length >= 8 &&
				header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
			)
				return "image/png";
			if (header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) return "image/jpeg";
			if (
				header.length >= 6 &&
				(header.subarray(0, 6).toString("ascii") === "GIF87a" || header.subarray(0, 6).toString("ascii") === "GIF89a")
			)
				return "image/gif";
			if (
				header.length >= 12 &&
				header.subarray(0, 4).toString("ascii") === "RIFF" &&
				header.subarray(8, 12).toString("ascii") === "WEBP"
			)
				return "image/webp";
			if (header.length >= 2 && header.subarray(0, 2).toString("ascii") === "BM") return "image/bmp";
			return null;
		} finally {
			await handle.close();
		}
	}

	async function prepareIsolatedWorkspace(params) {
		if (params.mode !== "blank" && params.mode !== "copy") {
			throw new Error("isolated workspace mode is invalid");
		}
		if (!Array.isArray(params.stages) || params.stages.length === 0) {
			throw new Error("isolated workspace stages are invalid");
		}
		const stageNames = params.stages.map((stage) => {
			if (typeof stage !== "string" || !/^[a-zA-Z0-9_.-]+$/u.test(stage) || stage === "." || stage === "..") {
				throw new Error("isolated workspace stage name is invalid");
			}
			return stage;
		});
		if (new Set(stageNames).size !== stageNames.length) {
			throw new Error("isolated workspace stage names must be unique");
		}

		const runRoot = resolveRemotePath(params.root);
		const source = await realpath(resolveRemotePath(params.source));
		if (isWithin(source, runRoot) || isWithin(runRoot, source)) {
			throw new Error("isolated workspace root must be separate from its source");
		}
		await mkdir(dirname(runRoot), { recursive: true, mode: 0o700 });
		await mkdir(runRoot, { mode: 0o700 });
		try {
			const base = join(runRoot, "base");
			await mkdir(base, { mode: 0o700 });
			if (params.mode === "copy") {
				const before = await treeDigest(source, false);
				await copyTreeContents(source, base);
				const after = await treeDigest(source, false);
				if (before !== after) throw new Error("workspace changed while it was being copied");
			}
			const stages = Object.create(null);
			for (const stage of stageNames) {
				const destination = join(runRoot, stage, "workspace");
				await mkdir(destination, { recursive: true, mode: 0o700 });
				await copyTreeContents(base, destination);
				stages[stage] = destination;
			}
			return {
				root: runRoot,
				base,
				digest: await treeDigest(base, true),
				stages,
			};
		} catch (error) {
			await rm(runRoot, { recursive: true, force: true });
			throw error;
		}
	}

	async function copyTreeContents(source, destination) {
		const sourceRoot = await realpath(source);
		const destinationRoot = await realpath(destination);
		await copyTreeContentsWithin(sourceRoot, destinationRoot, sourceRoot, destinationRoot);
	}

	async function copyTreeContentsWithin(source, destination, sourceRoot, destinationRoot) {
		for (const entry of await readdir(source, { withFileTypes: true })) {
			await copyTreeEntry(join(source, entry.name), join(destination, entry.name), sourceRoot, destinationRoot);
		}
	}

	async function copyTreeEntry(source, destination, sourceRoot, destinationRoot) {
		const metadata = await lstat(source);
		if (metadata.isSymbolicLink()) {
			const target = await readlink(source);
			const resolvedTarget = resolve(dirname(source), target);
			if (!isWithin(sourceRoot, resolvedTarget)) {
				throw Object.assign(new Error(`cannot copy symlink outside workspace: ${source} -> ${target}`), {
					code: "UNSUPPORTED",
				});
			}
			const copiedTarget = join(destinationRoot, relative(sourceRoot, resolvedTarget));
			await mkdir(dirname(destination), { recursive: true });
			await symlink(relative(dirname(destination), copiedTarget) || ".", destination);
			return;
		}
		if (metadata.isDirectory()) {
			await mkdir(destination, { mode: metadata.mode & 0o777 });
			await copyTreeContentsWithin(source, destination, sourceRoot, destinationRoot);
			await chmod(destination, metadata.mode & 0o777);
			return;
		}
		if (!metadata.isFile()) {
			throw Object.assign(new Error(`cannot copy special filesystem entry: ${source}`), { code: "UNSUPPORTED" });
		}
		if (basename(source) === ".git") {
			throw Object.assign(new Error(`cannot copy Git metadata file that may point outside workspace: ${source}`), {
				code: "UNSUPPORTED",
			});
		}
		await mkdir(dirname(destination), { recursive: true });
		await copyFile(source, destination, constants.COPYFILE_FICLONE);
		await chmod(destination, metadata.mode & 0o777);
	}

	async function treeDigest(rootPath, includeContents) {
		const hash = createHash("sha256");
		await updateTreeDigest(hash, rootPath, rootPath, includeContents);
		return hash.digest("hex");
	}

	async function updateTreeDigest(hash, rootPath, current, includeContents) {
		for (const entry of (await readdir(current, { withFileTypes: true })).sort((left, right) =>
			left.name.localeCompare(right.name),
		)) {
			const path = join(current, entry.name);
			const name = relative(rootPath, path);
			const metadata = await lstat(path);
			if (metadata.isSymbolicLink()) {
				hash.update(`link\0${name}\0${await readlink(path)}\0`);
				continue;
			}
			if (metadata.isDirectory()) {
				hash.update(`directory\0${name}\0${metadata.mode & 0o777}\0${metadata.mtimeMs}\0`);
				await updateTreeDigest(hash, rootPath, path, includeContents);
				continue;
			}
			if (!metadata.isFile()) {
				throw Object.assign(new Error(`cannot inspect special filesystem entry: ${path}`), { code: "UNSUPPORTED" });
			}
			hash.update(`file\0${name}\0${metadata.mode & 0o777}\0${metadata.size}\0${metadata.mtimeMs}\0`);
			if (includeContents) hash.update(await readFile(path));
			hash.update("\0");
		}
	}

	function isWithin(rootPath, candidate) {
		const path = relative(rootPath, candidate);
		return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
	}
	return async function handleFileOperation(id, op, params, frame) {
		switch (op) {
			case "read": {
				const path = resolveRemotePath(params.path);
				const metadata = await stat(path);
				if (!metadata.isFile())
					throw Object.assign(new Error("read target is not a regular file"), { code: "UNSUPPORTED" });
				if (metadata.size > MAX_PAYLOAD_BYTES)
					throw Object.assign(new Error("file exceeds worker frame limit"), { code: "LIMIT_EXCEEDED" });
				const content = await readFile(path);
				if (content.length > MAX_PAYLOAD_BYTES) {
					throw Object.assign(new Error("file exceeds worker frame limit"), { code: "LIMIT_EXCEEDED" });
				}
				writeFrame(FRAME.result, { id, result: { path, bytes: content.length } }, content);
				return;
			}
			case "write": {
				const path = resolveRemotePath(params.path);
				await mkdir(dirname(path), { recursive: true });
				await writeFile(path, frame.payload);
				writeFrame(FRAME.result, { id, result: { path, bytes: frame.payload.length } });
				return;
			}
			case "stat": {
				const path = resolveRemotePath(params.path);
				const metadata = params.follow === true ? await stat(path) : await lstat(path);
				writeFrame(FRAME.result, { id, result: metadataResult(path, metadata) });
				return;
			}
			case "canonicalize": {
				const path = await realpath(resolveRemotePath(params.path));
				writeFrame(FRAME.result, { id, result: { path } });
				return;
			}
			case "mime": {
				const path = resolveRemotePath(params.path);
				writeFrame(FRAME.result, { id, result: { path, mimeType: await detectImageMimeType(path) } });
				return;
			}
			case "list": {
				const path = resolveRemotePath(params.path ?? ".");
				const maximum = Number.isInteger(params.maxEntries) ? Math.min(Math.max(params.maxEntries, 1), 10_000) : 2_000;
				const selected = [];
				let truncated = false;
				const directory = await opendir(path);
				for await (const entry of directory) {
					if (selected.length >= maximum) {
						truncated = true;
						break;
					}
					selected.push({
						name: entry.name,
						kind: entry.isDirectory()
							? "directory"
							: entry.isFile()
								? "file"
								: entry.isSymbolicLink()
									? "symlink"
									: "other",
					});
				}
				const payload = Buffer.from(JSON.stringify(selected), "utf8");
				writeFrame(FRAME.result, { id, result: { path, count: selected.length, truncated } }, payload);
				return;
			}
			case "mkdir": {
				const path = resolveRemotePath(params.path);
				await mkdir(path, { recursive: params.recursive !== false });
				writeFrame(FRAME.result, { id, result: { path } });
				return;
			}
			case "remove": {
				const path = resolveRemotePath(params.path);
				await rm(path, { recursive: params.recursive === true, force: params.force === true });
				writeFrame(FRAME.result, { id, result: { path } });
				return;
			}
			case "rename": {
				const from = resolveRemotePath(params.from);
				const to = resolveRemotePath(params.to);
				await mkdir(dirname(to), { recursive: true });
				await rename(from, to);
				writeFrame(FRAME.result, { id, result: { from, to } });
				return;
			}
			case "prepare_isolated_workspace": {
				const prepared = await prepareIsolatedWorkspace(params);
				writeFrame(FRAME.result, { id, result: prepared });
				return;
			}
			default:
				throw Object.assign(new Error("unsupported file operation: " + op), { code: "UNSUPPORTED" });
		}
	};
}
