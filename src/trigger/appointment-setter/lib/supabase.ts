import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { requireEnv } from "./env.js";
import { fetchWithTimeout } from "./http.js";

let client: SupabaseClient | null = null;

/** Service-role client: bypasses RLS. Server-side only. */
export function db(): SupabaseClient {
  if (!client) {
    client = createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"), {
      auth: { persistSession: false },
      global: { fetch: (url, init) => fetchWithTimeout(url, init, 15_000) },
    });
  }
  return client;
}

export type Customer = {
  id: string;
  wa_phone: string;
  wa_profile_name: string | null;
  display_name: string | null;
  email: string | null;
  timezone: string;
};

export type Conversation = {
  id: string;
  customer_id: string;
  status: "open" | "closed" | "needs_human";
  handled_by: "ai" | "human";
  handoff_reason: string | null;
  handed_off_at: string | null;
  last_processed_at: string | null;
};

export type Message = {
  id: string;
  role: "customer" | "assistant" | "human_agent" | "system";
  body: string | null;
  wa_message_id: string | null;
  media_type: string | null;
  created_at: string;
};

export type Appointment = {
  id: string;
  service: string | null;
  starts_at: string;
  ends_at: string;
  meet_link: string | null;
  attendee_email: string | null;
  gcal_event_id: string | null;
  status: string;
};

function unwrap<T>(res: { data: T | null; error: { message: string } | null }, what: string): T {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  return res.data as T;
}

export async function upsertCustomer(waPhone: string, profileName: string | null): Promise<Customer> {
  const row: Record<string, unknown> = { wa_phone: waPhone, last_seen_at: new Date().toISOString() };
  if (profileName) row.wa_profile_name = profileName;
  return unwrap(
    await db().from("customers").upsert(row, { onConflict: "wa_phone" }).select().single(),
    "upsert customer",
  );
}

/** The customer's current non-closed conversation, or a new one. */
export async function getOrCreateOpenConversation(customerId: string): Promise<Conversation> {
  const existing = unwrap(
    await db()
      .from("conversations")
      .select("*")
      .eq("customer_id", customerId)
      .neq("status", "closed")
      .order("opened_at", { ascending: false })
      .limit(1),
    "find conversation",
  ) as Conversation[];
  if (existing.length) return existing[0];
  return unwrap(
    await db().from("conversations").insert({ customer_id: customerId }).select().single(),
    "create conversation",
  );
}

/** Like getConversation, but null if it no longer exists (e.g. the customer was reset). */
export async function findConversation(conversationId: string): Promise<(Conversation & { customer: Customer }) | null> {
  return unwrap(
    await db().from("conversations").select("*, customer:customers(*)").eq("id", conversationId).maybeSingle(),
    "load conversation",
  );
}

export async function getConversation(conversationId: string): Promise<Conversation & { customer: Customer }> {
  return unwrap(
    await db().from("conversations").select("*, customer:customers(*)").eq("id", conversationId).single(),
    "load conversation",
  );
}

export async function insertMessage(row: Record<string, unknown>): Promise<Message> {
  const msg = unwrap(await db().from("messages").insert(row).select().single(), "insert message") as Message;
  await db()
    .from("conversations")
    .update({ last_message_at: msg.created_at })
    .eq("id", row.conversation_id as string);
  return msg;
}

export async function getUnprocessedCustomerMessages(conv: Conversation): Promise<Message[]> {
  let q = db()
    .from("messages")
    .select("*")
    .eq("conversation_id", conv.id)
    .eq("role", "customer")
    .order("created_at", { ascending: true });
  if (conv.last_processed_at) q = q.gt("created_at", conv.last_processed_at);
  return unwrap(await q, "load new messages") as Message[];
}

export async function getRecentMessages(conversationId: string, limit = 20): Promise<Message[]> {
  const rows = unwrap(
    await db()
      .from("messages")
      .select("*")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false })
      .limit(limit),
    "load history",
  ) as Message[];
  return rows.reverse();
}

export async function countAssistantRepliesToday(customerId: string): Promise<number> {
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const res = await db()
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("customer_id", customerId)
    .eq("role", "assistant")
    .gte("created_at", since);
  if (res.error) throw new Error(`count replies: ${res.error.message}`);
  return res.count ?? 0;
}

export async function getFacts(customerId: string): Promise<{ key: string; value: string }[]> {
  return unwrap(
    await db().from("customer_facts").select("key, value").eq("customer_id", customerId).order("key"),
    "load facts",
  );
}

export async function getUpcomingAppointments(customerId: string): Promise<Appointment[]> {
  return unwrap(
    await db()
      .from("appointments")
      .select("*")
      .eq("customer_id", customerId)
      .eq("status", "confirmed")
      .gte("starts_at", new Date().toISOString())
      .order("starts_at"),
    "load appointments",
  );
}
