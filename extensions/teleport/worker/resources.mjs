import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
const MAX_SKILL_FILE_BYTES = 256 * 1024;
const MAX_SKILL_TOTAL_BYTES = 4 * 1024 * 1024;
const MAX_SKILL_FILES = 256;
const MAX_SKILL_DIRECTORIES = 4096;
const MAX_SKILL_DEPTH = 32;
const MAX_PROMPT_FILE_BYTES = 256 * 1024;
const MAX_PROMPT_TOTAL_BYTES = 4 * 1024 * 1024;
const MAX_PROMPT_FILES = 256;

export function createResourceOperations({ cwd, gitRoot }) {
	async function discoverContextFiles() {
		const globalDirectory = join(homedir(), ".pi", "agent");
		const global = await discoverContextFile(globalDirectory);
		const ancestors = [];
		const seen = new Set(global ? [global.path] : []);
		let totalBytes = 0;
		if (global) totalBytes += Buffer.byteLength(global.content, "utf8");
		for (let directory = cwd; ; ) {
			const file = await discoverContextFile(directory);
			if (file && !seen.has(file.path)) {
				totalBytes += Buffer.byteLength(file.content, "utf8");
				if (totalBytes > 1024 * 1024) {
					throw Object.assign(new Error("context files exceed 1MB aggregate limit"), { code: "LIMIT_EXCEEDED" });
				}
				ancestors.unshift(file);
				seen.add(file.path);
			}
			const parent = dirname(directory);
			if (parent === directory) break;
			directory = parent;
		}
		return global ? [global, ...ancestors] : ancestors;
	}

	async function discoverContextFile(directory) {
		const candidates = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];
		for (const name of candidates) {
			const path = join(directory, name);
			try {
				const metadata = await stat(path);
				if (!metadata.isFile()) continue;
				if (metadata.size > 256 * 1024) {
					throw Object.assign(new Error(`context file exceeds 256KB limit: ${path}`), { code: "LIMIT_EXCEEDED" });
				}
				const content = await readFile(path, "utf8");
				if (Buffer.byteLength(content) > 256 * 1024)
					throw Object.assign(new Error("context file exceeds 256KB limit"), { code: "LIMIT_EXCEEDED" });
				return { path, content };
			} catch (error) {
				if (error?.code === "ENOENT") continue;
				throw error;
			}
		}
		return undefined;
	}

	async function discoverSkillDocuments() {
		const userAgentsRoot = join(homedir(), ".agents", "skills");
		const projectRoots = [{ path: join(cwd, ".pi", "skills"), mode: "pi", scope: "project" }];
		for (let directory = cwd; ; ) {
			const agentsRoot = join(directory, ".agents", "skills");
			if (agentsRoot !== userAgentsRoot) {
				projectRoots.push({ path: agentsRoot, mode: "agents", scope: "project" });
			}
			if (gitRoot && directory === gitRoot) break;
			const parent = dirname(directory);
			if (parent === directory) break;
			directory = parent;
		}
		const roots = [
			...projectRoots,
			{ path: join(homedir(), ".pi", "agent", "skills"), mode: "pi", scope: "user" },
			{ path: userAgentsRoot, mode: "agents", scope: "user" },
		];
		const state = {
			documents: [],
			seenFiles: new Set(),
			seenDirectories: new Set(),
			totalBytes: 0,
		};
		for (const skillRoot of roots) {
			await collectSkillDocuments(skillRoot.path, skillRoot, state, 0);
		}
		return state.documents;
	}

	async function collectSkillDocuments(directory, skillRoot, state, depth) {
		if (depth > MAX_SKILL_DEPTH) {
			throw Object.assign(new Error(`skill discovery exceeds depth limit: ${directory}`), { code: "LIMIT_EXCEEDED" });
		}

		let canonicalDirectory;
		let entries;
		try {
			canonicalDirectory = await realpath(directory);
			if (state.seenDirectories.has(canonicalDirectory)) return;
			state.seenDirectories.add(canonicalDirectory);
			if (state.seenDirectories.size > MAX_SKILL_DIRECTORIES) {
				throw Object.assign(new Error("skill discovery exceeds directory limit"), { code: "LIMIT_EXCEEDED" });
			}
			entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
				left.name.localeCompare(right.name),
			);
		} catch (error) {
			if (error?.code === "ENOENT" || error?.code === "ENOTDIR" || error?.code === "EACCES") return;
			throw error;
		}

		const declared = entries.find((entry) => entry.name === "SKILL.md");
		if (declared && (await isRegularFile(join(directory, declared.name)))) {
			await addSkillDocument(join(directory, declared.name), skillRoot.scope, state);
			return;
		}

		for (const entry of entries) {
			if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
			const path = join(directory, entry.name);
			let metadata;
			try {
				metadata = entry.isSymbolicLink() ? await stat(path) : entry;
			} catch {
				continue;
			}
			if (metadata.isDirectory()) {
				await collectSkillDocuments(path, skillRoot, state, depth + 1);
				continue;
			}
			const includeMarkdown =
				metadata.isFile() &&
				entry.name.endsWith(".md") &&
				((skillRoot.mode === "pi" && depth === 0) || (skillRoot.mode === "agents" && depth > 0));
			if (includeMarkdown) await addSkillDocument(path, skillRoot.scope, state);
		}
	}

	async function isRegularFile(path) {
		try {
			return (await stat(path)).isFile();
		} catch {
			return false;
		}
	}

	async function addSkillDocument(path, scope, state) {
		const canonicalPath = await realpath(path);
		if (state.seenFiles.has(canonicalPath)) return;
		const metadata = await stat(path);
		if (metadata.size > MAX_SKILL_FILE_BYTES) {
			throw Object.assign(new Error(`skill file exceeds 256KB limit: ${path}`), { code: "LIMIT_EXCEEDED" });
		}
		if (state.documents.length >= MAX_SKILL_FILES) {
			throw Object.assign(new Error("skill discovery exceeds file limit"), { code: "LIMIT_EXCEEDED" });
		}
		const content = await readFile(path, "utf8");
		const bytes = Buffer.byteLength(content, "utf8");
		if (bytes > MAX_SKILL_FILE_BYTES) {
			throw Object.assign(new Error(`skill file exceeds 256KB limit: ${path}`), { code: "LIMIT_EXCEEDED" });
		}
		state.totalBytes += bytes;
		if (state.totalBytes > MAX_SKILL_TOTAL_BYTES) {
			throw Object.assign(new Error("skill files exceed 4MB aggregate limit"), { code: "LIMIT_EXCEEDED" });
		}
		state.seenFiles.add(canonicalPath);
		state.documents.push({ path, content, scope });
	}

	async function discoverPromptDocuments() {
		const roots = [
			{ path: join(cwd, ".pi", "prompts"), scope: "project" },
			{ path: join(homedir(), ".pi", "agent", "prompts"), scope: "user" },
		];
		const documents = [];
		const seen = new Set();
		let totalBytes = 0;
		for (const root of roots) {
			let entries;
			try {
				entries = (await readdir(root.path, { withFileTypes: true })).sort((left, right) =>
					left.name.localeCompare(right.name),
				);
			} catch (error) {
				if (error?.code === "ENOENT" || error?.code === "ENOTDIR" || error?.code === "EACCES") continue;
				throw error;
			}
			for (const entry of entries) {
				if (!entry.name.endsWith(".md")) continue;
				const path = join(root.path, entry.name);
				if (!(await isRegularFile(path))) continue;
				const canonicalPath = await realpath(path);
				if (seen.has(canonicalPath)) continue;
				const metadata = await stat(path);
				if (metadata.size > MAX_PROMPT_FILE_BYTES) {
					throw Object.assign(new Error(`prompt file exceeds 256KB limit: ${path}`), { code: "LIMIT_EXCEEDED" });
				}
				if (documents.length >= MAX_PROMPT_FILES) {
					throw Object.assign(new Error("prompt discovery exceeds file limit"), { code: "LIMIT_EXCEEDED" });
				}
				const content = await readFile(path, "utf8");
				if (Buffer.byteLength(content) > MAX_PROMPT_FILE_BYTES)
					throw Object.assign(new Error("prompt file exceeds 256KB limit"), { code: "LIMIT_EXCEEDED" });
				totalBytes += Buffer.byteLength(content, "utf8");
				if (totalBytes > MAX_PROMPT_TOTAL_BYTES) {
					throw Object.assign(new Error("prompt files exceed 4MB aggregate limit"), { code: "LIMIT_EXCEEDED" });
				}
				seen.add(canonicalPath);
				documents.push({ path, content, scope: root.scope });
			}
		}
		return documents;
	}
	return { context: discoverContextFiles, skills: discoverSkillDocuments, prompts: discoverPromptDocuments };
}
