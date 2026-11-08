import type { SafetyEffect, SafetyRisk, ShellAnalysis, ShellRedirection, ShellSegmentAnalysis } from "./types.js";
import { posix, win32 } from "node:path";
import { parseCdInvocation } from "./cd.js";
import {
	dangerousCommandAnalysis,
	catastrophicReason,
	type CatastrophicCommandOptions,
} from "./dangerous.js";
import { isCatastrophicDeviceTarget, isUnresolvedPathTarget, normalizePathTarget } from "./catastrophic-targets.js";
import { baseProgram, normalizeInvocation } from "./invocation.js";
import { tokenizeShellWords } from "./lexer.js";
import { isPackageManagerProgram } from "./package-managers.js";
import { extractCommandPathReferences } from "./path-extractors.js";
import { parseShellRedirections } from "./redirections.js";
import type { SplitSegment } from "./segments.js";
import { hasUnquotedShellFeature, splitShellSegments } from "./segments.js";
import { literalCommandSubstitutions } from "./substitutions.js";
import { isKnownReadOnlyCommand, isVersionOnlyCommand } from "./readonly.js";

const NETWORK_PROGRAMS = new Set(["curl", "wget", "ssh", "scp", "rsync"]);
const EXTERNAL_READ_PROGRAMS = new Set(["gh"]);
const SHELL_PROGRAMS = new Set(["bash", "sh", "zsh", "fish", "eval", "source"]);
const MAX_COMMAND_SUBSTITUTION_DEPTH = 4;

export function analyzeShellCommand(command: string, options: CatastrophicCommandOptions = {}): ShellAnalysis {
	return analyzeShellCommandAtDepth(command, options, 0);
}

function analyzeShellCommandAtDepth(
	command: string,
	options: CatastrophicCommandOptions,
	depth: number,
): ShellAnalysis {
	const trimmed = command.trim();
	if (trimmed.length === 0) {
		return {
			command,
			segments: [],
			effects: ["run_command"],
			risk: "safe_read",
			reason: "empty command",
			parseReliable: true,
		};
	}

	const split = splitShellSegments(trimmed);
	if (!split.reliable) return unknownAnalysis(command, split.reason ?? "could not parse shell command");

	let current = options;
	const segments: ShellSegmentAnalysis[] = [];
	for (const segment of split.segments) {
		const analysis = analyzeSegment(segment, current, depth);
		segments.push(analysis);
		const invocation = analysis.words[0] ? normalizeInvocation(analysis.words[0], analysis.words.slice(1)) : undefined;
		if (invocation?.program === "cd" && current.cwd) {
			const cd = parseCdInvocation(invocation.args);
			if (cd.supported && cd.target && !isUnresolvedPathTarget(cd.target)) {
				const paths = current.pathStyle === "win32" ? win32 : posix;
				current = { ...current, cwd: paths.resolve(current.cwd, normalizePathTarget(cd.target, current.home)) };
			}
		}
	}
	const pipedToShell = segmentsPipeToShell(segments);
	return {
		command,
		segments,
		effects: uniqueEffects([...segments.flatMap((segment) => segment.effects), ...(pipedToShell ? ["network" as const] : [])]),
		risk: highestRisk([...segments.map((segment) => segment.risk), ...(pipedToShell ? ["dangerous" as const] : [])]),
		reason: pipedToShell ? "pipe into shell" : segments.map((segment) => segment.reason).join("; "),
		parseReliable: segments.every((segment) => segment.parseReliable),
	};
}

function analyzeSegment(
	splitSegment: SplitSegment,
	options: CatastrophicCommandOptions,
	depth: number,
): ShellSegmentAnalysis {
	const redirectionParse = parseShellRedirections(splitSegment.raw);
	if (!redirectionParse.reliable) {
		return segment(splitSegment, [], "unknown", redirectionParse.reason ?? "could not parse redirection", ["run_command"], false, [], false);
	}
	if (
		redirectionParse.redirections.some(
			(redirection) =>
				redirection.operation === "write" &&
				Boolean(redirection.target && isCatastrophicDeviceTarget(redirection.target)),
		)
	) {
		return segment(
			splitSegment,
			[],
			"catastrophic",
			"raw disk output redirection",
			["run_command", "write_files"],
			false,
			redirectionParse.redirections,
			true,
		);
	}

	const substitutions = literalCommandSubstitutions(redirectionParse.command);
	if (substitutions.commands.length > 0) {
		if (depth >= MAX_COMMAND_SUBSTITUTION_DEPTH) {
			return segment(
				splitSegment,
				[],
				"catastrophic",
				"command substitution depth exceeds catastrophic safety limit",
				["run_command", "write_files"],
				false,
				redirectionParse.redirections,
				false,
			);
		}
		for (const command of substitutions.commands) {
			const nested = analyzeShellCommandAtDepth(command, options, depth + 1);
			if (nested.risk === "catastrophic") {
				return segment(
					splitSegment,
					[],
					"catastrophic",
					`literal command substitution: ${nested.reason}`,
					["run_command", "write_files"],
					false,
					redirectionParse.redirections,
					substitutions.reliable && nested.parseReliable,
				);
			}
		}
	}

	const tokenized = tokenizeShellWords(redirectionParse.command);
	if (!tokenized.reliable) {
		return segment(
			splitSegment,
			[],
			"unknown",
			tokenized.reason ?? "could not tokenize segment",
			["run_command"],
			false,
			redirectionParse.redirections,
			false,
		);
	}
	const words = stripEnvAssignments(tokenized.words);
	if (words.length > 0) {
		const catastrophic = catastrophicReason(baseProgram(words[0]), words.slice(1), options);
		if (catastrophic) {
			return segment(
				splitSegment,
				words,
				"catastrophic",
				catastrophic,
				["run_command", "write_files"],
				false,
				redirectionParse.redirections,
				true,
			);
		}
	}

	const complex = hasUnquotedShellFeature(redirectionParse.command);
	if (complex) {
		return segment(splitSegment, [], "unknown", `unsupported shell feature: ${complex}`, ["run_command"], false, redirectionParse.redirections, false);
	}
	if (redirectionParse.redirections.some((redirection) => redirection.heredoc?.expands)) {
		return segment(
			splitSegment,
			tokenized.words,
			"unknown",
			"unquoted heredoc may expand shell syntax",
			["run_command", ...redirectionEffects(redirectionParse.redirections)],
			false,
			redirectionParse.redirections,
			false,
		);
	}

	if (words.length === 0) {
		if (redirectionParse.redirections.length > 0) {
			return segmentWithRedirections(splitSegment, [], "mutating", "redirection only", ["run_command"], false, redirectionParse.redirections);
		}
		return segment(splitSegment, [], "safe_read", "environment assignment only", ["run_command"], false, redirectionParse.redirections, true);
	}

	const program = baseProgram(words[0]);
	const args = words.slice(1);
	const dangerous = dangerousCommandAnalysis(program, args);
	if (dangerous) return segmentWithRedirections(splitSegment, words, "dangerous", dangerous.reason, dangerous.effects, false, redirectionParse.redirections);

	if (SHELL_PROGRAMS.has(program)) {
		return segmentWithRedirections(splitSegment, words, "unknown", `${program} can execute arbitrary shell text`, ["run_command"], false, redirectionParse.redirections);
	}

	if (NETWORK_PROGRAMS.has(program)) {
		return segmentWithRedirections(
			splitSegment,
			words,
			"unknown",
			`${program} may use network`,
			["run_command", "network", "external_state"],
			grantEligible(program, args, redirectionParse.redirections),
			redirectionParse.redirections,
		);
	}

	if (isVersionOnlyCommand(program, args)) {
		return segmentWithRedirections(
			splitSegment,
			words,
			"safe_read",
			"version inspection",
			["run_command"],
			grantEligible(program, args, redirectionParse.redirections),
			redirectionParse.redirections,
		);
	}

	const readOnly = isKnownReadOnlyCommand(program, args);
	if (readOnly.safe) {
		return segmentWithRedirections(
			splitSegment,
			words,
			"safe_read",
			readOnly.reason,
			["run_command", "read_files"],
			grantEligible(program, args, redirectionParse.redirections),
			redirectionParse.redirections,
		);
	}

	if (EXTERNAL_READ_PROGRAMS.has(program) || isPackageManagerProgram(program)) {
		return segmentWithRedirections(
			splitSegment,
			words,
			"unknown",
			`${program} may use external state or network`,
			["run_command", "network", "external_state"],
			grantEligible(program, args, redirectionParse.redirections),
			redirectionParse.redirections,
		);
	}

	return segmentWithRedirections(
		splitSegment,
		words,
		"unknown",
		readOnly.reason,
		["run_command"],
		grantEligible(program, args, redirectionParse.redirections),
		redirectionParse.redirections,
	);
}

function segment(
	splitSegment: SplitSegment,
	words: string[],
	risk: SafetyRisk,
	reason: string,
	effects: SafetyEffect[],
	grantEligible: boolean,
	redirections: ShellRedirection[],
	parseReliable: boolean,
): ShellSegmentAnalysis {
	return {
		raw: splitSegment.raw,
		words,
		redirections,
		program: words[0] ? baseProgram(words[0]) : undefined,
		separatorBefore: splitSegment.separatorBefore,
		effects: uniqueEffects(effects),
		risk,
		reason,
		grantPrefix: grantEligible ? words.slice(0, Math.min(words.length, 3)) : undefined,
		grantEligible,
		parseReliable,
	};
}

function segmentWithRedirections(
	splitSegment: SplitSegment,
	words: string[],
	risk: SafetyRisk,
	reason: string,
	effects: SafetyEffect[],
	grantEligible: boolean,
	redirections: ShellRedirection[],
): ShellSegmentAnalysis {
	const redirectionSideEffects = redirectionEffects(redirections);
	const pathEffects = commandPathEffects(words, splitSegment.raw);
	const writesPath = redirectionSideEffects.includes("write_files") || pathEffects.includes("write_files");
	return segment(
		splitSegment,
		words,
		writesPath && (risk === "safe" || risk === "safe_read") ? "mutating" : risk,
		redirections.length > 0 ? `${reason}; ${redirectionReason(redirections)}` : reason,
		[...effects, ...pathEffects, ...redirectionSideEffects],
		grantEligible && !redirectionSideEffects.includes("write_files"),
		redirections,
		true,
	);
}

function commandPathEffects(words: string[], raw: string): SafetyEffect[] {
	const program = words[0] ? baseProgram(words[0]) : undefined;
	if (!program) return [];
	return uniqueEffects(
		extractCommandPathReferences(program, words.slice(1), raw).map((reference) =>
			reference.operation === "write" ? "write_files" : reference.operation === "list" ? "list_files" : "read_files",
		),
	);
}

function unknownAnalysis(command: string, reason: string): ShellAnalysis {
	return {
		command,
		segments: [segment({ raw: command }, [], "unknown", reason, ["run_command"], false, [], false)],
		effects: ["run_command"],
		risk: "unknown",
		reason,
		parseReliable: false,
	};
}

function stripEnvAssignments(words: string[]): string[] {
	const out = [...words];
	while (out[0] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(out[0])) out.shift();
	return out;
}

function grantEligible(program: string, args: string[], redirections: ShellRedirection[]): boolean {
	if (redirections.some((redirection) => redirection.heredoc?.expands)) return false;
	if (SHELL_PROGRAMS.has(program)) return false;
	if (program === "cd") return false;
	if (program === "sudo" || program === "doas" || program === "pkexec") return false;
	if (program === "rm" || program === "chmod" || program === "chown" || program === "mv") return false;
	if (program === "python" || program === "python3" || program === "node") return isVersionOnlyCommand(program, args);
	return true;
}

function segmentsPipeToShell(segments: ShellSegmentAnalysis[]): boolean {
	return segments.some((segment, index) => {
		const previous = segments[index - 1];
		return (
			segment.separatorBefore === "|" &&
			Boolean(previous?.program && NETWORK_PROGRAMS.has(previous.program) && segment.program && SHELL_PROGRAMS.has(segment.program))
		);
	});
}

function redirectionEffects(redirections: ShellRedirection[]): SafetyEffect[] {
	const effects: SafetyEffect[] = [];
	for (const redirection of redirections) {
		if (redirection.operation === "read") effects.push("read_files");
		if (redirection.operation === "write") effects.push("write_files");
	}
	return uniqueEffects(effects);
}

function redirectionReason(redirections: ShellRedirection[]): string {
	const writes = redirections.filter((redirection) => redirection.operation === "write").length;
	const reads = redirections.filter((redirection) => redirection.operation === "read").length;
	const heredocs = redirections.filter((redirection) => redirection.heredoc).length;
	const parts = [
		writes > 0 ? `${writes} output redirection${writes === 1 ? "" : "s"}` : undefined,
		reads > 0 ? `${reads} input redirection${reads === 1 ? "" : "s"}` : undefined,
		heredocs > 0 ? `${heredocs} heredoc${heredocs === 1 ? "" : "s"}` : undefined,
	].filter((part): part is string => Boolean(part));
	return parts.length > 0 ? parts.join(", ") : "redirection";
}

function uniqueEffects(effects: SafetyEffect[]): SafetyEffect[] {
	return Array.from(new Set(effects));
}

function highestRisk(risks: SafetyRisk[]): SafetyRisk {
	const rank: Record<SafetyRisk, number> = {
		safe: 0,
		safe_read: 1,
		mutating: 2,
		unknown: 3,
		dangerous: 4,
		catastrophic: 5,
	};
	let best: SafetyRisk = "safe";
	for (const risk of risks) {
		if (rank[risk] > rank[best]) best = risk;
	}
	return best;
}
