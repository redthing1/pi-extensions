import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { goalSummary, parseTokenBudget } from "./format.js";
import type { GoalRuntime } from "./runtime.js";
import type { ParsedGoalCommand } from "./types.js";
import { GoalPanel } from "./ui/panel.js";
import type { GoalDraft, GoalPanelAction, GoalPanelMode } from "./ui/panel-types.js";

export interface CommandRegistry {
	registerCommand(name: string, options: { description?: string; handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void }): void;
}

interface GoalCommandContext {
	runtime: GoalRuntime;
	ctx: ExtensionCommandContext;
}

export function registerGoalCommand(registry: CommandRegistry, runtime: GoalRuntime): void {
	registry.registerCommand("goal", {
		description: "Set, inspect, pause, resume, budget, or clear the session goal",
		handler: async (args, ctx) => {
			try {
				await handleGoalCommand(parseGoalCommand(args), { runtime, ctx });
			} catch (error) {
				ctx.ui.notify(errorMessage(error), "error");
			}
		},
	});
}

async function handleGoalCommand(command: ParsedGoalCommand, state: GoalCommandContext): Promise<void> {
	switch (command.kind) {
		case "panel":
			await openGoalPanel(state);
			return;
		case "status":
			state.ctx.ui.notify(goalSummary(state.runtime.displayGoal()), "info");
			return;
		case "pause":
			notifyMutation(state, () => state.runtime.pause(state.ctx));
			return;
		case "resume":
			notifyMutation(state, () => state.runtime.resume(state.ctx));
			return;
		case "clear":
			await clearGoal(state);
			return;
		case "budget":
			notifyMutation(state, () => state.runtime.setBudget(command.clearBudget ? undefined : command.tokenBudget, state.ctx));
			return;
		case "replace":
			notifyMutation(state, () => state.runtime.setFromUser(requiredObjective(command), command.tokenBudget, "replace", state.ctx));
			return;
		case "set":
			await setGoalFromCommand(command, state);
	}
}

function parseGoalCommand(args: string): ParsedGoalCommand {
	const trimmed = args.trim();
	if (trimmed.length === 0) return { kind: "panel" };
	const firstSpace = trimmed.search(/\s/);
	const verb = (firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace)).toLowerCase();
	const rest = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1).trim();
	switch (verb) {
		case "status": return { kind: "status" };
		case "pause": return { kind: "pause" };
		case "resume": return { kind: "resume" };
		case "clear": return { kind: "clear" };
		case "replace": {
			const parsed = parseObjectiveAndBudget(rest);
			return { kind: "replace", objective: parsed.objective, tokenBudget: parsed.tokenBudget };
		}
		case "budget": return parseBudgetCommand(rest);
		default: {
			const parsed = parseObjectiveAndBudget(trimmed);
			return { kind: "set", objective: parsed.objective, tokenBudget: parsed.tokenBudget };
		}
	}
}

function parseBudgetCommand(rest: string): ParsedGoalCommand {
	const value = rest.trim();
	if (value.length === 0) throw new Error("Usage: /goal budget <tokens|clear>");
	if (["clear", "none", "off"].includes(value.toLowerCase())) return { kind: "budget", clearBudget: true };
	return { kind: "budget", tokenBudget: parseTokenBudget(value) };
}

function parseObjectiveAndBudget(input: string): { objective: string; tokenBudget?: number } {
	let objective = input.trim();
	const match = /(?:^|\s)--budget(?:=|\s+)([^\s]+)/.exec(objective);
	if (!match?.[1]) return { objective };
	const tokenBudget = parseTokenBudget(match[1]);
	objective = `${objective.slice(0, match.index)} ${objective.slice(match.index + match[0].length)}`.trim();
	if (objective.length === 0) throw new Error("Usage: /goal <objective> [--budget <tokens>]");
	return { objective, tokenBudget };
}

async function setGoalFromCommand(command: ParsedGoalCommand, state: GoalCommandContext): Promise<void> {
	if (state.runtime.goal()) {
		if (!state.ctx.hasUI) {
			state.ctx.ui.notify("A goal is already set. Use /goal replace <objective> to replace it.", "error");
			return;
		}
		if (!(await state.ctx.ui.confirm("Replace goal?", "Set the new objective and reset goal usage?"))) return;
	}
	notifyMutation(state, () => state.runtime.setFromUser(requiredObjective(command), command.tokenBudget, state.runtime.goal() ? "replace" : "create", state.ctx));
}

async function clearGoal(state: GoalCommandContext): Promise<void> {
	if (state.ctx.hasUI && state.runtime.goal()) {
		if (!(await state.ctx.ui.confirm("Clear goal?", "Remove the current goal from this session?"))) return;
	}
	notifyMutation(state, () => state.runtime.clear(state.ctx));
}

async function openGoalPanel(state: GoalCommandContext): Promise<void> {
	if (!state.ctx.hasUI) {
		state.ctx.ui.notify(goalSummary(state.runtime.displayGoal()), "info");
		return;
	}
	if (!state.runtime.goal()) {
		await openSetupPanel(state, { title: "New Goal", submitLabel: "Start", draft: { objective: "" }, replace: false });
		return;
	}
	const action = await state.ctx.ui.custom<GoalPanelAction>((tui, theme, keybindings, done) => new GoalPanel(
		tui,
		theme,
		keybindings,
		() => ({ mode: { type: "goal" }, goal: state.runtime.displayGoal(), loop: state.runtime.loopStatus() }),
		{ onAction: (panelAction) => done(panelAction), onBudgetChange: (budget) => notifyMutation(state, () => state.runtime.setBudget(budget, state.ctx)), onDraftChange: () => {} },
	));
	await handlePanelAction(action, state);
}

async function handlePanelAction(action: GoalPanelAction, state: GoalCommandContext): Promise<void> {
	switch (action.type) {
		case "close": return;
		case "new": await openSetupPanel(state, { title: "New Goal", submitLabel: "Start", draft: { objective: "" }, replace: false }); return;
		case "replace": await openSetupPanel(state, { title: "Replace Goal", submitLabel: "Replace", draft: draftFromCurrentGoal(state), replace: true }); return;
		case "pause": notifyMutation(state, () => state.runtime.pause(state.ctx)); return;
		case "resume": notifyMutation(state, () => state.runtime.resume(state.ctx)); return;
		case "clear-budget": notifyMutation(state, () => state.runtime.setBudget(undefined, state.ctx)); return;
		case "clear": await clearGoal(state); return;
		case "save-draft": return;
	}
}

async function openSetupPanel(state: GoalCommandContext, options: { title: string; submitLabel: string; draft: GoalDraft; replace: boolean }): Promise<void> {
	if (!options.replace && state.runtime.goal()) {
		state.ctx.ui.notify("A goal is already set. Use Replace to reset it.", "error");
		return;
	}
	let draft = { ...options.draft };
	for (;;) {
		const result = await openSetupPanelOnce(state, options, () => draft, (nextDraft) => { draft = nextDraft; });
		if (result.type !== "save-draft") return;
		const error = validateDraft(draft);
		if (error) {
			state.ctx.ui.notify(error, "error");
			continue;
		}
		notifyMutation(state, () => state.runtime.setFromUser(draft.objective, draft.tokenBudget, options.replace ? "replace" : "create", state.ctx));
		return;
	}
}

function openSetupPanelOnce(state: GoalCommandContext, options: { title: string; submitLabel: string; replace: boolean }, getDraft: () => GoalDraft, setDraft: (draft: GoalDraft) => void): Promise<GoalPanelAction> {
	return state.ctx.ui.custom<GoalPanelAction>((tui, theme, keybindings, done) => {
		const mode = (): GoalPanelMode => ({ type: "setup", title: options.title, submitLabel: options.submitLabel, draft: getDraft() });
		return new GoalPanel(
			tui,
			theme,
			keybindings,
			() => ({ mode: mode(), goal: state.runtime.displayGoal(), loop: state.runtime.loopStatus() }),
			{ onAction: (action) => done(action), onDraftChange: setDraft, onBudgetChange: () => {} },
		);
	});
}

function draftFromCurrentGoal(state: GoalCommandContext): GoalDraft {
	const goal = state.runtime.goal();
	return { objective: goal?.objective ?? "", tokenBudget: goal?.tokenBudget };
}

function validateDraft(draft: GoalDraft): string | undefined {
	const objective = draft.objective.trim();
	if (objective.length === 0) return "Goal objective must not be empty.";
	if (objective.length > 4000) return "Goal objective must be 4000 characters or fewer.";
	return undefined;
}

function notifyMutation(state: GoalCommandContext, mutate: () => { message: string }): void {
	const result = mutate();
	state.ctx.ui.notify(result.message, "info");
}

function requiredObjective(command: ParsedGoalCommand): string {
	if (!command.objective) throw new Error("Goal objective is required.");
	return command.objective;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
