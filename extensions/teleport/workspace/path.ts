import { posix } from "node:path";

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/gu;

export interface WorkspaceLocation {
	cwd: string;
	home: string;
}

export function resolveWorkspacePath(input: string, location: WorkspaceLocation): string {
	if (input.startsWith("pi-output:")) throw new Error("Use read_output to retrieve a pi-output: reference");
	let path = input.replace(UNICODE_SPACES, " ");
	if (path.startsWith("@")) path = path.slice(1);
	if (path.includes("\0")) throw new Error("Invalid workspace path");
	if (path === "~") return location.home;
	if (path.startsWith("~/")) return posix.join(location.home, path.slice(2));
	return posix.isAbsolute(path) ? posix.normalize(path) : posix.resolve(location.cwd, path);
}
