import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// Routing and authentication use the operator's SSH config. Session clients use
// only the already-authenticated socket and must never inherit that config.
export const SSH_RESTRICTIONS = [
	"RemoteCommand=none",
	"RequestTTY=no",
	"ForwardAgent=no",
	"ForwardX11=no",
	"ClearAllForwardings=yes",
	"Tunnel=no",
	"GSSAPIDelegateCredentials=no",
	"PermitLocalCommand=no",
];

const LOCAL_SSH_ENVIRONMENT = [
	"PATH",
	"HOME",
	"USER",
	"LOGNAME",
	"SHELL",
	"TMPDIR",
	"SSH_AUTH_SOCK",
	"SSH_ASKPASS",
	"SSH_ASKPASS_REQUIRE",
	"DISPLAY",
	"TERM",
];

export function sshEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = { LC_ALL: "C" };
	for (const name of LOCAL_SSH_ENVIRONMENT) {
		if (source[name] !== undefined) environment[name] = source[name];
	}
	return environment;
}

export function sshOptions(options: readonly string[]): string[] {
	return options.flatMap((option) => ["-o", option]);
}

export async function writeConnectionConfiguration(directory: string, source?: string): Promise<string> {
	const sources = source ? [source] : [join(homedir(), ".ssh", "config"), "/etc/ssh/ssh_config"];
	const quote = (path: string): string => {
		if (/[\r\n\0]/u.test(path)) throw new Error("Invalid SSH configuration path");
		return `"${path.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
	};
	// OpenSSH propagates -F to implicit ProxyJump clients. A small include wrapper
	// applies our restrictions to every hop without interpreting the user's config.
	const policy = SSH_RESTRICTIONS.map((option) => `  ${option.replace("=", " ")}`).join("\n");
	const contents = `Host *\n${policy}\n${sources.map((path) => `Include ${quote(path)}`).join("\n")}\nHost *\n  SendEnv -*\n`;
	const path = join(directory, "ssh_config");
	await writeFile(path, contents, { mode: 0o600, flag: "wx" });
	return path;
}

export function assertSafeMasterConfiguration(configuration: string): void {
	// SendEnv is additive and cannot be disabled by a command-line reset before
	// config loading. Config-free mux clients submit no environment. SetEnv also
	// runs in the master, so reject it rather than silently forwarding its values.
	if (configuration.split("\n").some((line) => /^setenv\s+\S/iu.test(line))) {
		throw new Error("Teleport does not permit SSH SetEnv; remove it from this target's SSH configuration");
	}
}
