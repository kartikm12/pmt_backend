// Repeating tasks: rules are a small part of the iCalendar RRULE format (what Google Calendar and Outlook use),
// stored as the task's `recurrence` text, e.g. "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH;COUNT=6".
//   FREQ      DAILY | WEEKLY | MONTHLY | YEARLY
//   INTERVAL  every N units (1-99)
//   BYDAY     weekly: the weekdays (MO..SU); monthly: one weekday with its place, 1-4 or -1 (last), e.g. -1WE
//   BYMONTHDAY monthly/yearly: day 1-31 (a short month uses its last day) or -1 (last day of the month)
//   BYMONTH   yearly: month 1-12
//   COUNT     how many are left, this task included (the next copy carries COUNT-1)
//   UNTIL     last allowed deadline, YYYYMMDD
// Deadlines are calendar dates stored as UTC midnight, so all arithmetic here uses UTC dates.
export type Freq = "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
export type Rule = {
  freq: Freq;
  interval: number;
  byDay?: string[];
  nth?: number;
  byMonthDay?: number;
  byMonth?: number;
  count?: number;
  until?: string;
};

export const WEEKDAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
const DAY = 86_400_000;
const weekdayOf = (d: Date) => WEEKDAYS[(d.getUTCDay() + 6) % 7];
const dayNo = (d: Date) => Math.floor(d.getTime() / DAY);
const lastDayOf = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
export const utcDate = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

export function parseRule(text: string): Rule | null {
  const parts = Object.fromEntries(
    text.trim().toUpperCase().split(";").filter(Boolean).map((p) => {
      const [k, v = ""] = p.split("=");
      return [k, v];
    })
  ) as Record<string, string>;
  const freq = parts.FREQ as Freq;
  if (!["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(freq)) return null;
  const known = new Set(["FREQ", "INTERVAL", "BYDAY", "BYMONTHDAY", "BYMONTH", "COUNT", "UNTIL"]);
  if (Object.keys(parts).some((k) => !known.has(k))) return null;
  const rule: Rule = { freq, interval: parts.INTERVAL ? Number(parts.INTERVAL) : 1 };
  if (!Number.isInteger(rule.interval) || rule.interval < 1 || rule.interval > 99) return null;
  if (parts.BYDAY) {
    const days = parts.BYDAY.split(",");
    if (freq === "WEEKLY") {
      if (!days.length || days.some((d) => !WEEKDAYS.includes(d))) return null;
      rule.byDay = WEEKDAYS.filter((d) => days.includes(d));
    } else if (freq === "MONTHLY") {
      const m = days.length === 1 ? /^(-1|[1-4])(MO|TU|WE|TH|FR|SA|SU)$/.exec(days[0]) : null;
      if (!m) return null;
      rule.nth = Number(m[1]);
      rule.byDay = [m[2]];
    } else return null;
  }
  if (parts.BYMONTHDAY) {
    const n = Number(parts.BYMONTHDAY);
    if (!(freq === "MONTHLY" || freq === "YEARLY") || !Number.isInteger(n) || !(n === -1 || (n >= 1 && n <= 31)) || rule.nth) return null;
    rule.byMonthDay = n;
  }
  if (parts.BYMONTH) {
    const n = Number(parts.BYMONTH);
    if (freq !== "YEARLY" || !Number.isInteger(n) || n < 1 || n > 12) return null;
    rule.byMonth = n;
  }
  if (parts.COUNT) {
    const n = Number(parts.COUNT);
    if (!Number.isInteger(n) || n < 1 || n > 500) return null;
    rule.count = n;
  }
  if (parts.UNTIL) {
    if (!/^\d{8}$/.test(parts.UNTIL)) return null;
    rule.until = parts.UNTIL;
  }
  if (rule.count && rule.until) return null;
  return rule;
}

export function formatRule(r: Rule): string {
  const out = [`FREQ=${r.freq}`];
  if (r.interval > 1) out.push(`INTERVAL=${r.interval}`);
  if (r.byDay?.length) out.push(`BYDAY=${r.nth ? `${r.nth}${r.byDay[0]}` : r.byDay.join(",")}`);
  if (r.byMonth !== undefined) out.push(`BYMONTH=${r.byMonth}`);
  if (r.byMonthDay !== undefined) out.push(`BYMONTHDAY=${r.byMonthDay}`);
  if (r.count !== undefined) out.push(`COUNT=${r.count}`);
  if (r.until) out.push(`UNTIL=${r.until}`);
  return out.join(";");
}

// Accepts a rule or the old "DAILY" / "WEEKLY" / "MONTHLY" values and fills in what the deadline implies
// (weekly: its weekday; monthly: its date; yearly: its month and date), so the rule never depends on the
// previous copy's possibly-shortened date. Returns null when the text isn't a rule this app understands.
export function normalizeRule(text: string, due: Date | null): string | null {
  const legacy: Record<string, string> = { DAILY: "FREQ=DAILY", WEEKLY: "FREQ=WEEKLY", MONTHLY: "FREQ=MONTHLY" };
  const rule = parseRule(legacy[text.trim().toUpperCase()] ?? text);
  if (!rule) return null;
  const anchor = utcDate(due ?? new Date());
  if (rule.freq === "WEEKLY" && !rule.byDay) rule.byDay = [weekdayOf(anchor)];
  if (rule.freq === "MONTHLY" && !rule.byDay && rule.byMonthDay === undefined) rule.byMonthDay = anchor.getUTCDate();
  if (rule.freq === "YEARLY") {
    rule.byMonth ??= anchor.getUTCMonth() + 1;
    rule.byMonthDay ??= anchor.getUTCDate();
  }
  return formatRule(rule);
}

// Does `d` fall on the pattern that started at `anchor` (the current deadline)?
function matches(r: Rule, anchor: Date, d: Date) {
  const y = d.getUTCFullYear(), m = d.getUTCMonth(), day = d.getUTCDate();
  const last = lastDayOf(y, m);
  if (r.freq === "DAILY") return (dayNo(d) - dayNo(anchor)) % r.interval === 0;
  if (r.freq === "WEEKLY") {
    const monday = (x: Date) => dayNo(x) - ((x.getUTCDay() + 6) % 7);
    return (r.byDay ?? [weekdayOf(anchor)]).includes(weekdayOf(d)) && ((monday(d) - monday(anchor)) / 7) % r.interval === 0;
  }
  const months = (y - anchor.getUTCFullYear()) * 12 + (m - anchor.getUTCMonth());
  if (r.freq === "MONTHLY") {
    if (months % r.interval !== 0) return false;
    if (r.nth && r.byDay) {
      if (weekdayOf(d) !== r.byDay[0]) return false;
      return r.nth === -1 ? day + 7 > last : Math.ceil(day / 7) === r.nth;
    }
    const want = r.byMonthDay ?? anchor.getUTCDate();
    return day === (want === -1 ? last : Math.min(want, last));
  }
  // YEARLY
  if ((y - anchor.getUTCFullYear()) % r.interval !== 0) return false;
  const wantMonth = (r.byMonth ?? anchor.getUTCMonth() + 1) - 1;
  const wantDay = r.byMonthDay ?? anchor.getUTCDate();
  return m === wantMonth && day === (wantDay === -1 ? last : Math.min(wantDay, last));
}

// The next deadline after `anchor` that is also on or after `today` (a late finish skips missed dates).
// null when UNTIL has passed. COUNT is the caller's business (it decides whether a copy is made at all).
export function nextOccurrence(r: Rule, anchor: Date, today: Date): Date | null {
  const a = utcDate(anchor);
  const from = Math.max(dayNo(a) + 1, dayNo(utcDate(today)));
  const unit = { DAILY: 1, WEEKLY: 7, MONTHLY: 31, YEARLY: 366 }[r.freq];
  const limit = from + unit * r.interval * 2 + 62;
  for (let n = from; n <= limit; n++) {
    const d = new Date(n * DAY);
    if (!matches(r, a, d)) continue;
    if (r.until && d.toISOString().slice(0, 10).replace(/-/g, "") > r.until) return null;
    return d;
  }
  return null;
}

// The next `howMany` deadlines after `anchor` (for the preview), honouring COUNT and UNTIL
export function upcoming(r: Rule, anchor: Date, howMany: number): Date[] {
  const out: Date[] = [];
  let at = utcDate(anchor);
  const left = r.count ? r.count - 1 : Infinity;
  while (out.length < Math.min(howMany, left)) {
    const next = nextOccurrence(r, at, at);
    if (!next) break;
    out.push(next);
    at = next;
  }
  return out;
}
