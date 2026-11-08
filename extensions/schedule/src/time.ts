const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const MIN_DISPLAY_REFRESH_MS = 30 * SECOND_MS;

const DURATION_PART_RE =
	/(\d+(?:\.\d+)?)\s*(w(?:eeks?)?|d(?:ays?)?|h(?:ours?|rs?)?|m(?:in(?:ute)?s?)?|s(?:ec(?:ond)?s?)?)/gi;
const CLOCK_RE = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b|\b(\d{1,2}):(\d{2})\b/i;
const DATE_RE = /^(\d{4})-(\d{1,2})-(\d{1,2})$|^(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?$/;

const WEEKDAYS = new Map([
	["sun", 0],
	["sunday", 0],
	["mon", 1],
	["monday", 1],
	["tue", 2],
	["tues", 2],
	["tuesday", 2],
	["wed", 3],
	["wednesday", 3],
	["thu", 4],
	["thur", 4],
	["thurs", 4],
	["thursday", 4],
	["fri", 5],
	["friday", 5],
	["sat", 6],
	["saturday", 6],
]);

type RollPast = "day" | "week" | "year" | "none";

export function parseDurationMs(input: string): number | undefined {
	const source = input.trim().replace(/^(?:in|after|every)\s+/i, "");
	if (!source) return undefined;

	let total = 0;
	let matched = false;
	const leftover = source.replace(DURATION_PART_RE, (part, amountText: string, unitText: string) => {
		const amount = Number(amountText);
		if (!Number.isFinite(amount) || amount <= 0) return part;
		const unit = durationUnitMs(unitText);
		if (!unit) return part;
		total += amount * unit;
		matched = true;
		return "";
	});

	if (!matched || leftover.replace(/(?:,|\+|and|\s)+/gi, "") !== "") return undefined;
	const rounded = Math.round(total);
	return Number.isSafeInteger(rounded) && rounded > 0 ? rounded : undefined;
}

export function parseLocalTime(input: string, now = Date.now()): number | undefined {
	const source = input.trim().replace(/^(?:at|on)\s+/i, "");
	const clock = parseClock(source);
	if (!clock) return undefined;

	const dateText = normalizeDateSpec(source.slice(0, clock.start) + source.slice(clock.end));
	const dateSpec = parseDateSpec(dateText, now);
	if (!dateSpec) return undefined;

	const date = dateSpec.date;
	date.setHours(clock.hour, clock.minute, 0, 0);

	if (date.getTime() <= now) {
		rollDate(date, dateSpec.rollPast);
		if (date.getTime() <= now) return undefined;
	}

	return date.getTime();
}

function parseClock(input: string): { hour: number; minute: number; start: number; end: number } | undefined {
	const match = CLOCK_RE.exec(input);
	if (!match) return undefined;

	if (match[3]) {
		const hour = Number(match[1]);
		const minute = match[2] === undefined ? 0 : Number(match[2]);
		if (!Number.isInteger(hour) || hour < 1 || hour > 12) return undefined;
		if (!validMinute(minute)) return undefined;
		const normalizedHour = match[3].toLowerCase() === "am" ? hour % 12 : (hour % 12) + 12;
		return { hour: normalizedHour, minute, start: match.index, end: match.index + match[0].length };
	}

	const hour = Number(match[4]);
	const minute = Number(match[5]);
	if (!Number.isInteger(hour) || hour < 0 || hour > 23) return undefined;
	if (!validMinute(minute)) return undefined;
	return { hour, minute, start: match.index, end: match.index + match[0].length };
}

function parseDateSpec(input: string, now: number): { date: Date; rollPast: RollPast } | undefined {
	if (!input) return { date: dayStart(now), rollPast: "day" };
	if (input === "today") return { date: dayStart(now), rollPast: "none" };
	if (input === "tomorrow") return { date: addDays(dayStart(now), 1), rollPast: "none" };

	const weekday = parseWeekdaySpec(input, now);
	if (weekday) return weekday;

	const date = parseCalendarDate(input, now);
	if (date) return date;

	return undefined;
}

function parseWeekdaySpec(input: string, now: number): { date: Date; rollPast: RollPast } | undefined {
	const match = /^(next\s+)?([a-z]+)$/.exec(input);
	if (!match) return undefined;
	const day = WEEKDAYS.get(match[2] ?? "");
	if (day === undefined) return undefined;

	const date = dayStart(now);
	let delta = day - date.getDay();
	if (delta < 0 || match[1]) delta += 7;
	date.setDate(date.getDate() + delta);
	return { date, rollPast: "week" };
}

function parseCalendarDate(input: string, now: number): { date: Date; rollPast: RollPast } | undefined {
	const match = DATE_RE.exec(input);
	if (!match) return undefined;

	if (match[1]) {
		const year = Number(match[1]);
		const month = Number(match[2]);
		const day = Number(match[3]);
		const date = validDate(year, month, day);
		return date ? { date, rollPast: "none" } : undefined;
	}

	const month = Number(match[4]);
	const day = Number(match[5]);
	const yearText = match[6];
	const year = yearText === undefined ? new Date(now).getFullYear() : normalizeYear(Number(yearText));
	const date = validDate(year, month, day);
	if (!date) return undefined;
	return { date, rollPast: yearText === undefined ? "year" : "none" };
}

function normalizeDateSpec(input: string): string {
	return input
		.trim()
		.toLowerCase()
		.replace(/\b(?:at|on)\b/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function durationUnitMs(unit: string): number | undefined {
	const normalized = unit.toLowerCase();
	if (normalized.startsWith("s")) return SECOND_MS;
	if (normalized.startsWith("m")) return MINUTE_MS;
	if (normalized.startsWith("h")) return HOUR_MS;
	if (normalized.startsWith("d")) return DAY_MS;
	if (normalized.startsWith("w")) return WEEK_MS;
	return undefined;
}

function validMinute(minute: number): boolean {
	return Number.isInteger(minute) && minute >= 0 && minute <= 59;
}

function dayStart(timestamp: number): Date {
	const date = new Date(timestamp);
	date.setHours(0, 0, 0, 0);
	return date;
}

function addDays(date: Date, days: number): Date {
	const next = new Date(date);
	next.setDate(next.getDate() + days);
	return next;
}

function rollDate(date: Date, rollPast: RollPast): void {
	switch (rollPast) {
		case "day":
			date.setDate(date.getDate() + 1);
			return;
		case "week":
			date.setDate(date.getDate() + 7);
			return;
		case "year":
			date.setFullYear(date.getFullYear() + 1);
			return;
		case "none":
			return;
	}
}

function validDate(year: number, month: number, day: number): Date | undefined {
	if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return undefined;
	if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
	const date = new Date(year, month - 1, day);
	if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return undefined;
	date.setHours(0, 0, 0, 0);
	return date;
}

function normalizeYear(year: number): number {
	if (year < 100) return 2000 + year;
	return year;
}

export function formatDueTime(timestamp: number, now = Date.now()): string {
	const delta = timestamp - now;
	if (delta <= 0) return "due";
	if (delta < MINUTE_MS) return "<1m";
	if (delta < HOUR_MS) return `${Math.ceil(delta / MINUTE_MS)}m`;
	if (delta < DAY_MS) return `${Math.ceil(delta / HOUR_MS)}h`;
	return new Date(timestamp).toLocaleString();
}

export function nextDueDisplayRefreshMs(timestamp: number, now = Date.now()): number | undefined {
	const delta = timestamp - now;
	if (delta <= 0) return undefined;
	if (delta <= MINUTE_MS) return MIN_DISPLAY_REFRESH_MS;
	if (delta <= HOUR_MS) return clampDisplayRefresh(nextBoundaryDelay(delta, MINUTE_MS));
	if (delta <= DAY_MS) return clampDisplayRefresh(nextBoundaryDelay(delta, HOUR_MS));
	return Math.min(delta - DAY_MS + 1, WEEK_MS);
}

export function formatDuration(ms: number): string {
	if (ms % WEEK_MS === 0) return `${ms / WEEK_MS}w`;
	if (ms % DAY_MS === 0) return `${ms / DAY_MS}d`;
	if (ms % HOUR_MS === 0) return `${ms / HOUR_MS}h`;
	if (ms % MINUTE_MS === 0) return `${ms / MINUTE_MS}m`;
	if (ms % SECOND_MS === 0) return `${ms / SECOND_MS}s`;
	return `${Math.round(ms / SECOND_MS)}s`;
}

function nextBoundaryDelay(delta: number, unitMs: number): number {
	const current = Math.ceil(delta / unitMs);
	const threshold = Math.max(0, (current - 1) * unitMs);
	return Math.max(SECOND_MS, delta - threshold);
}

function clampDisplayRefresh(delay: number): number {
	return Math.max(MIN_DISPLAY_REFRESH_MS, delay);
}
