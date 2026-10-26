// Timezone helpers with no dependencies. Everything is stored in UTC and only
// converted to the business timezone for slot maths and display.

/** Minutes the zone is ahead of UTC at a given instant (e.g. -240 for EDT). */
export function tzOffsetMinutes(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return Math.round((asUtc - date.getTime()) / 60_000);
}

/** Wall-clock time in a zone → the real instant. Handles DST by re-checking the offset. */
export function zonedToUtc(ymd: string, hour: number, minute: number, timeZone: string): Date {
  const [y, m, d] = ymd.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d, hour, minute);
  let offset = tzOffsetMinutes(new Date(guess), timeZone);
  let result = new Date(guess - offset * 60_000);
  const offset2 = tzOffsetMinutes(result, timeZone);
  if (offset2 !== offset) result = new Date(guess - offset2 * 60_000);
  return result;
}

/** YYYY-MM-DD of an instant, as seen in the zone. */
export function ymdInZone(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

/** 0 = Sunday … 6 = Saturday, for a YYYY-MM-DD date. */
export function weekday(ymd: string): number {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Short zone label customers see, e.g. "EAT" or "ET". Set BUSINESS_TZ_LABEL to override. */
export function tzLabel(timeZone: string): string {
  if (process.env.BUSINESS_TZ_LABEL) return process.env.BUSINESS_TZ_LABEL;
  if (timeZone === "America/New_York") return "ET";
  const part = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" }).formatToParts(new Date());
  return part.find((p) => p.type === "timeZoneName")?.value ?? timeZone;
}

/** "Fri, Oct 23, 2:30 PM EAT" */
export function friendly(date: Date, timeZone: string): string {
  const s = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
  return `${s} ${tzLabel(timeZone)}`;
}

/** Hour of day (0–23) of an instant, in the zone. */
export function hourInZone(date: Date, timeZone: string): number {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hourCycle: "h23" }).format(date));
}
