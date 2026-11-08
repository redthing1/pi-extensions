import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";

const DEVELOPER_DIR_LINK = "/var/select/developer_dir";
const DEVELOPER_SELECTOR_ROOT = "/var/select";
const XCODE_DEVELOPER_SUFFIX = ".app/Contents/Developer";

export function darwinDeveloperEnvironment(): string[] {
	const developerDir = selectedDeveloperDir();
	return [
		"xcrun_nocache=1",
		...(developerDir ? [`DEVELOPER_DIR=${developerDir}`] : []),
		...(process.env.SDKROOT ? [`SDKROOT=${process.env.SDKROOT}`] : []),
	];
}

export function darwinDeveloperReadRoots(): string[] {
	return [DEVELOPER_SELECTOR_ROOT, ...selectedDeveloperReadRoots()].filter((path) => existsSync(path));
}

export function darwinDeveloperCacheAccess(): { directories: string[]; fileRegexes: string[] } {
	const tempDir = userTempDir();
	const directories = tempDir ? aliasesForPath(tempDir) : [];
	return {
		directories,
		fileRegexes: directories.flatMap((path) => {
			const escaped = escapeRegex(path);
			return [`^${escaped}/xcrun_db$`, `^${escaped}/xcrun_db-[^/]+$`];
		}),
	};
}

function selectedDeveloperReadRoots(): string[] {
	const developerDir = selectedDeveloperDir();
	if (!developerDir) return [];
	return [xcodeAppRootForDeveloperDir(developerDir) ?? developerDir];
}

function selectedDeveloperDir(): string | undefined {
	if (process.env.DEVELOPER_DIR) return process.env.DEVELOPER_DIR;
	try {
		return realpathSync(DEVELOPER_DIR_LINK);
	} catch {
		return undefined;
	}
}

function xcodeAppRootForDeveloperDir(developerDir: string): string | undefined {
	const index = developerDir.indexOf(XCODE_DEVELOPER_SUFFIX);
	if (index === -1) return undefined;
	return developerDir.slice(0, index + ".app".length);
}

function userTempDir(): string | undefined {
	if (process.platform !== "darwin") return undefined;
	try {
		// xcrun uses the OS user-temp directory, independently of TMPDIR.
		const path = execFileSync("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 1000,
		}).trim();
		return path ? realpathSync(path) : undefined;
	} catch {
		return undefined;
	}
}

function aliasesForPath(path: string): string[] {
	const values = [path];
	pushAlias(values, path, /^\/private\/var(?=\/|$)/, "/var");
	pushAlias(values, path, /^\/var(?=\/|$)/, "/private/var");
	return Array.from(new Set(values));
}

function pushAlias(values: string[], path: string, pattern: RegExp, replacement: string): void {
	const alias = path.replace(pattern, replacement);
	if (alias !== path) values.push(alias);
}

function escapeRegex(value: string): string {
	return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}
