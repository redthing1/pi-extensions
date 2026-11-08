import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";

const root = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const agentDir = process.env.PI_CODING_AGENT_DIR!;
async function entries(extensions?: string[]) {
	const settingsManager = SettingsManager.inMemory({ packages: [{ source: root, ...(extensions ? { extensions } : {}) }] });
	const manager = new DefaultPackageManager({ cwd: process.cwd(), agentDir, settingsManager });
	const resources = await manager.resolve();
	return resources.extensions.filter((entry) => entry.enabled).map((entry) => entry.path).sort();
}
assert.deepEqual(await entries(), manifest.pi.extensions.map((entry: string) => resolve(root, entry)).sort());
const selection = ["extensions/goal/index.ts", "extensions/subagents/index.ts"];
assert.deepEqual(await entries(selection), selection.map((entry) => resolve(root, entry)).sort());
console.log("package discovery and selection: ok");
