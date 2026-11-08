import { homedir } from "node:os";
import { posix, win32 } from "node:path";

const BROAD_ABSOLUTE_ROOTS = [
	"/Applications",
	"/Library",
	"/System",
	"/Users",
	"/bin",
	"/boot",
	"/etc",
	"/home",
	"/opt",
	"/private",
	"/root",
	"/sbin",
	"/usr",
	"/var",
];

const CURRENT_DIRECTORY_TARGETS = new Set([".", "..", "*", ".*"]);
const WINDOWS_BROAD_ROOT_NAMES = new Set(["program files", "programdata", "users", "windows"]);

export interface PathContext {
	cwd?: string;
	home?: string;
	pathStyle?: "posix" | "win32";
}

export function resolvePathTarget(value: string, context: PathContext): string | undefined {
	if (!context.cwd || isUnresolvedPathTarget(value)) return undefined;
	const paths = context.pathStyle === "win32" ? win32 : posix;
	let target = normalizePathTarget(value, context.home);
	if (/^[A-Za-z]:$/u.test(target)) target += "/";
	return paths.resolve(context.cwd, target);
}

export function isCatastrophicPathTarget(
	value: string,
	protectedPaths: readonly string[] = [],
	context: PathContext = {},
): boolean {
	let target = normalizePathTarget(value, context.home);
	if (target === "/") return true;
	if (CURRENT_DIRECTORY_TARGETS.has(target)) return true;
	if (/^\.\.(?:[/\\]\.\.)*$/u.test(target)) return true;
	if (isWindowsDriveRoot(target) || isUncShareRoot(target)) return true;
	if (isWindowsBroadRoot(target) || isMountedWindowsBroadRoot(target)) return true;
	const resolved = resolvePathTarget(target, context);
	if (resolved) target = normalizePathTarget(resolved, context.home);
	if ([context.home ?? homedir(), ...protectedPaths].some((path) => containsProtectedPath(target, path))) return true;
	return catastrophicAbsoluteRoots(context.home ?? homedir()).has(pathKey(target));
}

export function isCatastrophicDeviceTarget(value: string): boolean {
	const target = normalizePathTarget(value);
	const lower = target.toLowerCase();
	return (
		target === "/dev" ||
		/^\/dev\/r?disk\d+(s\d+)?$/.test(target) ||
		/^\/dev\/sd[a-z]\d*$/.test(target) ||
		/^\/dev\/nvme\d+n\d+(p\d+)?$/.test(target) ||
		target.startsWith("/dev/mapper/") ||
		isWindowsDriveRoot(target) ||
		/^\/\/\.\/physicaldrive\d+$/u.test(lower) ||
		/^\/\/\.\/[a-z]:$/u.test(lower) ||
		/^\/\/\?\/volume\{[^}]+\}$/u.test(lower)
	);
}

export function isUnresolvedPathTarget(value: string): boolean {
	const target = value.trim();
	if (/^~[^/\\]/u.test(target)) return true;
	if (target.includes("`")) return true;
	if (/\$\(/u.test(target)) return true;
	if (/%(?!USERPROFILE%)[A-Za-z_][A-Za-z0-9_]*%/iu.test(target)) return true;
	return /\$(?!HOME(?:[/\\]|$)|\{HOME\}(?:[/\\]|$)|USERPROFILE(?:[/\\]|$)|\{USERPROFILE\}(?:[/\\]|$))/u.test(
		target,
	);
}

export function normalizePathTarget(value: string, home = homedir()): string {
	let target = stripBroadGlob(value.trim());
	if (target.length === 0) return target;
	target = expandHomeToken(target, home);

	if (target === "*" || target === ".*") return target;
	if (looksLikeWindowsPath(target)) return normalizeWindowsPath(target);
	target = stripTrailingSlashes(target);
	if (target.startsWith("/")) return stripTrailingSlashes(posix.normalize(target));

	const normalized = posix.normalize(target);
	return normalized === "" ? "." : normalized;
}

function catastrophicAbsoluteRoots(home: string): Set<string> {
	return new Set([...BROAD_ABSOLUTE_ROOTS, home].map((path) => pathKey(normalizeLiteralPath(path))));
}

function stripBroadGlob(value: string): string {
	for (const suffix of ["/**", "/*", "/.*", "/.", "\\**", "\\*", "\\.*", "\\."]) {
		if (value.endsWith(suffix)) return value.slice(0, -suffix.length) || "/";
	}
	return value;
}

function expandHomeToken(value: string, home: string): string {
	for (const token of ["~", "$HOME", "${HOME}", "$USERPROFILE", "${USERPROFILE}"]) {
		if (value === token) return home;
		if (value.startsWith(`${token}/`) || value.startsWith(`${token}\\`)) {
			return `${home}${value.slice(token.length)}`;
		}
	}
	const upper = value.toUpperCase();
	const userProfile = "%USERPROFILE%";
	if (upper === userProfile) return home;
	if (upper.startsWith(`${userProfile}/`) || upper.startsWith(`${userProfile}\\`)) {
		return `${home}${value.slice(userProfile.length)}`;
	}
	return value;
}

function normalizeLiteralPath(value: string): string {
	return looksLikeWindowsPath(value) ? normalizeWindowsPath(value) : stripTrailingSlashes(posix.normalize(value));
}

function normalizeWindowsPath(value: string): string {
	return stripTrailingSlashes(win32.normalize(value.replace(/\//gu, "\\")).replace(/\\/gu, "/"));
}

function looksLikeWindowsPath(value: string): boolean {
	return /^[A-Za-z]:[/\\]?/u.test(value) || value.startsWith("\\\\") || value.startsWith("//");
}

function pathKey(value: string): string {
	return looksLikeWindowsPath(value) ? value.toLowerCase() : value;
}

function containsProtectedPath(target: string, protectedPath: string): boolean {
	if (!target.startsWith("/") && !looksLikeWindowsPath(target)) return false;
	const targetKey = pathKey(target);
	const protectedKey = pathKey(normalizeLiteralPath(protectedPath));
	return protectedKey === targetKey || protectedKey.startsWith(`${targetKey}/`);
}

function isWindowsDriveRoot(value: string): boolean {
	return /^[A-Za-z]:\/?$/u.test(value);
}

function isUncShareRoot(value: string): boolean {
	return /^\/\/[^/]+\/[^/]+\/?$/u.test(value);
}

function isWindowsBroadRoot(value: string): boolean {
	const match = /^([A-Za-z]):\/([^/]+)\/?$/u.exec(value);
	return Boolean(match?.[2] && WINDOWS_BROAD_ROOT_NAMES.has(match[2].toLowerCase()));
}

function isMountedWindowsBroadRoot(value: string): boolean {
	const match = /^\/(?:mnt\/)?[A-Za-z](?:\/([^/]+))?\/?$/u.exec(value);
	return Boolean(match && (!match[1] || WINDOWS_BROAD_ROOT_NAMES.has(match[1].toLowerCase())));
}

function stripTrailingSlashes(value: string): string {
	if (value === "/") return value;
	return value.replace(/\/+$/, "") || "/";
}
