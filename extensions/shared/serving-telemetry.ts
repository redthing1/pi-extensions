import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type ServingTelemetryPhase = "prefill" | "decode";

export interface ServingTelemetrySettings {
	enabled: boolean;
	minIntervalMs: number;
}

export const DEFAULT_SERVING_TELEMETRY_SETTINGS: ServingTelemetrySettings = {
	enabled: true,
	minIntervalMs: 100,
};

export interface ServingTelemetryUpdate {
	phase: ServingTelemetryPhase;
	elapsedMs?: number;
	promptTotal?: number;
	promptProcessed?: number;
	promptCached?: number;
	outputTokens?: number;
	prefillTokensPerSecond?: number;
	decodeTokensPerSecond?: number;
}

export interface ServingTelemetryOptions extends ServingTelemetrySettings {
	label: string;
}

interface ActiveTelemetry extends ServingTelemetryUpdate {
	id: number;
	options: ServingTelemetryOptions;
	startedMs: number;
	firstOutputMs?: number;
	firstOutputTokens?: number;
	lastPrefillTokens: number;
	lastPrefillSampleMs: number;
	lastUpdateMs: number;
	timer: ReturnType<typeof setInterval>;
}

export class ServingTelemetryController {
	private ctx: ExtensionContext | undefined;
	private active: ActiveTelemetry | undefined;
	private nextId = 0;

	attach(ctx: ExtensionContext): void {
		this.ctx = ctx;
	}

	begin(options: ServingTelemetryOptions): number | undefined {
		this.end();
		if (!options.enabled) return undefined;

		const id = ++this.nextId;
		const startedMs = performance.now();
		const active: ActiveTelemetry = {
			id,
			options,
			phase: "prefill",
			startedMs,
			lastPrefillTokens: 0,
			lastPrefillSampleMs: startedMs,
			lastUpdateMs: 0,
			timer: setInterval(() => this.refresh(), options.minIntervalMs),
		};
		this.active = active;
		this.refresh(true);
		return id;
	}

	update(id: number | undefined, update: ServingTelemetryUpdate): void {
		const active = this.active;
		if (!active || id === undefined || active.id !== id) return;

		const now = performance.now();
		const phaseChanged = active.phase !== update.phase;
		if (update.phase === "decode" && active.firstOutputMs === undefined) {
			active.firstOutputMs = now;
			active.firstOutputTokens = update.outputTokens ?? 0;
		}
		if (update.phase === "prefill" && update.promptProcessed !== undefined) {
			const tokens = update.promptProcessed - (update.promptCached ?? active.promptCached ?? 0);
			const elapsedMs = now - active.lastPrefillSampleMs;
			const processed = tokens - active.lastPrefillTokens;
			if (update.prefillTokensPerSecond === undefined) {
				active.prefillTokensPerSecond = elapsedMs > 0 && processed > 0
					? processed / (elapsedMs / 1000)
					: undefined;
			}
			active.lastPrefillTokens = tokens;
			active.lastPrefillSampleMs = now;
		}

		active.phase = update.phase;
		copyDefined(active, update, "elapsedMs");
		copyDefined(active, update, "promptTotal");
		copyDefined(active, update, "promptProcessed");
		copyDefined(active, update, "promptCached");
		copyDefined(active, update, "outputTokens");
		copyDefined(active, update, "prefillTokensPerSecond");
		copyDefined(active, update, "decodeTokensPerSecond");
		this.refresh(phaseChanged);
	}

	end(id?: number): void {
		const active = this.active;
		if (!active || (id !== undefined && active.id !== id)) return;
		clearInterval(active.timer);
		this.ctx?.ui.setWorkingMessage(undefined);
		this.active = undefined;
	}

	private refresh(force = false): void {
		const active = this.active;
		if (!active) return;
		const now = performance.now();
		if (!force && now - active.lastUpdateMs < active.options.minIntervalMs) return;
		active.lastUpdateMs = now;
		this.ctx?.ui.setWorkingMessage(formatServingTelemetry({ ...active, label: active.options.label }, now));
	}
}

export function formatServingTelemetry(stats: ServingTelemetryUpdate & {
	label: string;
	startedMs: number;
	firstOutputMs?: number;
	firstOutputTokens?: number;
}, now: number): string {
	if (stats.phase === "prefill") {
		const parts = [`${stats.label} pre`];
		if (stats.promptProcessed !== undefined && stats.promptTotal !== undefined) {
			parts.push(
				`${formatPercent(stats.promptProcessed, stats.promptTotal)}`,
				`${formatCount(stats.promptProcessed)}/${formatCount(stats.promptTotal)}`,
			);
		} else {
			parts.push(formatSeconds(stats.elapsedMs ?? now - stats.startedMs));
		}
		if (stats.promptCached !== undefined && stats.promptCached > 0) {
			parts.push(`c${formatCount(stats.promptCached)}`);
		}
		if (stats.prefillTokensPerSecond !== undefined && stats.prefillTokensPerSecond > 0) {
			parts.push(`${formatRate(stats.prefillTokensPerSecond)}/s`);
		}
		return parts.join(" ");
	}

	const parts = [`${stats.label} dec`];
	if (stats.outputTokens !== undefined) parts.push(formatCount(stats.outputTokens));
	const decodeRate = resolvedDecodeRate(stats, now);
	if (decodeRate !== undefined && decodeRate > 0) parts.push(`@${formatRate(decodeRate)}/s`);

	if (stats.firstOutputMs !== undefined) {
		parts.push(`· ttft ${formatSeconds(stats.firstOutputMs - stats.startedMs)}`);
	}
	if (stats.promptTotal !== undefined && stats.promptTotal > 0) {
		parts.push(`· ctx ${formatCount(stats.promptTotal)}`);
		if (stats.promptCached !== undefined && stats.promptCached > 0) {
			parts.push(`c${formatCount(stats.promptCached)}`);
		}
	}
	return parts.join(" ");
}

function resolvedDecodeRate(
	stats: ServingTelemetryUpdate & { firstOutputMs?: number; firstOutputTokens?: number },
	now: number,
): number | undefined {
	if (stats.decodeTokensPerSecond !== undefined) return stats.decodeTokensPerSecond;
	if (stats.firstOutputMs === undefined || stats.outputTokens === undefined) return undefined;
	const elapsedMs = now - stats.firstOutputMs;
	const generated = Math.max(0, stats.outputTokens - (stats.firstOutputTokens ?? 0));
	return elapsedMs > 0 && generated > 0 ? generated / (elapsedMs / 1000) : undefined;
}

function copyDefined<K extends keyof ServingTelemetryUpdate>(
	target: ServingTelemetryUpdate,
	source: ServingTelemetryUpdate,
	key: K,
): void {
	const value = source[key];
	if (value !== undefined) target[key] = value;
}

function formatSeconds(milliseconds: number): string {
	const seconds = Math.max(0, milliseconds / 1000);
	return `${seconds < 10 ? seconds.toFixed(1) : seconds.toFixed(0)}s`;
}

function formatCount(value: number): string {
	const rounded = Math.max(0, Math.round(value));
	if (rounded >= 1_000_000) return `${trimNumber(rounded / 1_000_000)}m`;
	if (rounded >= 1_000) return `${trimNumber(rounded / 1_000)}k`;
	return String(rounded);
}

function formatPercent(processed: number, total: number): string {
	if (total <= 0) return "0%";
	const percent = Math.min(100, Math.max(0, (processed / total) * 100));
	return percent > 0 && percent < 10 ? `${percent.toFixed(1)}%` : `${percent.toFixed(0)}%`;
}

function formatRate(value: number): string {
	if (value >= 1_000_000) return `${trimNumber(value / 1_000_000)}m`;
	if (value >= 1_000) return `${trimNumber(value / 1_000)}k`;
	return value >= 100 ? value.toFixed(0) : value >= 10 ? trimNumber(value) : trimNumber(value, 2);
}

function trimNumber(value: number, digits = 1): string {
	return value.toFixed(digits).replace(/\.0$|(\.\d*?)0+$/, "$1");
}
