// "What day is it?" for the whole server, in the company's time zone (APP_TIMEZONE, default India).
//
// The server used to ask the machine's own clock for "start of today". On Render (UTC) a task due 15 Nov
// only became overdue at 05:30 India time on 16 Nov, while people's browsers already showed it red from
// midnight; on an India-time machine the same code gave a different answer. Now every "today", "overdue",
// "due soon", "days late" and "finished on time" uses the company's calendar, wherever the server runs.
//
// A due date's day: the PMT screens save a picked date as midnight UTC of that date (15 Nov ->
// 2026-11-15T00:00:00Z), so an exact midnight-UTC value means that calendar date. Any other time (sent by
// another app or the API) means the day it falls on in the company's time zone.

const ZONE = process.env.APP_TIMEZONE || "Asia/Kolkata";
const DAY_MS = 86_400_000;
const dayFormat = new Intl.DateTimeFormat("en-CA", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit" });
const partsFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: ZONE, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit"
});

const ymdPlus = (ymd: string, days: number) => new Date(Date.parse(`${ymd}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10);
const isMidnightUtc = (d: Date) => d.getTime() % DAY_MS === 0;

// How far the company's clock is ahead of UTC at a moment (negative when behind), in milliseconds
function zoneOffsetMs(at: Date): number {
  const p = partsFormat.formatToParts(at);
  const get = (t: string) => Number(p.find((x) => x.type === t)?.value);
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - Math.floor(at.getTime() / 1000) * 1000;
}

// The moment a calendar date begins in the company's time zone (checked twice for daylight-saving days)
function zoneMidnight(ymd: string): Date {
  const utcMidnight = Date.parse(`${ymd}T00:00:00.000Z`);
  const first = utcMidnight - zoneOffsetMs(new Date(utcMidnight));
  return new Date(utcMidnight - zoneOffsetMs(new Date(first)));
}

/** The company's calendar date for a moment, as "YYYY-MM-DD" */
export function businessDateString(at: Date = new Date()): string {
  return dayFormat.format(at);
}

/** The calendar day a due (or warranty) date stands for, as "YYYY-MM-DD" */
export function dueDayString(due: Date): string {
  return isMidnightUtc(due) ? due.toISOString().slice(0, 10) : businessDateString(due);
}

/** The moment the company's day begins, today or `plusDays` from today */
export function startOfBusinessDay(at: Date = new Date(), plusDays = 0): Date {
  return zoneMidnight(ymdPlus(businessDateString(at), plusDays));
}

/** Overdue = its day is over in the company's time zone (a task due today is not overdue) */
export function isPastDueDay(due: Date, at: Date = new Date()): boolean {
  return dueDayString(due) < businessDateString(at);
}

/** Whole days between the due day and today (0 = due today, 1 = due yesterday) */
export function daysLate(due: Date, at: Date = new Date()): number {
  return Math.round((Date.parse(`${businessDateString(at)}T00:00:00Z`) - Date.parse(`${dueDayString(due)}T00:00:00Z`)) / DAY_MS);
}

/** The moment a due day ends in the company's time zone (finished before this = finished on time) */
export function endOfDueDay(due: Date): Date {
  return zoneMidnight(ymdPlus(dueDayString(due), 1));
}

/** "Nov 16": the due day in words, for messages */
export function formatDueDay(due: Date): string {
  return new Date(`${dueDayString(due)}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/**
 * Database filter: due at least `minDaysLate` days ago (1 = overdue at all). Starts from the company's
 * midnight; the one value it must leave out is a date-only due on the first day not yet late, which in a
 * zone behind UTC falls before that midnight.
 */
export function dueAtLeastDaysAgo(minDaysLate = 1, at: Date = new Date()) {
  const boundary = ymdPlus(businessDateString(at), 1 - minDaysLate);
  return { lt: zoneMidnight(boundary), not: new Date(`${boundary}T00:00:00.000Z`) };
}

/**
 * Database filter: due from day `fromDays` up to (not including) day `toDays` after today
 * (0..2 = today or tomorrow). Date-only values in a zone behind UTC sit just before the company's midnight,
 * so the range is widened to take them; a stray timed value there is the only thing it could also catch.
 */
export function dueWithinDays(fromDays: number, toDays: number, at: Date = new Date()) {
  const from = ymdPlus(businessDateString(at), fromDays);
  const to = ymdPlus(businessDateString(at), toDays);
  const start = zoneMidnight(from);
  const end = zoneMidnight(to);
  const startUtc = new Date(`${from}T00:00:00.000Z`);
  const endUtc = new Date(`${to}T00:00:00.000Z`);
  return { gte: startUtc < start ? startUtc : start, lt: endUtc < end ? endUtc : end };
}
