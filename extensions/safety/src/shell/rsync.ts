import { isPathLikeShellArg, isShellOption, isShortOption, optionConsumesNext } from "./args.js";

const OPTIONS_WITH_VALUES = new Set([
	"--backup-dir",
	"--compare-dest",
	"--copy-dest",
	"--exclude",
	"--exclude-from",
	"--files-from",
	"--include",
	"--include-from",
	"--link-dest",
	"--log-file",
	"--out-format",
	"--partial-dir",
	"--password-file",
	"--rsync-path",
	"--suffix",
	"--temp-dir",
]);

export function rsyncLocalPathOperands(args: string[]): string[] {
	return rsyncPathOperands(args).filter((path) => !isRemoteRsyncOperand(path));
}

export function rsyncDestination(args: string[]): string | undefined {
	const operands = rsyncLocalPathOperands(args);
	return operands.length >= 2 ? operands[operands.length - 1] : undefined;
}

export function rsyncDeletes(args: string[]): boolean {
	return rsyncHasDelete(args) && !rsyncIsDryRun(args);
}

export function rsyncHasDelete(args: string[]): boolean {
	return args.some((arg) => arg === "--delete" || arg.startsWith("--delete-"));
}

function rsyncIsDryRun(args: string[]): boolean {
	return args.some((arg) => arg === "--dry-run" || isShortOption(arg, "n"));
}

function rsyncPathOperands(args: string[]): string[] {
	const operands: string[] = [];
	let optionsDone = false;
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (!optionsDone && arg === "--") {
			optionsDone = true;
			continue;
		}
		if (!optionsDone && optionConsumesNext(arg, OPTIONS_WITH_VALUES)) {
			i += 1;
			continue;
		}
		if (!optionsDone && isShellOption(arg)) continue;
		if (isPathLikeShellArg(arg)) operands.push(arg);
	}
	return operands;
}

function isRemoteRsyncOperand(path: string): boolean {
	return /^[^/][^:]*:/.test(path);
}
