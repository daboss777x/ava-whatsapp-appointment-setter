import { readFileSync } from "node:fs";
import { join } from "node:path";
import { businessName, businessTz } from "../lib/env.js";
import { RULES, isBusinessOpen, nextTeamAvailability } from "../lib/calendar.js";
import { holidayName } from "../lib/holidays.js";
import { addDays, friendly, tzLabel, weekday, ymdInZone } from "../lib/time.js";
import type { Appointment, Customer } from "../lib/supabase.js";

const PROMPTS_DIR = join(process.cwd(), "src/trigger/appointment-setter/prompts");
const read = (file: string) => readFileSync(join(PROMPTS_DIR, file), "utf8");

const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** A 15-day date table so the model never has to do calendar arithmetic itself. */
function dateTable(tz: string): string {
  const today = ymdInZone(new Date(), tz);
  const rows: string[] = [];
  for (let i = 0; i <= RULES.horizonDays; i++) {
    const d = addDays(today, i);
    const hol = holidayName(d);
    const open = hol ? ` (closed: ${hol})` : RULES.workdays.includes(weekday(d)) ? "" : " (closed)";
    rows.push(`${DAY[weekday(d)]} ${d}${i === 0 ? " (today)" : i === 1 ? " (tomorrow)" : ""}${open}`);
  }
  return rows.join("\n");
}

/** Extra rules while a chat is (or was) handed to the team. */
function handoverBlock(mode: string | undefined, reason: string | null | undefined): string {
  if (mode === "handover") {
    return `
HANDOVER IN PROGRESS
This chat was passed to the team because: ${reason ?? "the customer needs a person"}. No team member has replied yet, so you are covering until they do.
- Don't try to resolve that topic yourself, and don't promise outcomes. If they bring it up, acknowledge it briefly and say the team has it.
- Don't repeat when the team will reply in every message. Say it once; after that only mention it if they ask "when?". Respond to what they actually said each time, in fresh words.
- Still help with anything else as normal: questions, booking, rescheduling.
- Don't call escalate_to_human again. If they say they no longer need a person ("forget it", "never mind the human"), call cancel_handover and carry on normally.
`;
  }
  if (mode === "handed_back") {
    return `
NOTE: earlier this chat was passed to the team (${reason ?? "the customer needed a person"}), but nobody could pick it up in time. Apologise briefly for the wait, help as normal, and if they still need the team for that, use flag_for_team.
`;
  }
  return "";
}

export function buildInstructions(ctx: {
  customer: Customer;
  facts: { key: string; value: string }[];
  appointments: Appointment[];
  mode?: "normal" | "handover" | "handed_back";
  handoffReason?: string | null;
}): string {
  const tz = businessTz();
  const fill = (s: string) => s.replaceAll("{{BUSINESS_NAME}}", businessName()).replaceAll("{{TZ}}", tzLabel(tz));
  const identity = fill(read("identity.md"));
  const sops = fill(read("sops.md"));
  const knowledge = fill(read("knowledge.md"));

  const back = nextTeamAvailability();
  const teamStatus = isBusinessOpen()
    ? `TEAM STATUS: the team is in the office ${back} and normally replies within the hour.`
    : `TEAM STATUS: the team is out of office. They're back ${back}. When you tell a customer when the team will reply, use exactly that ("${back}"), never vague words like "this morning" or "soon".`;

  const name = ctx.customer.display_name || ctx.customer.wa_profile_name || "unknown";
  const facts = ctx.facts.length ? ctx.facts.map((f) => `- ${f.key}: ${f.value}`).join("\n") : "- none yet";
  const appts = ctx.appointments.length
    ? ctx.appointments
        .map((a) => `- id=${a.id} · ${a.service ?? "Call"} · ${friendly(new Date(a.starts_at), tz)} · email ${a.attendee_email ?? "n/a"}`)
        .join("\n")
    : "- none";

  return `${identity}

${sops}

CURRENT CONTEXT
Current date/time: ${friendly(new Date(), tz)} (${tz})
${teamStatus}
Upcoming dates you can refer to:
${dateTable(tz)}

Customer: ${name}${ctx.customer.display_name ? "" : " (WhatsApp profile name, unconfirmed)"} · WhatsApp ${ctx.customer.wa_phone}
Known email: ${ctx.customer.email ?? "none"}
KNOWN FACTS:
${facts}
UPCOMING APPOINTMENTS:
${appts}
${handoverBlock(ctx.mode, ctx.handoffReason)}
KNOWLEDGE BASE (the only source of truth for business facts)
${knowledge}`;
}
