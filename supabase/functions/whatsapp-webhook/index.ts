// The doorman: receives WhatsApp webhooks, verifies them, records the message,
// and asks Trigger.dev to handle it. Must answer Meta fast, so no slow work here.
//
// Deploy:  npx supabase functions deploy whatsapp-webhook --no-verify-jwt
// Secrets: npx supabase secrets set WHATSAPP_APP_SECRET=... WHATSAPP_VERIFY_TOKEN=... TRIGGER_SECRET_KEY=...
// (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically.)

import { createClient } from "npm:@supabase/supabase-js@2";

const env = (k: string) => {
  const v = Deno.env.get(k);
  if (!v) throw new Error(`${k} is not set`);
  return v;
};

const supabase = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

async function validSignature(rawBody: string, header: string | null): Promise<boolean> {
  if (!header?.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env("WHATSAPP_APP_SECRET")), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody)));
  const expected = Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("");
  const given = header.slice("sha256=".length);
  if (given.length !== expected.length) return false;
  let diff = 0; // constant-time compare
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

type WaMessage = { from: string; id: string; timestamp: string; type: string; text?: { body: string }; group_id?: string };
type WaValue = { messages?: WaMessage[]; contacts?: { wa_id: string; profile?: { name?: string } }[] };

async function triggerTask(taskId: string, payload: unknown, phone: string, debounce: Record<string, string> | null, idempotencyKey?: string) {
  const res = await fetch(`${Deno.env.get("TRIGGER_API_URL") ?? "https://api.trigger.dev"}/api/v1/tasks/${taskId}/trigger`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env("TRIGGER_SECRET_KEY")}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      payload,
      options: {
        concurrencyKey: phone, // one run at a time per customer
        ...(debounce ? { debounce } : {}),
        ...(idempotencyKey ? { idempotencyKey, idempotencyKeyTTL: "1h" } : {}),
        tags: [`phone_${phone.replace(/\D/g, "")}`],
      },
    }),
  });
  if (!res.ok) throw new Error(`Trigger.dev trigger (${taskId}) failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
}

function triggerAva(conversationId: string, phone: string) {
  // A burst of texts → one reply.
  return triggerTask("handle-inbound-message", { conversationId }, phone, { key: `inbound-${phone}`, delay: "6s", mode: "trailing", maxDelay: "30s" });
}

async function handleMessage(msg: WaMessage, value: WaValue) {
  if (msg.group_id) return; // ignore group chats
  const phone = `+${msg.from}`;
  const profileName = value.contacts?.find((c) => c.wa_id === msg.from)?.profile?.name ?? null;
  const isText = msg.type === "text";

  // Testing aid: the reset keyword wipes this sender and starts them over as a new customer.
  // The keyword itself is never stored. It only ever resets the sender's own number.
  const resetKeyword = (Deno.env.get("RESET_KEYWORD") ?? "reset_787").toLowerCase();
  if (isText && msg.text?.body?.trim().toLowerCase() === resetKeyword) {
    await triggerTask("reset-customer", { phone }, phone, null, `reset-${msg.id}`); // Meta re-deliveries can't reset twice
    return;
  }

  const { data: customer, error: custErr } = await supabase
    .from("customers")
    .upsert({ wa_phone: phone, ...(profileName ? { wa_profile_name: profileName } : {}), last_seen_at: new Date().toISOString() }, { onConflict: "wa_phone" })
    .select()
    .single();
  if (custErr) throw new Error(`customer: ${custErr.message}`);

  let { data: conv } = await supabase
    .from("conversations")
    .select("*")
    .eq("customer_id", customer.id)
    .neq("status", "closed")
    .order("opened_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!conv) {
    const created = await supabase.from("conversations").insert({ customer_id: customer.id }).select().single();
    if (created.error?.code === "23505") {
      // A simultaneous duplicate delivery opened it first (one open conversation per customer). Use that one.
      const existing = await supabase.from("conversations").select("*").eq("customer_id", customer.id).neq("status", "closed").single();
      if (existing.error) throw new Error(`conversation (after race): ${existing.error.message}`);
      conv = existing.data;
    } else if (created.error) {
      throw new Error(`conversation: ${created.error.message}`);
    } else {
      conv = created.data;
    }
  }

  const receivedAt = new Date(Number(msg.timestamp) * 1000 || Date.now()).toISOString();
  const { data: inserted, error: msgErr } = await supabase
    .from("messages")
    .upsert(
      {
        conversation_id: conv.id,
        customer_id: customer.id,
        role: "customer",
        body: isText ? msg.text?.body ?? "" : null,
        media_type: isText ? null : msg.type,
        wa_message_id: msg.id,
      },
      { onConflict: "wa_message_id", ignoreDuplicates: true },
    )
    .select();
  if (msgErr) throw new Error(`message: ${msgErr.message}`);
  if (!inserted?.length) {
    // Meta re-delivered a message we already stored. Trigger again anyway in case the first
    // attempt failed before reaching Trigger.dev; the task skips if it was already answered.
    // Use the conversation that actually holds the message, not whichever one this copy found.
    const { data: stored } = await supabase.from("messages").select("conversation_id").eq("wa_message_id", msg.id).single();
    await triggerAva(stored?.conversation_id ?? conv.id, phone);
    return;
  }

  await supabase
    .from("conversations")
    .update({ last_message_at: new Date().toISOString(), window_expires_at: new Date(Date.parse(receivedAt) + 24 * 3600_000).toISOString() })
    .eq("id", conv.id);

  // Always pass it on: the task decides whether Ava speaks (normal), covers (escalated, nobody
  // has picked up yet) or stays silent (a team member is actively handling the chat).
  await triggerAva(conv.id, phone);
}

Deno.serve(async (req) => {
  const url = new URL(req.url);

  // Meta's one-time verification handshake when you register the webhook.
  if (req.method === "GET") {
    const ok = url.searchParams.get("hub.mode") === "subscribe" && url.searchParams.get("hub.verify_token") === env("WHATSAPP_VERIFY_TOKEN");
    return ok ? new Response(url.searchParams.get("hub.challenge") ?? "", { status: 200 }) : new Response("Forbidden", { status: 403 });
  }
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const raw = await req.text(); // verify against the raw bytes, before parsing
  if (!(await validSignature(raw, req.headers.get("x-hub-signature-256")))) {
    console.warn("rejected webhook: bad signature");
    return new Response("Invalid signature", { status: 401 });
  }

  try {
    const body = JSON.parse(raw);
    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value: WaValue = change.value ?? {};
        for (const msg of value.messages ?? []) await handleMessage(msg, value); // status updates have no `messages`
      }
    }
    return new Response("ok", { status: 200 });
  } catch (err) {
    // A non-200 makes Meta retry; the unique wa_message_id stops duplicates.
    console.error("webhook processing failed", String(err));
    return new Response("error", { status: 500 });
  }
});
