import { schemaTask } from "@trigger.dev/sdk";
import { z } from "zod";
import { AGENT_ENV, requireEnvs } from "./lib/env.js";
import { db, getOrCreateOpenConversation, insertMessage, upsertCustomer } from "./lib/supabase.js";
import { processConversation } from "./agent/process-conversation.js";

/**
 * Dev/test: talk to Ava without WhatsApp. Same database, same agent, real calendar,
 * but the reply is returned instead of sent. Use a fake phone number per test persona.
 *
 * Payload example: { "phone": "+15550000001", "text": "Hi, what do you charge?", "name": "Sam" }
 * Pass "reset": true to wipe that test customer first.
 */
export const simulateMessage = schemaTask({
  id: "simulate-message",
  schema: z.object({
    phone: z.string().regex(/^\+\d{8,15}$/).default("+15550000001"),
    text: z.string().min(1),
    name: z.string().optional(),
    reset: z.boolean().default(false),
  }),
  retry: { maxAttempts: 1 },
  run: async ({ phone, text, name, reset }) => {
    // Google is optional here so Q&A can be tested before calendar is connected; calendar tools fail gracefully.
    requireEnvs(AGENT_ENV.filter((k) => !k.startsWith("GOOGLE_")));
    if (reset) await db().from("customers").delete().eq("wa_phone", phone);

    const customer = await upsertCustomer(phone, name ?? null);
    const conv = await getOrCreateOpenConversation(customer.id);
    await insertMessage({ conversation_id: conv.id, customer_id: customer.id, role: "customer", body: text });

    const result = await processConversation(conv.id, { sendToWhatsApp: false });
    return { conversationId: conv.id, you: text, ...result };
  },
});
