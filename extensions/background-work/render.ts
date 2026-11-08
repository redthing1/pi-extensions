import { keyHint, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	Container,
	Box,
	Spacer,
	Text,
	TruncatedText,
	safeTerminalLabel,
	safeTerminalText,
	type Component,
} from "@earendil-works/pi-tui";
import type { Job } from "./jobs.ts";

type Theme = ExtensionContext["ui"]["theme"];
const stateLabels: Record<Job["state"], string> = {
	starting: "starting",
	running: "running",
	stopping: "stopping",
	finished: "completed",
	failed: "failed",
	stopped: "stopped",
};
type JobView = Pick<Job, "id" | "label" | "state" | "exitCode" | "preview" | "diagnostic" | "fullOutputPath" | "wake"> & {
	monitor?: boolean;
	event?: boolean;
};
export interface BackgroundDetails {
	backgroundWork: {
		jobs: JobView[];
		receipt?: "started" | "released" | "timeout";
		overview?: boolean;
		omitted?: number;
	};
}

export function isBackgroundDetails(value: unknown): value is BackgroundDetails {
	return typeof value === "object" && value !== null && "backgroundWork" in value;
}

export function jobView(job: Job): JobView {
	const { id, label, state, exitCode, preview, diagnostic, fullOutputPath, wake } = job;
	return {
		id,
		label,
		state,
		exitCode,
		preview,
		diagnostic,
		fullOutputPath,
		wake,
		...(job.monitor ? { monitor: true } : {}),
	};
}

export function renderCall(action: "status" | "wait" | "stop", id: string | undefined, theme: Theme): Component {
	return new TruncatedText(
		`${theme.fg("toolTitle", theme.bold(`Background ${action}`))}${id ? theme.fg("dim", ` · #${safeTerminalLabel(id)}`) : ""}`,
	);
}

export function panel(content: Component, outputPad: number, theme: Theme): Box {
	const box = new Box(outputPad, 0, (line) => theme.bg("toolPendingBg", line));
	box.addChild(content);
	return box;
}

export function renderHeader(content: Component, outputPad: number, theme: Theme): Component {
	const body = new Container();
	body.addChild(new Spacer(1));
	body.addChild(content);
	return panel(body, outputPad, theme);
}

export function renderJobs(
	details: BackgroundDetails,
	expanded: boolean,
	theme: Theme,
	selectedId?: string,
): Component {
	const { jobs, receipt, overview, omitted = 0 } = details.backgroundWork;
	const container = new Container();
	if (!jobs.length) return new Text(theme.fg("muted", "no outstanding background work"), 0, 0);
	const shown = expanded ? jobs : jobs.slice(0, 6);
	for (const job of shown) {
		const selected = selectedId === job.id;
		const state = job.event
			? "update"
			: receipt
				? receipt === "released"
					? "wait released"
					: receipt === "timeout"
						? "wait limit reached"
						: job.monitor
							? "watching"
							: "running in background"
				: job.monitor && job.state === "running"
					? "monitoring"
					: stateLabels[job.state];
		const color =
			receipt || job.event
				? "accent"
				: job.state === "failed"
					? "error"
					: job.state === "finished"
						? "success"
						: "muted";
		const glyph = receipt ? "↳" : job.state === "failed" ? "✗" : job.state === "finished" ? "✓" : "•";
		const suffix = job.exitCode !== undefined && job.exitCode !== 0 ? ` · exit ${job.exitCode}` : "";
		const identity = theme.fg("dim", `#${safeTerminalLabel(job.id)}`);
		if (overview) {
			container.addChild(
				new TruncatedText(
					`${identity}  ${theme.fg(color, state)}${theme.fg("dim", `${suffix} · ${safeTerminalLabel(job.label)}`)}`,
				),
			);
		} else {
			const heading = receipt
				? `${theme.fg(color, glyph)} ${theme.fg("muted", state)}${selected ? "" : ` ${theme.fg("dim", "·")} ${identity}`}`
				: `${theme.fg(color, glyph)} ${theme.fg("toolTitle", theme.bold(job.monitor ? "Monitor" : "Background"))}${selected ? " " : ` ${identity}${theme.fg("dim", " · ")}`}${theme.fg(color, state)}${theme.fg("dim", suffix)}`;
			container.addChild(new Text(heading, receipt || selected ? 2 : 0, 0));
		}
		if (receipt && receipt !== "started")
			container.addChild(new Text(theme.fg("dim", "still running in background"), 4, 0));
		if (expanded) {
			const command = theme.fg("dim", `$ ${safeTerminalLabel(job.label)}`);
			container.addChild(new Text(command, 2, 0));
		}
		if (!job.wake && job.state !== "stopped")
			container.addChild(new Text(theme.fg("dim", "automatic continuation off"), 2, 0));
		if (!receipt && (!overview || expanded) && (job.preview.trim() || job.fullOutputPath))
			container.addChild(
				outputPreview(job.preview, expanded, theme, false, job.fullOutputPath, selected ? 4 : 2),
			);
		if (!receipt && (!overview || expanded) && job.diagnostic)
			container.addChild(
				new Text(
					theme.fg(job.state === "failed" ? "error" : "muted", safeTerminalText(job.diagnostic)),
					selected ? 4 : 2,
					0,
				),
			);
	}
	const hidden = jobs.length - shown.length;
	if (hidden || omitted)
		container.addChild(
			new Text(
				theme.fg("muted", `${hidden + omitted} more jobs`) +
					(hidden ? ` · ${keyHint("app.tools.expand", "details")}` : ""),
				2,
				0,
			),
		);
	return container;
}

export function renderText(text: string, expanded: boolean, theme: Theme, error = false): Component {
	return outputPreview(text, expanded, theme, error);
}

function outputPreview(
	value: string,
	expanded: boolean,
	theme: Theme,
	error = false,
	fullOutputPath?: string,
	padding = 2,
): Component {
	const text = new Text(theme.fg(error ? "error" : "text", safeTerminalText(value).trimEnd()), padding, 0);
	return {
		invalidate() {
			text.invalidate();
		},
		render(width) {
			const lines = value.trim() ? text.render(width) : [];
			if (expanded)
				return [
					...lines,
					...(fullOutputPath
						? new Text(theme.fg("dim", `full output: ${safeTerminalText(fullOutputPath)}`), padding, 0).render(width)
						: []),
				];
			const earlier = Math.max(0, lines.length - 4);
			return [
				...(earlier
					? new Text(
							theme.fg("dim", `… ${earlier} earlier lines · `) + keyHint("app.tools.expand", "to expand"),
							padding,
							0,
						).render(width)
					: []),
				...lines.slice(-4),
				...(fullOutputPath
					? new Text(
							theme.fg("dim", "full output saved") + (earlier ? "" : ` · ${keyHint("app.tools.expand", "details")}`),
							padding,
							0,
						).render(width)
					: []),
			];
		},
	};
}
