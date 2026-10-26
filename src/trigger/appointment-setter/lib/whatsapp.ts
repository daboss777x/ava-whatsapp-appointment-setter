import { requireEnv } from "./env.js";
import { fetchWithTimeout } from "./http.js";

function graphUrl(path: string) {
  const version = process.env.WHATSAPP_GRAPH_VERSION || "v23.0";
  return `https://graph.facebook.com/${version}/${requireEnv("WHATSAPP_PHONE_NUMBER_ID")}/${path}`;
}

async function post(body: Record<string, unknown>) {
  const res = await fetchWithTimeout(graphUrl("messages"), {
    method: "POST",
    headers: { Authorization: `Bearer ${requireEnv("WHATSAPP_ACCESS_TOKEN")}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", ...body }),
  });
  const json = (await res.json()) as { messages?: { id: string }[]; error?: { message: string; code: number } };
  if (!res.ok) throw new Error(`WhatsApp send failed (${res.status}): ${json.error?.message ?? "unknown"} [code ${json.error?.code}]`);
  return json;
}

/** Send a plain text message. `to` is E.164 with or without the leading "+". Returns Meta's message id. */
export async function sendText(to: string, text: string): Promise<string | null> {
  const json = await post({ recipient_type: "individual", to: to.replace(/^\+/, ""), type: "text", text: { body: text } });
  return json.messages?.[0]?.id ?? null;
}

/** Blue ticks + "typing…" bubble while Ava thinks. Best-effort: never fails the run. */
export async function markReadWithTyping(waMessageId: string): Promise<void> {
  try {
    await post({ status: "read", message_id: waMessageId, typing_indicator: { type: "text" } });
  } catch (err) {
    console.warn("markReadWithTyping failed", { error: String(err) });
  }
}
