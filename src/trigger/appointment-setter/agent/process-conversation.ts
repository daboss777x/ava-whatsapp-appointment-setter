import { logger } from "@trigger.dev/sdk";
import {
  countAssistantRepliesToday,
  db,
  findConversation,
  getFacts,
  getRecentMessages,
  getUnprocessedCustomerMessages,
  getUpcomingAppointments,
  insertMessage,
} from "../lib/supabase.js";
import { markReadWithTyping, sendText } from "../lib/whatsapp.js";
import { businessMinutesBetween } from "../lib/calendar.js";
import { buildInstructions } from "./prompt.js";
import { runAgentTurn } from "./run-agent-turn.js";

const DAILY_REPLY_CAP = 60;
const AUTO_HANDBACK_WORKING_MINUTES = 120;
const MEDIA_FALLBACK = "I can only read text messages right now. Could you type that out for me?";

export type ProcessResult =
  | { status: "replied"; reply: string; tools: string[]; tokensIn: number; tokensOut: number; hops: number }
  | { status: "skipped"; reason: string };

/**
 * Reply to everything the customer has said since Ava last replied.
 * Reads state from the database rather than trusting the trigger payload, so a debounced
 * or retried run never drops or double-answers a message.
 */
export async function processConversation(conversationId: string, opts: { sendToWhatsApp: boolean }): Promise<ProcessResult> {
  const conv = await findConversation(conversationId);
  if (!conv) return { status: "skipped", reason: "conversation no longer exists (customer was reset)" };
  const customer = conv.customer;

  // Handover states:
  //  - a team member has taken over (pressed Take over, or replied) → Ava stays silent
  //  - Ava escalated but nobody has picked it up yet → Ava keeps covering in "handover" mode
  //  - still nobody after 2 working hours → the chat goes back to Ava automatically
  let mode: "normal" | "handover" | "handed_back" = "normal";
  if (conv.handled_by === "human") {
    if (conv.status !== "needs_human") return { status: "skipped", reason: "a team member is handling this chat" };
    const since = conv.handed_off_at ? new Date(conv.handed_off_at) : new Date();
    if (businessMinutesBetween(since, new Date()) >= AUTO_HANDBACK_WORKING_MINUTES) {
      await db().from("conversations").update({ handled_by: "ai", status: "open", handed_off_at: null }).eq("id", conv.id);
      mode = "handed_back";
    } else {
      mode = "handover";
    }
  }

  const fresh = await getUnprocessedCustomerMessages(conv);
  if (!fresh.length) return { status: "skipped", reason: "no new customer messages" };
  const lastSeenAt = fresh[fresh.length - 1].created_at;

  if ((await countAssistantRepliesToday(customer.id)) >= DAILY_REPLY_CAP) {
    logger.warn("daily reply cap reached", { customerId: customer.id });
    await markProcessed(conv.id, lastSeenAt);
    return { status: "skipped", reason: "daily reply cap reached" };
  }

  const latestWaId = [...fresh].reverse().find((m) => m.wa_message_id)?.wa_message_id;
  if (opts.sendToWhatsApp && latestWaId) await markReadWithTyping(latestWaId);

  // Only media (voice note, image, sticker…) and no text → polite fallback, no LLM call.
  if (fresh.every((m) => !m.body?.trim())) {
    await deliver(conv.id, customer.id, customer.wa_phone, MEDIA_FALLBACK, opts.sendToWhatsApp, {});
    await markProcessed(conv.id, lastSeenAt);
    return { status: "replied", reply: MEDIA_FALLBACK, tools: [], tokensIn: 0, tokensOut: 0, hops: 0 };
  }

  const [facts, appointments, recent] = await Promise.all([
    getFacts(customer.id),
    getUpcomingAppointments(customer.id),
    getRecentMessages(conv.id, 20),
  ]);

  const history = recent
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role === "customer" ? ("user" as const) : ("assistant" as const),
      content:
        m.role === "human_agent"
          ? `[Team member replied]: ${m.body ?? ""}`
          : m.body?.trim() || `[customer sent a ${m.media_type ?? "media"} message]`,
    }));

  const started = Date.now();
  const turn = await runAgentTurn({
    instructions: buildInstructions({ customer, facts, appointments, mode, handoffReason: conv.handoff_reason }),
    history,
    ctx: { customer, conversationId: conv.id },
  });

  await deliver(conv.id, customer.id, customer.wa_phone, turn.reply, opts.sendToWhatsApp, {
    tool_calls: turn.toolCalls.length ? turn.toolCalls : null,
    tokens_in: turn.tokensIn,
    tokens_out: turn.tokensOut,
    model: turn.model,
    latency_ms: Date.now() - started,
  });
  await markProcessed(conv.id, lastSeenAt);

  logger.info("Ava replied", { hops: turn.hops, tools: turn.toolCalls.map((c) => c.name), tokensIn: turn.tokensIn, tokensOut: turn.tokensOut });
  return {
    status: "replied",
    reply: turn.reply,
    tools: turn.toolCalls.map((c) => `${c.name}${c.result.ok ? "" : ` ✗ ${String(c.result.error)}`}`),
    tokensIn: turn.tokensIn,
    tokensOut: turn.tokensOut,
    hops: turn.hops,
  };
}

async function deliver(
  conversationId: string,
  customerId: string,
  phone: string,
  text: string,
  sendToWhatsApp: boolean,
  extra: Record<string, unknown>,
) {
  text = toWhatsAppFormatting(text);
  const waId = sendToWhatsApp ? await sendText(phone, text) : null;
  await insertMessage({ conversation_id: conversationId, customer_id: customerId, role: "assistant", body: text, wa_message_id: waId, ...extra });
}

async function markProcessed(conversationId: string, upTo: string) {
  const { error } = await db().from("conversations").update({ last_processed_at: upTo }).eq("id", conversationId);
  if (error) throw new Error(`mark processed: ${error.message}`);
}

/** Models write Markdown; WhatsApp bolds with single asterisks and has no headings or link syntax. */
export function toWhatsAppFormatting(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "*$1*") // **bold** → *bold*
    .replace(/__(.+?)__/g, "*$1*") // __bold__ → *bold*
    .replace(/^#{1,6}\s+/gm, "") // drop "# " headings
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, "$1: $2"); // [text](url) → text: url
}
