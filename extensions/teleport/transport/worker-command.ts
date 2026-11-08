import { quotePosix } from "./master.ts";

export function workerCommand(workerPath: string, nonce: string, cwd: string, cleanupDirectory: string): string {
	const args = [workerPath, nonce, cwd, cleanupDirectory].map(quotePosix).join(" ");
	const shell = '"${SHELL:-/bin/sh}"';
	const launch = `if command -v node >/dev/null 2>&1; then exec node ${args} <&4 >&3 3>&- 4<&-; elif command -v bun >/dev/null 2>&1; then exec bun ${args} <&4 >&3 3>&- 4<&-; fi`;
	const interactive = `cd -- "$1" || exit; ${launch}; echo 'Teleport requires Node.js or Bun on the remote PATH (including login and interactive shell startup)' >&2; exit 127`;
	const login = `cd -- "$1" || exit; ${launch}; exec ${shell} -ic ${quotePosix(interactive)} teleport "$PWD"`;
	// Startup files must not consume protocol input or write to protocol stdout.
	// Pass the SSH working directory explicitly because startup files may change it.
	return `exec 3>&1 4<&0; ${launch}; exec ${shell} -lc ${quotePosix(login)} teleport "$PWD" </dev/null >&2`;
}
