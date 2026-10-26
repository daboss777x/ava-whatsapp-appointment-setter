import { logger, schemaTask } from "@trigger.dev/sdk";
import { z } from "zod";
import { requireEnvs, WHATSAPP_ENV } from "./lib/env.js";
import { db } from "./lib/supabase.js";
import { deleteEvent } from "./lib/calendar.js";
import { sendText } from "./lib/whatsapp.js";
import { inboundQueue } from "./handle-inbound-message.js";

/**
 * Testing aid: the sender typed the reset keyword. Wipe everything we know about that
 * phone number so their next message starts as a brand-new customer.
 * Shares the per-customer queue (concurrencyKey = phone) so it never races a reply in progress.
 */
export const resetCustomer = schemaTask({
  id: "reset-customer",
  queue: inboundQueue,
  schema: z.object({ phone: z.string().regex(/^\+\d{8,15}$/) }),
  retry: { maxAttempts: 2 },
  maxDuration: 120,
  run: async ({ phone }) => {
    requireEnvs(["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", ...WHATSAPP_ENV]);

    const { data: customer } = await db().from("customers").select("id").eq("wa_phone", phone).maybeSingle();
    let cancelledEvents = 0;

    if (customer) {
      // Remove their upcoming bookings from Google Calendar so no orphaned events are left behind.
      const { data: upcoming } = await db()
        .from("appointments")
        .select("gcal_event_id")
        .eq("customer_id", customer.id)
        .eq("status", "confirmed")
        .gte("starts_at", new Date().toISOString());
      for (const a of upcoming ?? []) {
        if (!a.gcal_event_id) continue;
        try {
          await deleteEvent(a.gcal_event_id);
          cancelledEvents++;
        } catch (err) {
          logger.warn("could not delete calendar event during reset", { error: String(err) });
        }
      }
      // Cascades to conversations, messages, customer_facts and appointments.
      const { error } = await db().from("customers").delete().eq("id", customer.id);
      if (error) throw new Error(`delete customer: ${error.message}`);
    }

    // Deliberately not stored: there's no customer row any more, and the next message creates a fresh one.
    await sendText(phone, "🔄 Reset done. You're a brand-new customer now, so say hi!");
    logger.info("customer reset", { existed: Boolean(customer), cancelledEvents });
    return { reset: true, existed: Boolean(customer), cancelledEvents };
  },
});
