/*
 * Business time zone helpers. The platform runs on US Eastern time (America/New_York), which
 * observes daylight saving time, so offsets are computed per instant (never a fixed "-05:00").
 */

export const BUSINESS_TIMEZONE = "America/New_York";

const partsFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: BUSINESS_TIMEZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/** Milliseconds to add to UTC to get the zone's wall clock at `instant` (e.g. -5 h in winter). */
function zoneOffsetMs(instant: number): number {
  const p = Object.fromEntries(partsFormatter.formatToParts(new Date(instant)).map((x) => [x.type, x.value]));
  const wall = Date.UTC(Number(p["year"]), Number(p["month"]) - 1, Number(p["day"]), Number(p["hour"]), Number(p["minute"]), Number(p["second"]));
  return wall - Math.floor(instant / 1000) * 1000;
}

/**
 * The UTC instant of a wall-clock time in the business zone, e.g. ("2026-11-10", "00:00:00.000").
 * A time skipped by the spring-forward jump resolves to the instant just after it; a repeated
 * fall-back time resolves to its first occurrence.
 */
export function zonedTimeToUtc(date: string, time: string): Date {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const [hh, mm, rest] = time.split(":") as [string, string, string | undefined];
  const [ss, ms] = (rest ?? "0").split(".") as [string, string | undefined];
  const wall = Date.UTC(y, m - 1, d, Number(hh), Number(mm), Number(ss), Number((ms ?? "0").padEnd(3, "0").slice(0, 3)));
  const first = wall - zoneOffsetMs(wall);
  return new Date(wall - zoneOffsetMs(first));
}

/** "Nov 6, 2026, 4:15 AM EST" (abbreviation follows daylight saving: EST / EDT). */
const displayFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: BUSINESS_TIMEZONE,
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short",
});
export const formatBusinessDateTime = (date: Date): string => displayFormatter.format(date);

/** "Nov 18, 2026" in the business zone (a calendar date for messages, e.g. a reapply date). */
const dateFormatter = new Intl.DateTimeFormat("en-US", { timeZone: BUSINESS_TIMEZONE, month: "short", day: "numeric", year: "numeric" });
export const formatBusinessDate = (date: Date): string => dateFormatter.format(date);
