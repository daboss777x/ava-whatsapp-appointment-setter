import { queue, schemaTask } from "@trigger.dev/sdk";
import { z } from "zod";
import { AGENT_ENV, WHATSAPP_ENV, requireEnvs } from "./lib/env.js";
import { processConversation } from "./agent/process-conversation.js";

// One run at a time per customer (the Edge Function passes concurrencyKey = phone);
// different customers each get their own copy of this line and run side by side.
export const inboundQueue = queue({ name: "inbound-per-customer", concurrencyLimit: 1 });

/**
 * Triggered by the Supabase Edge Function for every inbound WhatsApp message, with
 * debounce { key: phone, delay: "6s", mode: "trailing", maxDelay: "30s" } so a burst
 * of messages becomes one run and one reply.
 */
export const handleInboundMessage = schemaTask({
  id: "handle-inbound-message",
  queue: inboundQueue,
  schema: z.object({ conversationId: z.string().uuid() }),
  retry: { maxAttempts: 2 },
  // A normal turn takes 5–20s. Cap it well below the project default so a stalled run
  // can't hold this customer's line (their next messages wait behind it).
  maxDuration: 120,
  run: async ({ conversationId }) => {
    requireEnvs([...AGENT_ENV, ...WHATSAPP_ENV]);
    return processConversation(conversationId, { sendToWhatsApp: true });
  },
});
