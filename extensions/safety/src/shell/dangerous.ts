import { isShellOption, isShortOption } from "./args.js";
import {
	isCatastrophicDeviceTarget,
	isCatastrophicPathTarget,
	isUnresolvedPathTarget,
	type PathContext,
	resolvePathTarget,
} from "./catastrophic-targets.js";
import { parseFindInvocation } from "./find.js";
import { gitDangerousReason } from "./git.js";
import { baseProgram, normalizeInvocation } from "./invocation.js";
import { literalNestedShellCommands } from "./nested-shell.js";
import { packageManagerDangerousReason } from "./package-managers.js";
import { rsyncDeletes, rsyncDestination } from "./rsync.js";
import type { SafetyEffect } from "./types.js";

interface ParsedRmOptions {
	hasRecursive: boolean;
	hasForce: boolean;
	targets: string[];
}

export interface DangerousCommandAnalysis {
	reason: string;
	effects: SafetyEffect[];
}

export interface CatastrophicCommandOptions extends PathContext {
	protectedPaths?: readonly string[];
}

const MAX_NESTED_SHELL_DEPTH = 4;
const DESTRUCTIVE_STORAGE_PROGRAMS = new Set(["lvremove", "pvremove", "vgremove"]);
const DESTRUCTIVE_STORAGE_SUBCOMMANDS = new Map<string, ReadonlySet<string>>([
	["cryptsetup", new Set(["erase", "lukserase", "luksformat"])],
	["nvme", new Set(["format", "sanitize"])],
	["zfs", new Set(["destroy"])],
	["zpool", new Set(["destroy", "labelclear"])],
]);

export function catastrophicReason(
	program: string,
	args: string[],
	options: CatastrophicCommandOptions = {},
	depth = 0,
): string | undefined {
	const invocation = normalizeInvocation(program, args);
	if (invocation.depthExceeded) return "command wrapper depth exceeds catastrophic safety limit";
	for (const directory of invocation.directories) {
		const cwd = resolvePathTarget(directory, options);
		if (cwd) options = { ...options, cwd };
	}
	const isCatastrophicPath = (target: string): boolean =>
		isCatastrophicPathTarget(target, options.protectedPaths, options);

	const nested = nestedShellCatastrophicReason(invocation.program, invocation.args, options, depth);
	if (nested) return nested;
	if (invocation.program === "rm") {
		const rm = parseRmOptions(invocation.args);
		if (rm.hasRecursive && rm.targets.some(isCatastrophicPath)) {
			return "catastrophic recursive deletion target";
		}
		if (rm.hasRecursive && rm.targets.some(isUnresolvedPathTarget)) {
			return "recursive deletion target cannot be resolved safely";
		}
	}
	if (isWindowsRecursiveDelete(invocation.program, invocation.args)) {
		const targets = windowsDeleteTargets(invocation.program, invocation.args);
		if (targets.some(isCatastrophicPath)) return "catastrophic recursive deletion target";
		if (targets.some(isUnresolvedPathTarget)) return "recursive deletion target cannot be resolved safely";
	}
	if (isDiskWipeProgram(invocation.program) && invocation.args.length > 0) {
		return "disk formatting or wiping command";
	}
	if (isDestructiveStorageCommand(invocation.program, invocation.args)) {
		return "storage destruction command";
	}
	if (isRecursiveOwnershipOrModeChange(invocation.program, invocation.args) && invocation.args.some(isCatastrophicPath)) {
		return "recursive permission or ownership change over broad path";
	}
	if (
		isRecursiveOwnershipOrModeChange(invocation.program, invocation.args) &&
		invocation.args.some(isUnresolvedPathTarget)
	) {
		return "recursive permission or ownership target cannot be resolved safely";
	}
	if (invocation.program === "dd" && ddOutputTargets(invocation.args).some(isCatastrophicDeviceTarget)) {
		return "raw disk overwrite";
	}
	if (writesRawDevice(invocation.program, invocation.args)) return "raw disk overwrite";
	if (invocation.program === "diskutil" && diskutilIsCatastrophic(invocation.args)) {
		return "disk erase or partition command";
	}
	if (isWindowsDiskDestructionProgram(invocation.program) && invocation.args.length > 0) {
		return "Windows disk formatting or partition command";
	}
	if (
		(invocation.program === "fdisk" || invocation.program === "parted") &&
		invocation.args.some(isCatastrophicDeviceTarget)
	) {
		return "disk partitioning command";
	}
	if (invocation.program === "shred" && invocation.args.some(isCatastrophicDeviceTarget)) {
		return "raw disk overwrite";
	}
	if (invocation.program === "find" && findDeletesBroadTarget(invocation.args, options)) {
		return "recursive deletion over broad find target";
	}
	if (
		invocation.program === "rsync" &&
		rsyncDeletes(invocation.args) &&
		isCatastrophicRsyncDelete(invocation.args, options)
	) {
		return "rsync delete over broad destination";
	}
	return undefined;
}

export function dangerousCommandAnalysis(program: string, args: string[], depth = 0): DangerousCommandAnalysis | undefined {
	const invocation = normalizeInvocation(program, args);

	const nested = nestedShellDangerousAnalysis(invocation.program, invocation.args, depth);
	if (nested) return nested;
	if (program === "sudo" || program === "doas" || program === "pkexec") return writeDanger("privilege escalation");
	if (invocation.program === "rm" && hasRecursiveForce(invocation.args)) return writeDanger("recursive deletion");
	if (
		invocation.program === "chmod" &&
		hasRecursiveOption(invocation.args) &&
		invocation.args.some((arg) => arg === "777" || arg === "0777")
	) {
		return writeDanger("recursive world-writable chmod");
	}
	if ((invocation.program === "chown" || invocation.program === "chgrp") && hasRecursiveOption(invocation.args)) {
		return writeDanger("recursive ownership change");
	}
	if (invocation.program === "dd" && invocation.args.some((arg) => arg.startsWith("of="))) {
		return writeDanger("raw disk or file overwrite");
	}
	if (invocation.program === "fdisk" || invocation.program === "parted" || invocation.program === "diskutil") {
		return writeDanger("disk partitioning command");
	}
	if (invocation.program === "git") {
		const reason = gitDangerousReason(invocation.args);
		return reason ? writeDanger(reason) : undefined;
	}
	if (invocation.program === "rsync" && rsyncDeletes(invocation.args)) return writeDanger("rsync delete synchronization");
	const packageReason = packageManagerDangerousReason(invocation.program, invocation.args);
	if (packageReason) return arbitraryCodeDanger(packageReason);
	return undefined;
}

function writeDanger(reason: string): DangerousCommandAnalysis {
	return { reason, effects: ["run_command", "write_files"] };
}

function arbitraryCodeDanger(reason: string): DangerousCommandAnalysis {
	return { reason, effects: ["run_command", "network", "external_state", "write_files"] };
}

function isRecursiveOwnershipOrModeChange(program: string, args: string[]): boolean {
	return (program === "chmod" || program === "chown" || program === "chgrp") && hasRecursiveOption(args);
}

function nestedShellCatastrophicReason(
	program: string,
	args: string[],
	options: CatastrophicCommandOptions,
	depth: number,
): string | undefined {
	const nested = literalNestedShellCommands(program, args);
	if (!nested) return undefined;
	if (depth >= MAX_NESTED_SHELL_DEPTH) return "nested shell depth exceeds catastrophic safety limit";
	for (const words of nested.commands) {
		const reason = catastrophicReason(baseProgram(words[0]!), words.slice(1), options, depth + 1);
		if (reason) return `${nested.program} literal command: ${reason}`;
	}
	return undefined;
}

function nestedShellDangerousAnalysis(program: string, args: string[], depth: number): DangerousCommandAnalysis | undefined {
	if (depth >= MAX_NESTED_SHELL_DEPTH) return undefined;
	const nested = literalNestedShellCommands(program, args);
	if (!nested) return undefined;
	for (const words of nested.commands) {
		const analysis = dangerousCommandAnalysis(baseProgram(words[0]!), words.slice(1), depth + 1);
		if (analysis) return { reason: `${nested.program} literal command: ${analysis.reason}`, effects: analysis.effects };
	}
	return undefined;
}

function hasRecursiveForce(args: string[]): boolean {
	const parsed = parseRmOptions(args);
	return parsed.hasRecursive && parsed.hasForce;
}

function hasRecursiveOption(args: string[]): boolean {
	return args.some((arg) => isShortOption(arg, "r") || isShortOption(arg, "R") || arg === "--recursive");
}

function parseRmOptions(args: string[]): ParsedRmOptions {
	let hasRecursive = false;
	let hasForce = false;
	const targets: string[] = [];
	let optionsDone = false;

	for (const arg of args) {
		if (!optionsDone && arg === "--") {
			optionsDone = true;
			continue;
		}
		if (!optionsDone && isShellOption(arg)) {
			hasRecursive ||= isShortOption(arg, "r") || isShortOption(arg, "R") || arg === "--recursive";
			hasForce ||= isShortOption(arg, "f") || arg === "--force";
			continue;
		}
		targets.push(arg);
	}

	return { hasRecursive, hasForce, targets };
}

function ddOutputTargets(args: string[]): string[] {
	return args.filter((arg) => arg.startsWith("of=")).map((arg) => arg.slice("of=".length));
}

function isDiskWipeProgram(program: string): boolean {
	return program === "mkfs" || program.startsWith("mkfs.") || program === "wipefs" || program === "blkdiscard";
}

function isDestructiveStorageCommand(program: string, args: string[]): boolean {
	if (DESTRUCTIVE_STORAGE_PROGRAMS.has(program)) return args.length > 0;
	const subcommands = DESTRUCTIVE_STORAGE_SUBCOMMANDS.get(program);
	if (subcommands?.has(firstNonOption(args)?.toLowerCase() ?? "")) return true;
	if (program === "mdadm") return args.some((arg) => arg === "--zero-superblock" || arg.startsWith("--zero-superblock="));
	if (program === "sgdisk") return args.some((arg) => arg === "--zap-all" || arg.startsWith("--zap-all="));
	return false;
}

function writesRawDevice(program: string, args: string[]): boolean {
	const operands = args.filter((arg) => !isShellOption(arg));
	if (program === "cp") return Boolean(operands.at(-1) && isCatastrophicDeviceTarget(operands.at(-1)!));
	return (program === "tee" || program === "truncate") && operands.some(isCatastrophicDeviceTarget);
}

function isWindowsDiskDestructionProgram(program: string): boolean {
	return (
		program === "clear-disk" ||
		program === "diskpart" ||
		program === "format" ||
		program === "format-volume" ||
		program === "remove-partition"
	);
}

function isWindowsRecursiveDelete(program: string, args: string[]): boolean {
	if (["del", "erase", "rd", "ri", "rmdir", "rm", "remove-item"].includes(program)) {
		if (args.some((arg) => arg.toLowerCase() === "-recurse")) return true;
	}
	return (
		(program === "del" || program === "rd" || program === "rmdir") &&
		args.some((arg) => arg.toLowerCase() === "/s")
	);
}

function windowsDeleteTargets(program: string, args: string[]): string[] {
	const targets: string[] = [];
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		const lower = arg.toLowerCase();
		if (program === "remove-item" && (lower === "-path" || lower === "-literalpath")) {
			const target = args[index + 1];
			if (target) targets.push(target);
			index++;
			continue;
		}
		if (lower.startsWith("-")) continue;
		if (program !== "remove-item" && (lower === "/s" || lower === "/q")) continue;
		targets.push(arg);
	}
	return targets;
}

function diskutilIsCatastrophic(args: string[]): boolean {
	const command = firstNonOption(args);
	if (!command) return false;
	const destructive = new Set([
		"eraseDisk",
		"eraseVolume",
		"partitionDisk",
		"randomDisk",
		"reformat",
		"secureErase",
		"zeroDisk",
	]);
	if (destructive.has(command)) return true;
	if (command !== "apfs") return false;

	const apfsCommand = args.slice(args.indexOf(command) + 1).find((arg) => !arg.startsWith("-"));
	return (
		apfsCommand === "deleteContainer" ||
		apfsCommand === "deleteVolume" ||
		apfsCommand === "deleteVolumeGroup" ||
		apfsCommand === "eraseVolume"
	);
}

function findDeletesBroadTarget(args: string[], options: CatastrophicCommandOptions): boolean {
	const { roots } = parseFindInvocation(args);
	const deletes = args.some((arg, index) =>
		arg === "-delete" ||
		(["-exec", "-execdir", "-ok", "-okdir"].includes(arg) && baseProgram(args[index + 1] ?? "") === "rm"),
	);
	return (
		deletes &&
		roots.some(
			(target) => isCatastrophicPathTarget(target, options.protectedPaths, options) || isUnresolvedPathTarget(target),
		)
	);
}

function isCatastrophicRsyncDelete(args: string[], options: CatastrophicCommandOptions): boolean {
	const destination = rsyncDestination(args);
	return Boolean(
		destination &&
			(isCatastrophicPathTarget(destination, options.protectedPaths, options) || isUnresolvedPathTarget(destination)),
	);
}

function firstNonOption(args: string[]): string | undefined {
	return args.find((arg) => !isShellOption(arg));
}
