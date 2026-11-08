import type { ToolEffect, ToolRisk } from "../../../shared/tool-effects.ts";

export type SafetyEffect = ToolEffect;
export type SafetyRisk = ToolRisk;

export type ShellSeparator = "&" | "&&" | "||" | "|" | ";";

export interface HeredocSpec {
	delimiter: string;
	stripTabs: boolean;
	expands: boolean;
}

export interface ShellRedirection {
	operator: string;
	target?: string;
	operation?: "read" | "write";
	heredoc?: HeredocSpec;
}

export interface ShellSegmentAnalysis {
	raw: string;
	words: string[];
	redirections: ShellRedirection[];
	program?: string;
	separatorBefore?: ShellSeparator;
	effects: SafetyEffect[];
	risk: SafetyRisk;
	reason: string;
	grantPrefix?: string[];
	grantEligible: boolean;
	parseReliable: boolean;
}

export interface ShellAnalysis {
	command: string;
	segments: ShellSegmentAnalysis[];
	effects: SafetyEffect[];
	risk: SafetyRisk;
	reason: string;
	parseReliable: boolean;
}
