import { strict as assert } from "node:assert";
import { formatDueTime, formatDuration, nextDueDisplayRefreshMs, parseDurationMs, parseLocalTime } from "../src/time.js";

assert.equal(parseDurationMs("10m"), 600_000);
assert.equal(parseDurationMs("2h"), 7_200_000);
assert.equal(parseDurationMs("1d"), 86_400_000);
assert.equal(parseDurationMs("2 weeks"), 1_209_600_000);
assert.equal(parseDurationMs("1h30m"), 5_400_000);
assert.equal(parseDurationMs("1 hour 30 minutes"), 5_400_000);
assert.equal(parseDurationMs("in 1.5h"), 5_400_000);
assert.equal(parseDurationMs("1h and 15m"), 4_500_000);
assert.equal(parseDurationMs("0m"), undefined);
assert.equal(parseDurationMs("soon"), undefined);
assert.equal(parseDurationMs("1 month"), undefined);

const base = new Date("2026-06-17T10:00:00").getTime();
assert.equal(parseLocalTime("10:30", base), new Date("2026-06-17T10:30:00").getTime());
assert.equal(parseLocalTime("09:30", base), new Date("2026-06-18T09:30:00").getTime());
assert.equal(parseLocalTime("11am", base), new Date("2026-06-17T11:00:00").getTime());
assert.equal(parseLocalTime("9am", base), new Date("2026-06-18T09:00:00").getTime());
assert.equal(parseLocalTime("tomorrow 9am", base), new Date("2026-06-18T09:00:00").getTime());
assert.equal(parseLocalTime("tomorrow at 9:30pm", base), new Date("2026-06-18T21:30:00").getTime());
assert.equal(parseLocalTime("fri 17:00", base), new Date("2026-06-19T17:00:00").getTime());
assert.equal(parseLocalTime("wed 09:30", base), new Date("2026-06-24T09:30:00").getTime());
assert.equal(parseLocalTime("2026-06-18 9am", base), new Date("2026-06-18T09:00:00").getTime());
assert.equal(parseLocalTime("6/18 9am", base), new Date("2026-06-18T09:00:00").getTime());
assert.equal(parseLocalTime("today 09:30", base), undefined);
assert.equal(parseLocalTime("24:00", base), undefined);
assert.equal(parseLocalTime("13pm", base), undefined);

assert.equal(formatDuration(600_000), "10m");
assert.equal(formatDuration(7_200_000), "2h");
assert.equal(formatDueTime(base + 45_000, base), "<1m");
assert.equal(formatDueTime(base + 90_000, base), "2m");
assert.equal(nextDueDisplayRefreshMs(base + 45_000, base), 30_000);
assert.equal(nextDueDisplayRefreshMs(base + 90_000, base), 30_000);
assert.equal(nextDueDisplayRefreshMs(base - 1, base), undefined);

console.log("schedule extension checks passed");
