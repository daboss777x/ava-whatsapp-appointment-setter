import { schemaTask, logger } from "@trigger.dev/sdk";
import { z } from "zod";
import { GOOGLE_ENV_NAMES, requireEnvs } from "./lib/env.js";
import { checkSlot, createEvent, deleteEvent, getAvailableSlots, getEvent, meetLink, moveEvent } from "./lib/calendar.js";
import { addDays, ymdInZone } from "./lib/time.js";
import { businessTz } from "./lib/env.js";

/**
 * Dev/test: exercise the Google Calendar plumbing with no AI involved.
 *  - mode "slots": list free slots for the next 5 days
 *  - mode "full":  book the first free slot, move it to the next one, then delete it
 *                  (set keepEvent: true to leave it in the calendar so you can look at it)
 */
export const testCalendar = schemaTask({
  id: "test-calendar",
  schema: z.object({
    mode: z.enum(["slots", "full"]).default("slots"),
    keepEvent: z.boolean().default(false),
  }),
  retry: { maxAttempts: 1 },
  run: async ({ mode, keepEvent }) => {
    requireEnvs(GOOGLE_ENV_NAMES());
    const tz = businessTz();
    const today = ymdInZone(new Date(), tz);
    const slots = await getAvailableSlots({ startDate: today, endDate: addDays(today, 5), limit: 20 });
    logger.info("free slots", { count: slots.length, first: slots.slice(0, 5).map((s) => s.label) });
    if (mode === "slots") return { slots: slots.map((s) => s.label) };

    if (slots.length < 2) throw new Error("Need at least 2 free slots in the next 5 days to run the full test");
    const [first, second] = slots;

    const recheck = await checkSlot(first.start);
    if (!recheck.ok) throw new Error(`checkSlot rejected a free slot: ${recheck.reason}`);

    const event = await createEvent({
      start: first.start,
      end: first.end,
      summary: "TEST · Ava calendar check",
      description: "Created by the test-calendar task.",
    });
    logger.info("created", { id: event.id, at: first.label });

    const taken = await checkSlot(first.start);
    if (taken.ok) throw new Error("checkSlot still says the slot is free right after booking it");

    await moveEvent(event.id, second.start, second.end);
    const moved = await getEvent(event.id);
    logger.info("moved", { to: second.label, start: moved.start.dateTime });

    if (!keepEvent) await deleteEvent(event.id);
    return {
      booked: first.label,
      meetLink: meetLink(),
      movedTo: second.label,
      deleted: !keepEvent,
      doubleBookingGuard: "works",
    };
  },
});
