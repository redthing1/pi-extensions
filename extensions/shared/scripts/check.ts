import { strict as assert } from "node:assert";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	type ChildPolicyContributor,
	type ChildRunIntent,
	childLaunchArgs,
	childLaunchEnvironment,
	disposeChildLaunchContributions,
	observeChildPolicyContributors,
	observeChildProviderRuntimes,
	observeChildToolProviders,
	publishChildPolicyContributor,
	publishChildProviderRuntime,
	publishChildToolProvider,
} from "../child-runtime.ts";
import {
	builtinChildToolCapabilities,
	observeToolEffectAnalyzers,
	publishToolEffectAnalyzer,
} from "../tool-effects.ts";

type EventHandler = (value: unknown) => void;

function contractApi(): Pick<ExtensionAPI, "events"> {
	const handlers = new Map<string, EventHandler[]>();
	return {
		events: {
			on(name: string, handler: EventHandler) {
				const listeners = handlers.get(name) ?? [];
				listeners.push(handler);
				handlers.set(name, listeners);
				return () => {
					const index = listeners.indexOf(handler);
					if (index >= 0) listeners.splice(index, 1);
				};
			},
			emit(name: string, value: unknown) {
				for (const handler of handlers.get(name) ?? []) handler(value);
			},
		} as unknown as ExtensionAPI["events"],
	};
}

function checkToolEffectDiscovery(): void {
	assert.deepEqual(
		builtinChildToolCapabilities(["read", "bash"]),
		[
			"read_files",
			"run_command",
			"list_files",
			"write_files",
			"network",
			"external_state",
			"secret_access",
		],
	);
	const pi = contractApi();
	const observer = observeToolEffectAnalyzers(pi);
	publishToolEffectAnalyzer(pi, {
		toolName: "example",
		analyze: () => ({
			toolName: "example",
			effects: ["read_files"],
			risk: "safe_read",
			pathInputs: [{ field: "path", operation: "read" }],
			known: true,
			reason: "example tool declares its own effects",
		}),
	});
	const analysis = observer.analyze("example", { path: "/workspace/source" }, { cwd: "/workspace" });
	assert.equal(analysis?.risk, "safe_read");
	assert.deepEqual(analysis?.effects, ["read_files"]);
	assert.equal(observer.analyze("unknown", {}, { cwd: "/workspace" }), undefined);
}

function checkToolEffectIdentity(): void {
	const pi = contractApi();
	const observer = observeToolEffectAnalyzers(pi);
	const analyzer = {
		toolName: "example",
		analyze: () => ({
			toolName: "example",
			effects: ["read_files" as const],
			risk: "safe_read" as const,
			pathInputs: [],
			known: true,
			reason: "example",
		}),
	};
	publishToolEffectAnalyzer(pi, analyzer);
	publishToolEffectAnalyzer(pi, analyzer);
	assert.equal(observer.analyze("example", {}, { cwd: "/workspace" })?.known, true);
	publishToolEffectAnalyzer(pi, { ...analyzer });
	assert.throws(() => observer.analyze("example", {}, { cwd: "/workspace" }), /Duplicate tool-effect analyzers/);
}

async function checkChildPolicyComposition(): Promise<void> {
	const pi = contractApi();
	const observer = observeChildPolicyContributors(pi);
	const lifecycle: string[] = [];
	for (const id of ["beta", "alpha"]) {
		publishChildPolicyContributor(pi, {
			id,
			async prepare() {
				lifecycle.push(`prepare:${id}`);
				return {
					id,
					args: [`--${id}`],
					env: { [`POLICY_${id.toUpperCase()}`]: "enabled" },
					metadata: { active: true },
					dispose: async () => {
						lifecycle.push(`dispose:${id}`);
					},
				};
			},
		});
	}
	const contributions = await observer.prepare(childIntent());
	assert.deepEqual(
		contributions.map((contribution) => contribution.id),
		["alpha", "beta"],
	);
	assert.deepEqual(childLaunchArgs(contributions), ["--alpha", "--beta"]);
	assert.deepEqual({ ...childLaunchEnvironment(contributions) }, {
		POLICY_ALPHA: "enabled",
		POLICY_BETA: "enabled",
	});
	await disposeChildLaunchContributions(contributions);
	assert.deepEqual(lifecycle, ["prepare:alpha", "prepare:beta", "dispose:beta", "dispose:alpha"]);
}

async function checkChildPolicyIdentity(): Promise<void> {
	const pi = contractApi();
	const observer = observeChildPolicyContributors(pi);
	const contributor = {
		id: "policy",
		prepare: async () => undefined,
	};
	publishChildPolicyContributor(pi, contributor);
	publishChildPolicyContributor(pi, contributor);
	assert.deepEqual(await observer.prepare(childIntent()), []);
	publishChildPolicyContributor(pi, { ...contributor });
	await assert.rejects(observer.prepare(childIntent()), /Duplicate child policy contributor ids/);
}

async function checkMalformedContributionRejected(): Promise<void> {
	const malformedArgsApi = contractApi();
	const malformedArgsObserver = observeChildPolicyContributors(malformedArgsApi);
	let malformedDisposed = false;
	publishChildPolicyContributor(malformedArgsApi, {
		id: "malformed",
		async prepare() {
			return {
				id: "malformed",
				args: [42],
				metadata: {},
				dispose: async () => {
					malformedDisposed = true;
				},
			} as unknown as Awaited<ReturnType<ChildPolicyContributor["prepare"]>>;
		},
	});
	await assert.rejects(malformedArgsObserver.prepare(childIntent()), /malformed contribution/);
	assert.equal(malformedDisposed, true);

	const malformedEnvironmentApi = contractApi();
	const malformedEnvironmentObserver = observeChildPolicyContributors(malformedEnvironmentApi);
	publishChildPolicyContributor(malformedEnvironmentApi, {
		id: "malformed-environment",
		async prepare() {
			return {
				id: "malformed-environment",
				args: [],
				env: { "INVALID=NAME": "value" },
				metadata: {},
				dispose: async () => undefined,
			};
		},
	});
	await assert.rejects(
		malformedEnvironmentObserver.prepare(childIntent()),
		/malformed contribution/,
	);

	const malformedMetadataApi = contractApi();
	const malformedMetadataObserver = observeChildPolicyContributors(malformedMetadataApi);
	publishChildPolicyContributor(malformedMetadataApi, {
		id: "malformed-metadata",
		async prepare() {
			return {
				id: "malformed-metadata",
				args: [],
				metadata: { callback: () => undefined },
				dispose: async () => undefined,
			} as unknown as Awaited<ReturnType<ChildPolicyContributor["prepare"]>>;
		},
	});
	await assert.rejects(malformedMetadataObserver.prepare(childIntent()), /malformed contribution/);

	const mismatchedApi = contractApi();
	const mismatchedObserver = observeChildPolicyContributors(mismatchedApi);
	let mismatchedDisposed = false;
	publishChildPolicyContributor(mismatchedApi, {
		id: "expected",
		async prepare() {
			return {
				id: "unexpected",
				args: [],
				metadata: {},
				dispose: async () => {
					mismatchedDisposed = true;
				},
			};
		},
	});
	await assert.rejects(mismatchedObserver.prepare(childIntent()), /mismatched id/);
	assert.equal(mismatchedDisposed, true);
}

async function checkPreparationAndCleanupFailuresAreBothVisible(): Promise<void> {
	const pi = contractApi();
	const observer = observeChildPolicyContributors(pi);
	publishChildPolicyContributor(pi, {
		id: "alpha",
		async prepare() {
			return {
				id: "alpha",
				args: [],
				metadata: {},
				dispose: async () => {
					throw new Error("intentional cleanup failure");
				},
			};
		},
	});
	publishChildPolicyContributor(pi, {
		id: "beta",
		async prepare() {
			throw new Error("intentional preparation failure");
		},
	});
	await assert.rejects(
		observer.prepare(childIntent()),
		(error: unknown) =>
			error instanceof Error &&
			error.message.includes("intentional preparation failure") &&
			error.message.includes("intentional cleanup failure"),
	);
}

async function checkChildToolProviders(): Promise<void> {
	const pi = contractApi();
	const observer = observeChildToolProviders(pi);
	const provider = {
		id: "search",
		tools: [{ name: "web_search", effects: ["network" as const] }],
		async prepare(_intent: ChildRunIntent, tools: readonly string[]) {
			return {
				id: "search",
				args: ["--extension", "search"],
				metadata: { tools: [...tools] },
				dispose: async () => undefined,
			};
		},
	};
	publishChildToolProvider(pi, provider);
	assert.deepEqual(observer.definition("web_search"), {
		name: "web_search",
		effects: ["network"],
	});
	const contributions = await observer.prepare(childIntent(), ["web_search"]);
	assert.deepEqual(childLaunchArgs(contributions), ["--extension", "search"]);
	await disposeChildLaunchContributions(contributions);
	await assert.rejects(observer.prepare(childIntent(), ["missing"]), /No child tool provider is registered/);
	publishChildToolProvider(pi, {
		id: "other-search",
		tools: [{ name: "web_search", effects: ["network"] }],
		prepare: provider.prepare,
	});
	assert.throws(() => observer.definition("web_search"), /provided by both/);
}

async function checkChildProviderRuntime(): Promise<void> {
	const pi = contractApi();
	const observer = observeChildProviderRuntimes(pi);
	publishChildProviderRuntime(pi, {
		id: "router",
		providers: ["provider"],
		async prepare(intent) {
			return {
				id: "router",
				args: ["--extension", "router"],
				metadata: { provider: intent.provider },
				dispose: async () => undefined,
			};
		},
	});
	const contributions = await observer.prepare(childIntent());
	assert.deepEqual(childLaunchArgs(contributions), ["--extension", "router"]);
	await disposeChildLaunchContributions(contributions);
	assert.deepEqual(await observer.prepare({ ...childIntent(), provider: "built-in" }), []);
}

function checkCrossLaneConflicts(): void {
	const contribution = {
		id: "duplicate",
		args: [],
		metadata: {},
		dispose: async () => undefined,
	};
	assert.throws(
		() => childLaunchEnvironment([contribution, { ...contribution }]),
		/Duplicate child launch contribution id/,
	);
}

function childIntent(): ChildRunIntent {
	return {
		origin: { kind: "tool", toolCallId: "tool-call" },
		runId: "run",
		batchId: "batch",
		cwd: "/workspace/project",
		model: "provider/model",
		provider: "provider",
		tools: ["read"],
		capabilities: ["read_files"],
		references: [],
		privacy: { clientZdr: false, remoteZdr: false },
	};
}

checkToolEffectDiscovery();
checkToolEffectIdentity();
await checkChildPolicyComposition();
await checkChildPolicyIdentity();
await checkMalformedContributionRejected();
await checkPreparationAndCleanupFailuresAreBothVisible();
await checkChildToolProviders();
await checkChildProviderRuntime();
checkCrossLaneConflicts();
console.log("shared extension contracts: ok");
