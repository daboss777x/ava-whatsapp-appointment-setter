import { createSign } from "node:crypto";
import { requireEnv, businessTz } from "./env.js";
import { fetchWithTimeout, withRetry } from "./http.js";
import { holidayName } from "./holidays.js";
import { addDays, friendly, hourInZone, tzLabel, weekday, ymdInZone, zonedToUtc } from "./time.js";

// ─── Booking rules (Northbeam Advisory) ───────────────────
export const RULES = {
  openHour: 9, // first slot 9:00
  closeHour: 17, // last slot ends 17:00
  slotMinutes: 30,
  bufferMinutes: 15, // gap kept free either side of every booking
  horizonDays: 14, // how far ahead people can book
  minNoticeMinutes: 120, // no bookings starting within the next 2 hours
  workdays: [1, 2, 3, 4, 5], // Mon–Fri
};

export type Slot = { start: string; end: string; label: string };
type Busy = { start: number; end: number };

const API = "https://www.googleapis.com/calendar/v3";
let cachedToken: { value: string; expiresAt: number } | null = null;

const b64url = (s: string | Buffer) => Buffer.from(s).toString("base64url");

/** Service-account login: sign a short-lived JWT with the private key and swap it for an access token. */
async function accessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;
  const email = requireEnv("GOOGLE_SERVICE_ACCOUNT_EMAIL");
  // Stored on one line in .env with literal "\n"s; restore real newlines.
  const privateKey = requireEnv("GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY").replace(/\\n/g, "\n");
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(
    JSON.stringify({
      iss: email,
      scope: "https://www.googleapis.com/auth/calendar",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    }),
  )}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(privateKey);
  const res = await fetchWithTimeout("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${b64url(signature)}`,
    }),
  });
  const json = (await res.json()) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!res.ok || !json.access_token) {
    throw new Error(`Google service-account login failed: ${json.error ?? res.status} ${json.error_description ?? ""}`.trim());
  }
  cachedToken = { value: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 };
  return cachedToken.value;
}

async function gcal<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetchWithTimeout(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  if (res.status === 204) return undefined as T;
  const body = await res.text();
  if (!res.ok) throw new Error(`Google Calendar ${init.method ?? "GET"} ${path.split("?")[0]} → ${res.status}: ${body.slice(0, 300)}`);
  return (body ? JSON.parse(body) : undefined) as T;
}

// Must be YOUR calendar's ID (your Gmail address), shared with the service account.
// "primary" would mean the service account's own empty calendar.
const calendarId = () => encodeURIComponent(requireEnv("GOOGLE_CALENDAR_ID"));

/** The one reusable Google Meet link every call uses (service accounts can't create Meet links on personal Gmail). */
export const meetLink = () => requireEnv("MEET_LINK");

export async function busyBetween(timeMin: Date, timeMax: Date): Promise<Busy[]> {
  const id = requireEnv("GOOGLE_CALENDAR_ID");
  const res = await withRetry(
    () =>
      gcal<{ calendars: Record<string, { busy: { start: string; end: string }[]; errors?: unknown[] }> }>("/freeBusy", {
        method: "POST",
        body: JSON.stringify({ timeMin: timeMin.toISOString(), timeMax: timeMax.toISOString(), items: [{ id }] }),
      }),
    "freeBusy",
  );
  const cal = res.calendars[id];
  if (!cal || cal.errors?.length) throw new Error(`freeBusy error for calendar: ${JSON.stringify(cal?.errors ?? "missing")}`);
  return cal.busy.map((b) => ({ start: Date.parse(b.start), end: Date.parse(b.end) }));
}

function overlaps(start: number, end: number, busy: Busy[]): boolean {
  const pad = RULES.bufferMinutes * 60_000;
  return busy.some((b) => start - pad < b.end && end + pad > b.start);
}

/** Every slot the rules allow on a given day, ignoring the calendar. */
function candidateSlots(ymd: string, tz: string): Date[] {
  if (!RULES.workdays.includes(weekday(ymd)) || holidayName(ymd)) return [];
  const out: Date[] = [];
  for (let mins = RULES.openHour * 60; mins + RULES.slotMinutes <= RULES.closeHour * 60; mins += RULES.slotMinutes) {
    out.push(zonedToUtc(ymd, Math.floor(mins / 60), mins % 60, tz));
  }
  return out;
}

function withinWindow(start: Date, tz: string): boolean {
  const now = Date.now();
  if (start.getTime() < now + RULES.minNoticeMinutes * 60_000) return false;
  const lastDay = addDays(ymdInZone(new Date(), tz), RULES.horizonDays);
  return ymdInZone(start, tz) <= lastDay;
}

function toSlot(start: Date, tz: string): Slot {
  const end = new Date(start.getTime() + RULES.slotMinutes * 60_000);
  return { start: start.toISOString(), end: end.toISOString(), label: friendly(start, tz) };
}

export async function getAvailableSlots(opts: {
  startDate: string;
  endDate: string;
  partOfDay?: "morning" | "afternoon" | "any" | null;
  limit?: number;
}): Promise<Slot[]> {
  const tz = businessTz();
  const today = ymdInZone(new Date(), tz);
  const lastDay = addDays(today, RULES.horizonDays);
  const from = opts.startDate < today ? today : opts.startDate;
  const to = opts.endDate > lastDay ? lastDay : opts.endDate;
  if (from > to) return [];

  const busy = await busyBetween(zonedToUtc(from, 0, 0, tz), zonedToUtc(addDays(to, 1), 0, 0, tz));
  const slots: Slot[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) {
    for (const start of candidateSlots(day, tz)) {
      if (!withinWindow(start, tz)) continue;
      const h = hourInZone(start, tz);
      if (opts.partOfDay === "morning" && h >= 12) continue;
      if (opts.partOfDay === "afternoon" && h < 13) continue; // afternoon = 1 PM onwards
      const end = start.getTime() + RULES.slotMinutes * 60_000;
      if (overlaps(start.getTime(), end, busy)) continue;
      slots.push(toSlot(start, tz));
    }
  }
  return slots.slice(0, opts.limit ?? 12);
}

/** Re-check one exact slot right before booking. `ignoreEventId` lets a reschedule ignore its own event. */
export async function checkSlot(
  startIso: string,
  ignoreEventId?: string | null,
): Promise<{ ok: true; slot: Slot } | { ok: false; reason: string }> {
  const tz = businessTz();
  const start = new Date(startIso);
  if (Number.isNaN(start.getTime())) return { ok: false, reason: "invalid_time" };
  const valid = candidateSlots(ymdInZone(start, tz), tz).some((c) => c.getTime() === start.getTime());
  if (!valid) return { ok: false, reason: "outside_business_hours" };
  if (!withinWindow(start, tz)) return { ok: false, reason: "too_soon_or_too_far" };

  const end = start.getTime() + RULES.slotMinutes * 60_000;
  const pad = RULES.bufferMinutes * 60_000;
  let busy = await busyBetween(new Date(start.getTime() - pad), new Date(end + pad));
  if (ignoreEventId && busy.length) {
    const own = await getEvent(ignoreEventId).catch(() => null);
    if (own) busy = busy.filter((b) => !(b.start === Date.parse(own.start.dateTime) && b.end === Date.parse(own.end.dateTime)));
  }
  if (overlaps(start.getTime(), end, busy)) return { ok: false, reason: "slot_taken" };
  return { ok: true, slot: toSlot(start, tz) };
}

type GEvent = { id: string; hangoutLink?: string; htmlLink?: string; start: { dateTime: string }; end: { dateTime: string } };

export async function getEvent(eventId: string): Promise<GEvent> {
  return withRetry(() => gcal<GEvent>(`/calendars/${calendarId()}/events/${encodeURIComponent(eventId)}`), "getEvent");
}

export async function createEvent(opts: { start: string; end: string; summary: string; description: string }): Promise<GEvent> {
  const tz = businessTz();
  const link = meetLink();
  // No attendees: Google blocks service accounts from inviting people on personal Gmail calendars.
  // The customer gets the Meet link on WhatsApp instead.
  return gcal<GEvent>(`/calendars/${calendarId()}/events`, {
    method: "POST",
    body: JSON.stringify({
      summary: opts.summary,
      description: `${opts.description}\n\nGoogle Meet: ${link}`,
      location: link,
      start: { dateTime: opts.start, timeZone: tz },
      end: { dateTime: opts.end, timeZone: tz },
      reminders: { useDefault: true },
    }),
  });
}

export async function moveEvent(eventId: string, start: string, end: string): Promise<GEvent> {
  const tz = businessTz();
  return withRetry(
    () =>
      gcal<GEvent>(`/calendars/${calendarId()}/events/${encodeURIComponent(eventId)}`, {
        method: "PATCH",
        body: JSON.stringify({ start: { dateTime: start, timeZone: tz }, end: { dateTime: end, timeZone: tz } }),
      }),
    "moveEvent",
  );
}

export async function deleteEvent(eventId: string): Promise<void> {
  try {
    await withRetry(() => gcal<void>(`/calendars/${calendarId()}/events/${encodeURIComponent(eventId)}`, { method: "DELETE" }), "deleteEvent");
  } catch (err) {
    // Already gone counts as cancelled.
    if (String(err).includes("→ 410") || String(err).includes("→ 404")) return;
    throw err;
  }
}

/** Is the team working at this instant (weekday, not a holiday, within opening hours)? */
export function isBusinessOpen(at: Date = new Date()): boolean {
  const tz = businessTz();
  const ymd = ymdInZone(at, tz);
  if (!RULES.workdays.includes(weekday(ymd)) || holidayName(ymd)) return false;
  const opens = zonedToUtc(ymd, RULES.openHour, 0, tz).getTime();
  const closes = zonedToUtc(ymd, RULES.closeHour, 0, tz).getTime();
  return at.getTime() >= opens && at.getTime() < closes;
}

/** Working minutes between two instants (only counts time the team is open). Capped at 14 days of scanning. */
export function businessMinutesBetween(from: Date, to: Date): number {
  const step = 5 * 60_000;
  const end = Math.min(to.getTime(), from.getTime() + 14 * 864e5);
  let minutes = 0;
  for (let t = from.getTime(); t < end; t += step) if (isBusinessOpen(new Date(t))) minutes += 5;
  return minutes;
}

/** When the team is next available, in words, e.g. "now (until 5:00 PM EAT)", "today at 9:00 AM EAT", "Mon, Oct 26 at 9:00 AM EAT". */
export function nextTeamAvailability(at: Date = new Date()): string {
  const tz = businessTz();
  const label = tzLabel(tz);
  if (isBusinessOpen(at)) return `now (until ${RULES.closeHour - 12}:00 PM ${label})`;
  const today = ymdInZone(at, tz);
  for (let i = 0; i <= 14; i++) {
    const day = addDays(today, i);
    if (!RULES.workdays.includes(weekday(day)) || holidayName(day)) continue;
    const opens = zonedToUtc(day, RULES.openHour, 0, tz);
    if (opens.getTime() <= at.getTime()) continue;
    const when = i === 0 ? "today" : i === 1 ? "tomorrow" : new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long", month: "short", day: "numeric" }).format(opens);
    return `${when} at ${RULES.openHour}:00 AM ${label}`;
  }
  return `the next business day at ${RULES.openHour}:00 AM ${label}`;
}
