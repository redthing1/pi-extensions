import { afterEach, expect, test, vi } from "vitest";
import { loadWorkspaceResources, type WorkspaceResources } from "../controller.ts";

afterEach(() => vi.useRealTimers());

test("startup resources preserve all discovered documents", async () => {
	vi.useFakeTimers();
	const resources: WorkspaceResources = {
		contextFiles: [{ path: "/workspace/AGENTS.md", content: "Project instructions" }],
		skillDocuments: [{ path: "/workspace/.pi/skills/example/SKILL.md", content: "Skill", scope: "project" }],
		promptDocuments: [{ path: "/workspace/.pi/prompts/example.md", content: "Prompt", scope: "project" }],
	};
	const client = {
		context: async () => resources.contextFiles,
		skills: async () => resources.skillDocuments,
		prompts: async () => resources.promptDocuments,
	};
	expect(await loadWorkspaceResources(client)).toEqual(resources);
	expect(vi.getTimerCount()).toBe(0);
});

test("a stalled resource scan rejects startup instead of leaving it pending", async () => {
	vi.useFakeTimers();
	const client = {
		context: () => new Promise<never>(() => {}),
		skills: async () => [],
		prompts: async () => [],
	};
	const rejected = expect(loadWorkspaceResources(client)).rejects.toThrow("Teleport resource discovery timed out");
	await vi.advanceTimersByTimeAsync(15_000);
	await rejected;
	expect(vi.getTimerCount()).toBe(0);
});
