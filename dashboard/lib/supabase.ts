import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let browserClient: SupabaseClient | null = null;

/** Browser client (anon key). Read-only under the demo RLS policies. */
export function supabaseBrowser(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) throw new Error("NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY are not set in dashboard/.env.local");
  return (browserClient ??= createClient(url, anon));
}

/** Server-only client (service role). Only import from API routes. */
export function supabaseAdmin(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set in dashboard/.env.local");
  return createClient(url, key, { auth: { persistSession: false } });
}

export type Conversation = {
  id: string;
  status: "open" | "closed" | "needs_human";
  handled_by: "ai" | "human";
  handoff_reason: string | null;
  open_question: string | null; // a question Ava flagged for the team (she keeps helping)
  last_message_at: string;
  customer: { id: string; wa_phone: string; wa_profile_name: string | null; display_name: string | null; email: string | null };
};

export type ToolCall = { name: string; args: Record<string, unknown>; result: { ok: boolean; [k: string]: unknown } };

export type Message = {
  id: string;
  conversation_id: string;
  role: "customer" | "assistant" | "human_agent" | "system";
  body: string | null;
  media_type: string | null;
  tool_calls: ToolCall[] | null;
  tokens_in: number | null;
  tokens_out: number | null;
  latency_ms: number | null;
  created_at: string;
};
