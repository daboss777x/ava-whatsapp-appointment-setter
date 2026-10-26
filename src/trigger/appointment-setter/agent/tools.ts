import { z } from "zod";
import type { FunctionTool } from "openai/resources/responses/responses";
import { businessTz } from "../lib/env.js";
import { checkSlot, createEvent, deleteEvent, getAvailableSlots, meetLink, moveEvent, nextTeamAvailability } from "../lib/calendar.js";
import { db, type Appointment, type Customer } from "../lib/supabase.js";
import { addDays, friendly, ymdInZone } from "../lib/time.js";

export type ToolContext = { customer: Customer; conversationId: string };
export type ToolResult = { ok: boolean; [k: string]: unknown };

type ToolDef<S extends z.ZodObject> = {
  description: string;
  schema: S;
  handler: (args: z.infer<S>, ctx: ToolContext) => Promise<ToolResult>;
};
const tool = <S extends z.ZodObject>(t: ToolDef<S>) => t;

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Date as YYYY-MM-DD");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

/** Tidy how people type emails on a phone: "John . Doe @ Gmail dot com" → "john.doe@gmail.com". */
export function normalizeEmail(raw: string): string {
  let s = raw.trim().toLowerCase();
  if (!s.includes("@")) s = s.replace(/\s*[([]at[)\]]\s*|\s+at\s+/, "@");
  return s.replace(/\s*[([]dot[)\]]\s*|\s+dot\s+/g, ".").replace(/\s+/g, "");
}

const EMAIL_HELP =
  "That email isn't complete. Don't ask them to retype it: work out what they most likely meant " +
  "(e.g. 'name @ gmail' → name@gmail.com) and ask them to confirm, e.g. \"Just to confirm, that's name@gmail.com?\"";

/** Up to 3 free slots on the same day or the next couple of days, for "that one's gone" replies. */
async function alternativesNear(startIso: string) {
  const day = ymdInZone(new Date(startIso), businessTz());
  const slots = await getAvailableSlots({ startDate: day, endDate: addDays(day, 2), limit: 3 });
  return slots.map((s) => ({ start: s.start, label: s.label }));
}

async function ownAppointment(id: string, ctx: ToolContext): Promise<Appointment | null> {
  const { data } = await db()
    .from("appointments")
    .select("*")
    .eq("id", id)
    .eq("customer_id", ctx.customer.id)
    .eq("status", "confirmed")
    .maybeSingle();
  return (data as Appointment) ?? null;
}

const toolDefs = {
  check_availability: tool({
    description:
      "Find free 30-minute Google Meet slots (Mon–Fri 9am–5pm business time, up to 14 days ahead; slot labels show the timezone). Returns up to 12 slots; offer the customer at most 3.",
    schema: z.object({
      start_date: ymd.describe("First day to search, YYYY-MM-DD, inclusive"),
      end_date: ymd.describe("Last day to search, YYYY-MM-DD, inclusive"),
      part_of_day: z.enum(["morning", "afternoon", "any"]).nullable().describe("Optional preference; null for any"),
    }),
    handler: async (a) => {
      const slots = await getAvailableSlots({ startDate: a.start_date, endDate: a.end_date, partOfDay: a.part_of_day });
      if (!slots.length) return { ok: true, slots: [], message: "No free slots in that window. Suggest a different day or week." };
      return { ok: true, slots: slots.map((s) => ({ start: s.start, label: s.label })) };
    },
  }),

  book_appointment: tool({
    description:
      "Book a slot returned by check_availability. Puts it in the business calendar and returns the Google Meet link to send the customer.",
    schema: z.object({
      slot_start: z.string().describe("The exact `start` value of a slot from check_availability (ISO 8601)"),
      service: z.enum(["Discovery Call", "Strategy Session", "Growth Retainer intro"]),
      email: z.string().nullable().describe("Customer's email if they gave one, else null"),
      notes: z.string().nullable().describe("One line on what they want to discuss, or null"),
    }),
    handler: async (a, ctx) => {
      if (a.email) a.email = normalizeEmail(a.email);
      if (a.email && !EMAIL_RE.test(a.email)) return { ok: false, error: "incomplete_email", message: EMAIL_HELP };

      // Same customer, same slot, already booked → return it instead of double-booking.
      const { data: dup } = await db()
        .from("appointments")
        .select("*")
        .eq("customer_id", ctx.customer.id)
        .eq("starts_at", new Date(a.slot_start).toISOString())
        .eq("status", "confirmed")
        .maybeSingle();
      if (dup) return { ok: true, appointment_id: dup.id, confirmed_time: friendly(new Date(dup.starts_at), businessTz()), meet_link: dup.meet_link, already_booked: true };

      const check = await checkSlot(a.slot_start);
      if (!check.ok) {
        return { ok: false, error: check.reason, message: "That time isn't available.", alternatives: await alternativesNear(a.slot_start) };
      }
      const name = ctx.customer.display_name || ctx.customer.wa_profile_name || "WhatsApp customer";
      const event = await createEvent({
        start: check.slot.start,
        end: check.slot.end,
        summary: `${a.service} · ${name}`,
        description: `Booked by Ava via WhatsApp.\nCustomer: ${name} (${ctx.customer.wa_phone})${a.email ? `\nEmail: ${a.email}` : ""}${a.notes ? `\nNotes: ${a.notes}` : ""}`,
      });
      const link = meetLink();
      const { data: appt, error } = await db()
        .from("appointments")
        .insert({
          customer_id: ctx.customer.id,
          conversation_id: ctx.conversationId,
          gcal_event_id: event.id,
          service: a.service,
          starts_at: check.slot.start,
          ends_at: check.slot.end,
          timezone: businessTz(),
          meet_link: link,
          attendee_email: a.email,
          notes: a.notes,
        })
        .select()
        .single();
      if (error) throw new Error(`save appointment: ${error.message}`);
      if (a.email) await db().from("customers").update({ email: a.email }).eq("id", ctx.customer.id);
      return { ok: true, appointment_id: appt.id, confirmed_time: check.slot.label, meet_link: link };
    },
  }),

  get_customer_appointments: tool({
    description: "List this customer's upcoming confirmed appointments with their ids.",
    schema: z.object({}),
    handler: async (_a, ctx) => {
      const { data } = await db()
        .from("appointments")
        .select("id, service, starts_at")
        .eq("customer_id", ctx.customer.id)
        .eq("status", "confirmed")
        .gte("starts_at", new Date().toISOString())
        .order("starts_at");
      return {
        ok: true,
        appointments: (data ?? []).map((r) => ({ id: r.id, service: r.service, time: friendly(new Date(r.starts_at), businessTz()) })),
      };
    },
  }),

  reschedule_appointment: tool({
    description: "Move an existing appointment to a new slot returned by check_availability.",
    schema: z.object({
      appointment_id: z.string().describe("id from UPCOMING APPOINTMENTS or get_customer_appointments"),
      new_slot_start: z.string().describe("The exact `start` value of the new slot (ISO 8601)"),
    }),
    handler: async (a, ctx) => {
      const appt = await ownAppointment(a.appointment_id, ctx);
      if (!appt?.gcal_event_id) return { ok: false, error: "not_found", message: "No upcoming appointment with that id for this customer." };
      const check = await checkSlot(a.new_slot_start, appt.gcal_event_id);
      if (!check.ok) {
        return { ok: false, error: check.reason, message: "That new time isn't available.", alternatives: await alternativesNear(a.new_slot_start) };
      }
      await moveEvent(appt.gcal_event_id, check.slot.start, check.slot.end);
      await db()
        .from("appointments")
        .update({ starts_at: check.slot.start, ends_at: check.slot.end, updated_at: new Date().toISOString() })
        .eq("id", appt.id);
      return { ok: true, old_time: friendly(new Date(appt.starts_at), businessTz()), new_time: check.slot.label, meet_link: appt.meet_link };
    },
  }),

  cancel_appointment: tool({
    description: "Cancel an existing appointment (only after the customer confirmed which one).",
    schema: z.object({ appointment_id: z.string() }),
    handler: async (a, ctx) => {
      const appt = await ownAppointment(a.appointment_id, ctx);
      if (!appt) return { ok: false, error: "not_found", message: "No upcoming appointment with that id for this customer." };
      if (appt.gcal_event_id) await deleteEvent(appt.gcal_event_id);
      await db().from("appointments").update({ status: "cancelled", updated_at: new Date().toISOString() }).eq("id", appt.id);
      return { ok: true, cancelled_time: friendly(new Date(appt.starts_at), businessTz()) };
    },
  }),

  save_customer_fact: tool({
    description:
      "Remember a durable fact about this customer for future chats. Use keys like name, email, company, business_type, interest, preferred_time.",
    schema: z.object({
      key: z.string().describe("snake_case key"),
      value: z.string(),
    }),
    handler: async (a, ctx) => {
      const key = a.key.toLowerCase().trim();
      if (key === "email") {
        a.value = normalizeEmail(a.value);
        if (!EMAIL_RE.test(a.value)) return { ok: false, error: "incomplete_email", message: EMAIL_HELP };
      }
      await db()
        .from("customer_facts")
        .upsert({ customer_id: ctx.customer.id, key, value: a.value, updated_at: new Date().toISOString() }, { onConflict: "customer_id,key" });
      if (key === "name") await db().from("customers").update({ display_name: a.value }).eq("id", ctx.customer.id);
      if (key === "email") await db().from("customers").update({ email: a.value }).eq("id", ctx.customer.id);
      return { ok: true };
    },
  }),

  escalate_to_human: tool({
    description:
      "RARE. Hand this chat to a human: only for complaints about our service, refund/billing disputes, legal threats, a genuinely upset customer, " +
      "or when they ask for a real person. NOT for insults, trolling, or questions you can't answer (use flag_for_team).",
    schema: z.object({ reason: z.string().describe("One line: why a human is needed") }),
    handler: async (a, ctx) => {
      await db()
        .from("conversations")
        .update({ status: "needs_human", handled_by: "human", handoff_reason: a.reason, handed_off_at: new Date().toISOString() })
        .eq("id", ctx.conversationId);
      return {
        ok: true,
        team_available: nextTeamAvailability(),
        message:
          "Escalated. Tell the customer the team will reply here, using team_available for when (e.g. \"today at 9:00 AM EAT\"); if it is \"now\", say usually within the hour. " +
          "Until a team member replies, you keep answering their messages in a limited way.",
      };
    },
  }),

  cancel_handover: tool({
    description: "Use only when a chat was handed to the team and the customer now says they don't need a person any more. You take the chat back.",
    schema: z.object({}),
    handler: async (_a, ctx) => {
      await db()
        .from("conversations")
        .update({ status: "open", handled_by: "ai", handoff_reason: null, handed_off_at: null })
        .eq("id", ctx.conversationId)
        .eq("status", "needs_human"); // never overrides a team member who's actively in the chat
      return { ok: true, message: "Handover cancelled. Carry on helping as normal." };
    },
  }),

  flag_for_team: tool({
    description:
      "Pass a question you can't answer from the KNOWLEDGE BASE to the team, WITHOUT handing over the chat. You keep helping the customer as normal.",
    schema: z.object({ question: z.string().describe("The customer's question, in one line") }),
    handler: async (a, ctx) => {
      const { data } = await db().from("conversations").select("open_question").eq("id", ctx.conversationId).single();
      const merged = data?.open_question ? `${data.open_question}\n• ${a.question}` : `• ${a.question}`;
      await db()
        .from("conversations")
        .update({ open_question: merged.slice(-1000), open_question_at: new Date().toISOString() })
        .eq("id", ctx.conversationId);
      return { ok: true, team_available: nextTeamAvailability(), message: "Flagged. Tell them honestly the team will answer it here (use team_available for when), then keep helping." };
    },
  }),
};

export type ToolName = keyof typeof toolDefs;

/** OpenAI Responses API tool definitions, generated from the zod schemas. */
export const openaiTools: FunctionTool[] = Object.entries(toolDefs).map(([name, t]) => {
  const { $schema, ...parameters } = z.toJSONSchema(t.schema) as Record<string, unknown>;
  return { type: "function", name, description: t.description, parameters, strict: true };
});

/** Run a tool. Never throws: errors come back as data the model can reason about. */
export async function runTool(name: string, rawArgs: string, ctx: ToolContext): Promise<ToolResult> {
  const def = toolDefs[name as ToolName] as ToolDef<z.ZodObject> | undefined;
  if (!def) return { ok: false, error: "unknown_tool", message: `No tool named ${name}` };
  let args: unknown;
  try {
    args = def.schema.parse(JSON.parse(rawArgs || "{}"));
  } catch (err) {
    return { ok: false, error: "bad_arguments", message: String(err).slice(0, 300) };
  }
  try {
    return await def.handler(args as never, ctx);
  } catch (err) {
    console.error(`tool ${name} failed`, { error: String(err) });
    return {
      ok: false,
      error: "temporary_glitch",
      message:
        "A temporary technical hiccup, not a customer problem. Call the same tool once more. If it fails again, tell the customer " +
        "you're having trouble reaching the calendar and ask them to send any message in a minute to try again. Do NOT escalate to a human for this.",
    };
  }
}

