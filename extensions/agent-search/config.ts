import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

import type { ResolvedAgentSearchConfig } from "./types.ts";

const DEFAULT_TOKEN = "agent-search";
const TOKEN_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export class AgentSearchConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AgentSearchConfigError";
	}
}

export function loadAgentSearchConfig(
	cliEnabled: boolean,
): ResolvedAgentSearchConfig | undefined {
	const agentDir = getAgentDir();
	const settingsPath = join(agentDir, "settings.json");
	const raw = existsSync(settingsPath)
		? readJsonObject(settingsPath, "Pi settings").agentSearch
		: undefined;
	if (raw !== undefined && !isRecord(raw)) {
		throw new AgentSearchConfigError("agentSearch must be an object");
	}

	const settings = raw ?? {};
	const unknown = Object.keys(settings).filter(
		(key) => !["alwaysEnabled", "token"].includes(key),
	);
	if (unknown.length > 0) {
		throw new AgentSearchConfigError(
			`Unknown agentSearch setting: ${unknown.sort()[0]}`,
		);
	}
	if (
		settings.alwaysEnabled !== undefined &&
		typeof settings.alwaysEnabled !== "boolean"
	) {
		throw new AgentSearchConfigError(
			"agentSearch.alwaysEnabled must be a boolean",
		);
	}
	const tokenName = settings.token ?? DEFAULT_TOKEN;
	if (typeof tokenName !== "string" || !TOKEN_NAME_PATTERN.test(tokenName)) {
		throw new AgentSearchConfigError(
			"agentSearch.token must be a token name",
		);
	}
	if (!cliEnabled && settings.alwaysEnabled !== true) return undefined;

	const tokensPath = join(agentDir, "tokens.json");
	assertPrivateFile(tokensPath);
	const tokens = readJsonObject(tokensPath, "central token store");
	const token = tokens[tokenName];
	if (!isRecord(token)) {
		throw new AgentSearchConfigError(
			`token ${tokenName} is not configured in the central token store`,
		);
	}
	const tokenUnknown = Object.keys(token).filter(
		(key) => !["token", "baseUrl", "allowHttp"].includes(key),
	);
	if (tokenUnknown.length > 0) {
		throw new AgentSearchConfigError(
			`Unknown token setting: ${tokenUnknown.sort()[0]}`,
		);
	}
	if (
		typeof token.token !== "string" ||
		Buffer.byteLength(token.token, "utf8") < 32
	) {
		throw new AgentSearchConfigError(`token ${tokenName} is invalid`);
	}
	if (typeof token.baseUrl !== "string") {
		throw new AgentSearchConfigError(
			`token ${tokenName} has no bridge URL`,
		);
	}
	if (token.allowHttp !== undefined && typeof token.allowHttp !== "boolean") {
		throw new AgentSearchConfigError(
			`token ${tokenName} has an invalid HTTP policy`,
		);
	}
	return {
		baseUrl: validateBaseUrl(token.baseUrl, token.allowHttp === true),
		token: token.token,
	};
}

function assertPrivateFile(path: string): void {
	let mode: number;
	try {
		const metadata = statSync(path);
		if (!metadata.isFile()) {
			throw new AgentSearchConfigError(
				"central token store must be a regular file",
			);
		}
		mode = metadata.mode;
	} catch (error) {
		if (error instanceof AgentSearchConfigError) throw error;
		const code = (error as NodeJS.ErrnoException).code;
		throw new AgentSearchConfigError(
			code === "ENOENT"
				? "central token store is missing; configure tokens.json before enabling search"
				: "central token store is unreadable",
		);
	}
	if (process.platform !== "win32" && (mode & 0o077) !== 0) {
		throw new AgentSearchConfigError(
			"central token store permissions must be 0600",
		);
	}
}

function readJsonObject(path: string, label: string): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (isRecord(parsed)) return parsed;
	} catch {
		// Report one stable error without exposing paths or file contents.
	}
	throw new AgentSearchConfigError(`could not read ${label}`);
}

function validateBaseUrl(raw: string, allowHttp: boolean): string {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new AgentSearchConfigError(
			"bridge URL must be an absolute URL",
		);
	}
	if (
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		url.pathname !== "/"
	) {
		throw new AgentSearchConfigError(
			"bridge URL must be an origin without credentials, path, query, or fragment",
		);
	}
	const loopback =
		url.hostname === "localhost" ||
		url.hostname === "127.0.0.1" ||
		url.hostname === "[::1]";
	if (
		url.protocol !== "https:" &&
		!(url.protocol === "http:" && (loopback || allowHttp))
	) {
		throw new AgentSearchConfigError(
			"bridge URL must use HTTPS unless HTTP is explicitly allowed",
		);
	}
	return url.origin;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
