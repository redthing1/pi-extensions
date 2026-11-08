import { posix } from "node:path";
import type { WorkspaceFileOperations } from "../../../shared/active-workspace.ts";
import { parseProjectConfig } from "../config/merge.js";
import type { ProjectSafetyConfigFile } from "../config/types.js";

export interface ProvidedProjectSafetyConfig {
	path: string;
	config: ProjectSafetyConfigFile;
}

export async function readProvidedProjectSafetyConfig(
	files: WorkspaceFileOperations,
	cwd: string,
	workspaceRoot: string,
): Promise<ProvidedProjectSafetyConfig | undefined> {
	let current = posix.normalize(cwd);
	const root = posix.normalize(workspaceRoot);
	const boundary = within(current, root) ? root : posix.parse(current).root;
	for (;;) {
		const configPath = posix.join(current, ".pi", "safety.json");
		if (await files.exists(configPath)) {
			let value: unknown;
			try {
				value = JSON.parse(
					(await files.read(configPath)).toString("utf-8"),
				) as unknown;
			} catch (error) {
				throw new Error(
					`cannot read provided project Safety config ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			const parsed = parseProjectConfig(value, configPath);
			if (!parsed.value || parsed.warnings.length > 0) {
				throw new Error(
					parsed.warnings.join("; ") ||
						`invalid provided project Safety config ${configPath}`,
				);
			}
			return { path: configPath, config: parsed.value };
		}
		if (current === boundary) return undefined;
		const parent = posix.dirname(current);
		if (parent === current || !within(parent, boundary)) return undefined;
		current = parent;
	}
}

function within(path: string, root: string): boolean {
	const prefix = root.endsWith("/") ? root : `${root}/`;
	return path === root || path.startsWith(prefix);
}
