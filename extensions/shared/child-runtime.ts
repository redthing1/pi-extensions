import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ToolEffect } from "./tool-effects.ts";

const POLICY_CHANNEL = "rt1.child-policy.v2";
const POLICY_QUERY_CHANNEL = "rt1.child-policy.query.v2";
const TOOL_PROVIDER_CHANNEL = "rt1.child-tool-provider.v1";
const TOOL_PROVIDER_QUERY_CHANNEL = "rt1.child-tool-provider.query.v1";
const PROVIDER_RUNTIME_CHANNEL = "rt1.child-provider-runtime.v1";
const PROVIDER_RUNTIME_QUERY_CHANNEL = "rt1.child-provider-runtime.query.v1";

export interface ChildRunIntent {
	origin:
		| { kind: "tool"; toolCallId: string }
		| { kind: "interactive" };
	runId: string;
	batchId: string;
	cwd: string;
	model: string;
	provider: string;
	tools: readonly string[];
	capabilities: readonly ToolEffect[];
	references: readonly {
		label: string;
		root: string;
		access: "read-only";
	}[];
	privacy: {
		clientZdr: boolean;
		remoteZdr: boolean;
	};
}

export interface ChildLaunchContribution {
	id: string;
	args: readonly string[];
	env?: Readonly<Record<string, string>>;
	metadata: Readonly<Record<string, unknown>>;
	dispose(): Promise<void>;
}

export interface ChildPolicyContributor {
	id: string;
	prepare(intent: ChildRunIntent): Promise<ChildLaunchContribution | undefined>;
}

export interface ChildPolicyObserver {
	prepare(intent: ChildRunIntent): Promise<ChildLaunchContribution[]>;
}

export interface ChildToolDefinition {
	name: string;
	effects: readonly ToolEffect[];
}

export interface ChildToolProvider {
	id: string;
	tools: readonly ChildToolDefinition[];
	prepare(intent: ChildRunIntent, tools: readonly string[]): Promise<ChildLaunchContribution>;
}

export interface ChildToolProviderObserver {
	definition(toolName: string): ChildToolDefinition | undefined;
	prepare(intent: ChildRunIntent, toolNames: readonly string[]): Promise<ChildLaunchContribution[]>;
}

export interface ChildProviderRuntimeContributor {
	id: string;
	providers: readonly string[];
	prepare(intent: ChildRunIntent): Promise<ChildLaunchContribution>;
}

export interface ChildProviderRuntimeObserver {
	prepare(intent: ChildRunIntent): Promise<ChildLaunchContribution[]>;
}

export interface ChildRuntimeContributors {
	policies: ChildPolicyObserver;
	tools: ChildToolProviderObserver;
	providers: ChildProviderRuntimeObserver;
}

export function observeChildRuntimeContributors(
	pi: Pick<ExtensionAPI, "events">,
): ChildRuntimeContributors {
	return {
		policies: observeChildPolicyContributors(pi),
		tools: observeChildToolProviders(pi),
		providers: observeChildProviderRuntimes(pi),
	};
}

export async function prepareChildLaunchContributions(
	integrations: ChildRuntimeContributors,
	intent: ChildRunIntent,
	extensionTools: readonly string[] = [],
): Promise<ChildLaunchContribution[]> {
	const contributions: ChildLaunchContribution[] = [];
	try {
		contributions.push(...(await integrations.policies.prepare(intent)));
		contributions.push(...(await integrations.tools.prepare(intent, extensionTools)));
		contributions.push(...(await integrations.providers.prepare(intent)));
		childLaunchEnvironment(contributions);
		return contributions;
	} catch (error) {
		try {
			await disposeChildLaunchContributions(contributions);
		} catch (cleanupError) {
			throw combinedError(
				"Child launch composition failed",
				error,
				"contribution cleanup failed",
				cleanupError,
			);
		}
		throw error;
	}
}

export function publishChildPolicyContributor(
	pi: Pick<ExtensionAPI, "events">,
	contributor: ChildPolicyContributor,
): void {
	publishReplayable(pi, POLICY_CHANNEL, POLICY_QUERY_CHANNEL, contributor);
}

export function observeChildPolicyContributors(pi: Pick<ExtensionAPI, "events">): ChildPolicyObserver {
	const registry = observeRegistry<ChildPolicyContributor>(
		pi,
		POLICY_CHANNEL,
		POLICY_QUERY_CHANNEL,
		isPolicyContributor,
	);
	return {
		async prepare(intent) {
			registry.assertValid("child policy contributor");
			return prepareContributions(registry.values(), async (contributor) => contributor.prepare(intent));
		},
	};
}

export function publishChildToolProvider(pi: Pick<ExtensionAPI, "events">, provider: ChildToolProvider): void {
	publishReplayable(pi, TOOL_PROVIDER_CHANNEL, TOOL_PROVIDER_QUERY_CHANNEL, provider);
}

export function observeChildToolProviders(pi: Pick<ExtensionAPI, "events">): ChildToolProviderObserver {
	const registry = observeRegistry<ChildToolProvider>(
		pi,
		TOOL_PROVIDER_CHANNEL,
		TOOL_PROVIDER_QUERY_CHANNEL,
		isToolProvider,
	);

	function definitions(): Map<string, { provider: ChildToolProvider; definition: ChildToolDefinition }> {
		registry.assertValid("child tool provider");
		const result = new Map<string, { provider: ChildToolProvider; definition: ChildToolDefinition }>();
		for (const provider of registry.values()) {
			const localNames = new Set<string>();
			for (const definition of provider.tools) {
				if (localNames.has(definition.name)) {
					throw new Error(`Child tool provider '${provider.id}' declares '${definition.name}' more than once.`);
				}
				localNames.add(definition.name);
				const existing = result.get(definition.name);
				if (existing) {
					throw new Error(
						`Child tool '${definition.name}' is provided by both '${existing.provider.id}' and '${provider.id}'.`,
					);
				}
				result.set(definition.name, { provider, definition });
			}
		}
		return result;
	}

	return {
		definition(toolName) {
			const found = definitions().get(toolName)?.definition;
			return found ? { name: found.name, effects: [...found.effects] } : undefined;
		},
		async prepare(intent, toolNames) {
			const available = definitions();
			const selected = new Map<string, { provider: ChildToolProvider; tools: string[] }>();
			for (const toolName of toolNames) {
				const found = available.get(toolName);
				if (!found) throw new Error(`No child tool provider is registered for '${toolName}'.`);
				const entry = selected.get(found.provider.id) ?? {
					provider: found.provider,
					tools: [],
				};
				if (!entry.tools.includes(toolName)) entry.tools.push(toolName);
				selected.set(found.provider.id, entry);
			}
			return prepareContributions(
				[...selected.values()].sort((left, right) => left.provider.id.localeCompare(right.provider.id)),
				(entry) => entry.provider.prepare(intent, entry.tools),
				(entry) => entry.provider.id,
			);
		},
	};
}

export function publishChildProviderRuntime(
	pi: Pick<ExtensionAPI, "events">,
	contributor: ChildProviderRuntimeContributor,
): void {
	publishReplayable(pi, PROVIDER_RUNTIME_CHANNEL, PROVIDER_RUNTIME_QUERY_CHANNEL, contributor);
}

export function observeChildProviderRuntimes(pi: Pick<ExtensionAPI, "events">): ChildProviderRuntimeObserver {
	const registry = observeRegistry<ChildProviderRuntimeContributor>(
		pi,
		PROVIDER_RUNTIME_CHANNEL,
		PROVIDER_RUNTIME_QUERY_CHANNEL,
		isProviderRuntime,
	);
	return {
		async prepare(intent) {
			registry.assertValid("child provider runtime");
			const matching = registry.values().filter((contributor) => contributor.providers.includes(intent.provider));
			if (matching.length > 1) {
				throw new Error(
					`Child provider '${intent.provider}' is supplied by multiple runtimes: ${matching.map((entry) => entry.id).join(", ")}.`,
				);
			}
			return prepareContributions(matching, (contributor) => contributor.prepare(intent));
		},
	};
}

export function childLaunchArgs(contributions: readonly ChildLaunchContribution[]): string[] {
	return contributions.flatMap((contribution) => contribution.args);
}

export function childLaunchEnvironment(contributions: readonly ChildLaunchContribution[]): Record<string, string> {
	validateContributionEnvironment(contributions);
	const environment = Object.create(null) as Record<string, string>;
	for (const contribution of contributions) {
		for (const [key, value] of Object.entries(contribution.env ?? {})) {
			environment[key] = value;
		}
	}
	return environment;
}

export async function disposeChildLaunchContributions(
	contributions: readonly ChildLaunchContribution[],
): Promise<void> {
	let firstError: unknown;
	for (const contribution of [...contributions].reverse()) {
		try {
			await contribution.dispose();
		} catch (error) {
			firstError ??= error;
		}
	}
	if (firstError) throw firstError;
}

function publishReplayable<T>(pi: Pick<ExtensionAPI, "events">, channel: string, queryChannel: string, value: T): void {
	pi.events.on(queryChannel, () => pi.events.emit(channel, value));
	pi.events.emit(channel, value);
}

function observeRegistry<T extends { id: string }>(
	pi: Pick<ExtensionAPI, "events">,
	channel: string,
	queryChannel: string,
	parse: (value: unknown) => value is T,
): {
	values(): T[];
	assertValid(kind: string): void;
} {
	const values = new Map<string, T>();
	const conflicts = new Set<string>();
	pi.events.on(channel, (value) => {
		if (!parse(value)) return;
		const existing = values.get(value.id);
		if (existing && existing !== value) conflicts.add(value.id);
		else values.set(value.id, value);
	});
	pi.events.emit(queryChannel, undefined);
	return {
		values: () => [...values.values()].sort((left, right) => left.id.localeCompare(right.id)),
		assertValid(kind) {
			if (conflicts.size > 0) {
				throw new Error(`Duplicate ${kind} ids: ${[...conflicts].sort().join(", ")}.`);
			}
		},
	};
}

async function prepareContributions<T>(
	items: readonly T[],
	prepare: (item: T) => Promise<ChildLaunchContribution | undefined>,
	expectedId: (item: T) => string = (item) => (item as { id: string }).id,
): Promise<ChildLaunchContribution[]> {
	const prepared: ChildLaunchContribution[] = [];
	try {
		for (const item of items) {
			const contribution = await prepare(item);
			if (!contribution) continue;
			const id = expectedId(item);
			if (!isLaunchContribution(contribution)) {
				await rejectContribution(
					contribution,
					`Child launch contributor '${id}' returned a malformed contribution.`,
				);
			}
			if (contribution.id !== id) {
				await rejectContribution(
					contribution,
					`Child launch contributor '${id}' returned mismatched id '${contribution.id}'.`,
				);
			}
			prepared.push(contribution);
		}
		validateContributionEnvironment(prepared);
		return prepared;
	} catch (error) {
		try {
			await disposeChildLaunchContributions(prepared);
		} catch (cleanupError) {
			throw combinedError(
				"Child launch preparation failed",
				error,
				"prepared contribution cleanup failed",
				cleanupError,
			);
		}
		throw error;
	}
}

async function rejectContribution(value: unknown, message: string): Promise<never> {
	const error = new Error(message);
	if (typeof value !== "object" || value === null || !("dispose" in value) || typeof value.dispose !== "function") {
		throw error;
	}
	try {
		await value.dispose();
	} catch (cleanupError) {
		throw combinedError(
			"Child launch contribution was rejected",
			error,
			"rejected contribution cleanup failed",
			cleanupError,
		);
	}
	throw error;
}

function combinedError(primaryLabel: string, primary: unknown, secondaryLabel: string, secondary: unknown): Error {
	return new Error(`${primaryLabel}: ${errorText(primary)}\n${secondaryLabel}: ${errorText(secondary)}`);
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function validateContributionEnvironment(contributions: readonly ChildLaunchContribution[]): void {
	const owners = new Map<string, string>();
	const ids = new Set<string>();
	for (const contribution of contributions) {
		if (ids.has(contribution.id)) {
			throw new Error(`Duplicate child launch contribution id '${contribution.id}'.`);
		}
		ids.add(contribution.id);
		for (const key of Object.keys(contribution.env ?? {})) {
			const owner = owners.get(key);
			if (owner) {
				throw new Error(
					`Child launch contributors '${owner}' and '${contribution.id}' both set environment variable '${key}'.`,
				);
			}
			owners.set(key, contribution.id);
		}
	}
}

function isPolicyContributor(value: unknown): value is ChildPolicyContributor {
	return hasIdentityAndPrepare(value);
}

function isToolProvider(value: unknown): value is ChildToolProvider {
	if (!hasIdentityAndPrepare(value) || !("tools" in value) || !Array.isArray(value.tools)) return false;
	return value.tools.every(
		(tool) =>
			typeof tool === "object" &&
			tool !== null &&
			"name" in tool &&
			typeof tool.name === "string" &&
			tool.name.length > 0 &&
			"effects" in tool &&
			Array.isArray(tool.effects) &&
			tool.effects.every(isToolEffect),
	);
}

function isProviderRuntime(value: unknown): value is ChildProviderRuntimeContributor {
	return (
		hasIdentityAndPrepare(value) &&
		"providers" in value &&
		Array.isArray(value.providers) &&
		value.providers.every((provider) => typeof provider === "string" && provider.length > 0)
	);
}

function hasIdentityAndPrepare(value: unknown): value is { id: string; prepare(...args: unknown[]): Promise<unknown> } {
	return (
		typeof value === "object" &&
		value !== null &&
		"id" in value &&
		typeof value.id === "string" &&
		value.id.length > 0 &&
		"prepare" in value &&
		typeof value.prepare === "function"
	);
}

function isLaunchContribution(value: unknown): value is ChildLaunchContribution {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const contribution = value as Partial<ChildLaunchContribution>;
	if (typeof contribution.id !== "string" || contribution.id.length === 0) return false;
	if (
		!Array.isArray(contribution.args) ||
		!contribution.args.every((arg) => typeof arg === "string" && !arg.includes("\0"))
	) {
		return false;
	}
	if (
		contribution.env !== undefined &&
		(typeof contribution.env !== "object" ||
			contribution.env === null ||
			Array.isArray(contribution.env) ||
			Object.entries(contribution.env).some(
				([key, entry]) =>
					key.length === 0 ||
					key.includes("=") ||
					key.includes("\0") ||
					typeof entry !== "string" ||
					entry.includes("\0"),
			))
	) {
		return false;
	}
	if (
		typeof contribution.metadata !== "object" ||
		contribution.metadata === null ||
		Array.isArray(contribution.metadata) ||
		!isJsonValue(contribution.metadata)
	) {
		return false;
	}
	return typeof contribution.dispose === "function";
}

function isJsonValue(value: unknown, seen = new WeakSet<object>()): boolean {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (typeof value !== "object") return false;
	if (seen.has(value)) return false;
	seen.add(value);
	if (Array.isArray(value)) {
		const valid = value.every((entry) => isJsonValue(entry, seen));
		seen.delete(value);
		return valid;
	}
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return false;
	const valid = Object.values(value).every((entry) => isJsonValue(entry, seen));
	seen.delete(value);
	return valid;
}

function isToolEffect(value: unknown): value is ToolEffect {
	return (
		value === "read_files" ||
		value === "write_files" ||
		value === "list_files" ||
		value === "run_command" ||
		value === "network" ||
		value === "external_state" ||
		value === "secret_access"
	);
}
