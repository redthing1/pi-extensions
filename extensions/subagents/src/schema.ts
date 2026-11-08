import { Type } from "typebox";

const TaskSchema = Type.Object(
	{
		label: Type.Optional(Type.String({ minLength: 1, maxLength: 120, description: "Short label for this child." })),
		task: Type.String({ minLength: 1, description: "Self-contained instructions for this child." }),
		cwd: Type.Optional(
			Type.String({ description: "Override inherited cwd; relative paths resolve from the parent cwd." }),
		),
		model: Type.Optional(Type.String({ description: "Override the inherited model within the same provider." })),
		tools: Type.Array(Type.String({ minLength: 1 }), {
			description:
				"Exact tools: native read, bash, edit, write, grep, find, ls or contributed tools. [] grants none; parent_message enables live updates to you.",
		}),
	},
	{ additionalProperties: false },
);

export const StartSchema = Type.Object(
	{
		tasks: Type.Array(TaskSchema, {
			minItems: 1,
			description: "Independent tasks, one child per entry.",
		}),
		background: Type.Boolean({ description: "true returns immediately; false waits for results." }),
	},
	{ additionalProperties: false },
);

export const RunIdsSchema = Type.Object(
	{
		ids: Type.Array(Type.String({ minLength: 1 }), {
			minItems: 1,
			description: "Child IDs returned by subagent.",
		}),
	},
	{ additionalProperties: false },
);

export const ListSchema = Type.Object(
	{
		ids: Type.Optional(RunIdsSchema.properties.ids),
		includeCollected: Type.Optional(Type.Boolean({ description: "Include previously collected children." })),
		after: Type.Optional(Type.String({ description: "Continue after the child ID returned by a previous list page." })),
		messageOffset: Type.Optional(
			Type.Integer({ minimum: 0, description: "Message index returned by inspection; use with one child ID." }),
		),
	},
	{ additionalProperties: false },
);

export const SendSchema = Type.Object(
	{
		id: Type.String({ minLength: 1, description: "One live child ID." }),
		message: Type.String({
			minLength: 1,
			maxLength: 8000,
			description: "Context, correction, or question; queued without waiting for a reply.",
		}),
	},
	{ additionalProperties: false },
);

export const WaitSchema = Type.Object(
	{
		...RunIdsSchema.properties,
		timeoutSeconds: Type.Optional(
			// Exact null prevents argument coercion from turning 0 or false into an unbounded wait.
			Type.Union([Type.Integer({ minimum: 1 }), Type.Unsafe<null>({ const: null })], {
				description:
					"Wait up to this many seconds (default 30); null waits without a time limit. Children keep running on timeout.",
			}),
		),
		offset: Type.Optional(
			Type.Integer({
				minimum: 0,
				description: "Result byte offset returned by a previous page. Reuse the same IDs.",
			}),
		),
	},
	{ additionalProperties: false },
);
