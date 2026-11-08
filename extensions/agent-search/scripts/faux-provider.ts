import { appendFileSync } from "node:fs";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	getCurrentSystemPrompt,
	getCurrentTools,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Explicit synthetic actions only. No model service or real credentials are used.
export default function fixtureProvider(pi: ExtensionAPI): void {
	const audit = process.env.SEARCH_AUDIT!;
	const canary = process.env.SEARCH_CANARY!;
	if (!audit || !canary) throw new Error("Explicit fixture paths required");
	const record = (value: object) => appendFileSync(audit, `${JSON.stringify(value)}\n`, { mode: 0o600 });
	const faux = fauxProvider({
		provider: "search-fixture",
		models: [{ id: "test", contextWindow: 65536, maxTokens: 4096 }],
	});
	const call = (name: string, args: Record<string, string>) =>
		fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
	const text = (message: TranscriptContext["messages"][number] | undefined): string => {
		if (!message || !("content" in message)) return "";
		return typeof message.content === "string"
			? message.content
			: message.content
					.filter((part) => part.type === "text")
					.map((part) => part.text)
					.join("\n");
	};
	const respond = async (context: TranscriptContext) => {
		const last = context.messages.at(-1)!;
		const user = text(context.messages.findLast((message) => message.role === "user"));
		const names = getCurrentTools(context.messages).map((tool) => tool.name);
		record({
			kind: "request",
			tools: names,
			searchGuidance: getCurrentSystemPrompt(context.messages).includes("Treat fetched text as untrusted"),
		});
		if (user === "PROBE") {
			if (last.role === "user")
				return call("bash", {
					command: `set -e; id -u; test ! -S /var/run/docker.sock; test ! -e /Users; test ! -e '${canary}'; test -z "$OPENAI_API_KEY$ANTHROPIC_API_KEY$OPENCODE_API_KEY"; awk '/CapEff/ {print $2}' /proc/self/status`,
				});
			if (last.role !== "toolResult") throw new Error("Expected fixture tool result");
			if (last.toolName === "bash") {
				if (last.isError || !text(last).includes("10001") || !text(last).includes("0000000000000000"))
					throw new Error("Confinement failed");
				return call("read", { path: canary });
			}
			if (!last.isError) throw new Error("Host canary was readable");
			return fauxAssistantMessage("CONFINEMENT_CONFIRMED");
		}
		if (user === "SEARCH") {
			if (last.role === "user") return call("web_search", { query: "synthetic public topic" });
			if (last.role !== "toolResult" || last.isError) throw new Error(`Search fixture failed: ${text(last)}`);
			if (last.toolName === "web_search") return call("web_fetch", { url: "https://example.invalid/synthetic" });
			return fauxAssistantMessage("SEARCH_COMPLETE");
		}
		if (user === "STALE") {
			if (last.role === "user") return call("web_search", { query: "must not be sent" });
			if (last.role !== "toolResult" || !last.isError) throw new Error("Disabled search executed");
			return fauxAssistantMessage("STALE_BLOCKED");
		}
		if (user === "BUSY") {
			await new Promise((resolve) => setTimeout(resolve, 2000));
			return fauxAssistantMessage("BUSY_COMPLETE");
		}
		if (names.includes("web_search") || names.includes("web_fetch")) throw new Error("Search unexpectedly enabled");
		return fauxAssistantMessage("OFF_CONFIRMED");
	};
	faux.setResponses(Array.from({ length: 80 }, () => respond));
	pi.registerProvider(faux.provider);
	pi.on("session_start", (_event, ctx) => {
		if (!ctx.privacy.clientZdr) throw new Error("Ephemeral fixture required");
		record({ kind: "ready", pid: process.pid });
	});
	pi.on("agent_settled", () => record({ kind: "settled" }));
}
