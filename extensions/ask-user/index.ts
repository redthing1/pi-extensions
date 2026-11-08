import { Type } from "typebox";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { observeActiveWorkspace } from "../shared/active-workspace.ts";
import { publishToolEffectAnalyzer } from "../shared/tool-effects.ts";
import { displayText, QuestionForm, type FormResult } from "./form.ts";

const nonempty = () => Type.String({ minLength: 1, pattern: "\\S" });
const parameters = Type.Object({
	questions: Type.Array(
		Type.Object({
			label: Type.Optional(
				Type.String({
					minLength: 1,
					maxLength: 24,
					pattern: "\\S",
					description: "Short tab label, e.g. Scope or Rollout",
				}),
			),
			question: nonempty(),
			options: Type.Optional(
				Type.Array(
					Type.Object({
						label: nonempty(),
						description: Type.Optional(nonempty()),
					}),
					{ minItems: 1, maxItems: 8 },
				),
			),
		}),
		{ minItems: 1, maxItems: 6 },
	),
});

type Details = FormResult | { status: "unavailable" };

export default function askUser(pi: ExtensionAPI): void {
	let cancel: (() => void) | undefined;
	observeActiveWorkspace(pi, (access) => {
		if (access.kind === "ready")
			access.workspace.registerCompatibleTool("ask_user");
	});
	publishToolEffectAnalyzer(pi, {
		toolName: "ask_user",
		analyze: () => ({
			toolName: "ask_user",
			effects: [],
			risk: "safe",
			pathInputs: [],
			known: true,
			reason: "Collecting user input does not access the workspace",
		}),
	});
	pi.on("session_shutdown", () => cancel?.());
	pi.registerTool(
		defineTool<typeof parameters, Details>({
			name: "ask_user",
			label: "Ask user",
			description:
				"Ask the user one or more questions and wait for their answers. Offer choices when useful; the user can always write their own answer.",
			parameters,
			executionMode: "sequential",
			async execute(_id, params, signal, _update, ctx) {
				if (ctx.mode !== "tui" || !ctx.hasUI || cancel)
					return {
						content: [
							{
								type: "text",
								text: cancel
									? "A question form is already open."
									: "User input requires an interactive TUI.",
							},
						],
						details: { status: "unavailable" },
						isError: true,
					};
				const cancelled = () => ({
					content: [
						{
							type: "text" as const,
							text: "The question form was cancelled. No answers were submitted.",
						},
					],
					details: { status: "cancelled" as const },
				});
				if (signal?.aborted) return cancelled();
				const abort = () => cancel?.();
				try {
					const result = await ctx.ui.custom<FormResult>(
						(tui, theme, keys, done) => {
							const form = new QuestionForm(
								tui,
								theme,
								keys,
								params.questions,
								done,
							);
							cancel = () => form.cancel();
							signal?.addEventListener("abort", abort, { once: true });
							if (signal?.aborted) form.cancel();
							return form;
						},
					);
					if (result.status === "cancelled") return cancelled();
					if (result.status === "discuss")
						return {
							content: [
								{
									type: "text",
									text: `The user chose to discuss this question before answering: ${JSON.stringify(result.question)}. No answers were submitted.`,
								},
							],
							details: result,
						};
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify({ answers: result.answers }),
							},
						],
						details: result,
					};
				} finally {
					signal?.removeEventListener("abort", abort);
					cancel = undefined;
				}
			},
			renderCall(args, theme) {
				const count = args.questions?.length ?? 0;
				return new Text(
					theme.fg("toolTitle", theme.bold("Ask user")) +
						theme.fg("muted", ` · ${count} question${count === 1 ? "" : "s"}`),
					0,
					0,
				);
			},
			renderResult(result, { expanded }, theme) {
				const details = result.details;
				if (details?.status === "discuss")
					return new Text(
						theme.fg("accent", "Discuss · ") + displayText(details.question),
						0,
						0,
					);
				if (details?.status === "answered") {
					const lines = details.answers.map(
						({ question, answer }, i) =>
							(expanded
								? `${theme.fg("muted", displayText(question))}\n`
								: "") +
							theme.fg("success", "✓ ") +
							(details.answers.length > 1 ? `${i + 1}. ` : "") +
							displayText(answer),
					);
					return new Text(lines.join(expanded ? "\n\n" : "\n"), 0, 0);
				}
				return new Text(
					theme.fg(
						"muted",
						details?.status === "cancelled"
							? "Cancelled · no answers submitted"
							: "User input unavailable",
					),
					0,
					0,
				);
			},
		}),
	);
}
