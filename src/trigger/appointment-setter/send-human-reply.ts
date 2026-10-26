import { schemaTask } from "@trigger.dev/sdk";
import { z } from "zod";
import { requireEnvs, WHATSAPP_ENV } from "./lib/env.js";
import { db, getConversation, insertMessage } from "./lib/supabase.js";
import { sendText } from "./lib/whatsapp.js";

/** Triggered by the dashboard when a team member types a reply after taking over. */
export const sendHumanReply = schemaTask({
  id: "send-human-reply",
  schema: z.object({ conversationId: z.string().uuid(), text: z.string().min(1).max(4000) }),
  retry: { maxAttempts: 3 },
  run: async ({ conversationId, text }) => {
    requireEnvs(["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", ...WHATSAPP_ENV]);
    const conv = await getConversation(conversationId);
    const waId = await sendText(conv.customer.wa_phone, text);
    await insertMessage({ conversation_id: conv.id, customer_id: conv.customer.id, role: "human_agent", body: text, wa_message_id: waId });
    // A team member is now actively in this chat: Ava stays quiet until it's handed back.
    await db()
      .from("conversations")
      .update({ handled_by: "human", status: "open", open_question: null, open_question_at: null })
      .eq("id", conv.id);
    return { sent: true };
  },
});
