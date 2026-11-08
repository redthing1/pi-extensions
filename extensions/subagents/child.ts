import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { observeActiveWorkspace } from "../shared/active-workspace.ts";
import { publishToolEffectAnalyzer } from "../shared/tool-effects.ts";

export default function registerParentMessage(pi: ExtensionAPI): void {
	observeActiveWorkspace(pi, (access) => {
		if (access.kind === "ready") access.workspace.registerCompatibleTool("parent_message");
	});
	const parameters = Type.Object(
		{
			message: Type.String({
				minLength: 1,
				maxLength: 8000,
				description: "A useful finding, question, or blocker for your parent.",
			}),
		},
		{ additionalProperties: false },
	);
	pi.registerTool(
		defineTool({
			name: "parent_message",
			label: "Parent Message",
			description: "Send a brief update to your parent without waiting for a reply. Continue your task independently.",
			parameters,
			async execute(_id, { message }) {
				if (!message.trim() || Buffer.byteLength(message) > 8000) {
					throw new Error("Use a nonempty message of at most 8000 UTF-8 bytes.");
				}
				return { content: [{ type: "text", text: "Published to parent." }], details: {} };
			},
		}),
	);
	publishToolEffectAnalyzer(pi, {
		toolName: "parent_message",
		analyze: () => ({
			toolName: "parent_message",
			effects: [],
			risk: "safe",
			reason: "Publishes an in-memory message to the parent.",
			pathInputs: [],
			known: true,
		}),
	});
}
