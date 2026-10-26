import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

/** POST { conversationId, mode: "human" | "ai" }: take over from Ava, or hand the chat back to her. */
export async function POST(req: Request) {
  const { conversationId, mode } = (await req.json()) as { conversationId?: string; mode?: "human" | "ai" };
  if (!conversationId || (mode !== "human" && mode !== "ai")) {
    return NextResponse.json({ error: "conversationId and mode ('human' | 'ai') are required" }, { status: 400 });
  }
  const update =
    mode === "human"
      ? { handled_by: "human", status: "open" } // a person is actively in the chat: Ava goes quiet
      : // Handing back: Ava starts fresh from now and won't re-answer what the human already handled.
        { handled_by: "ai", status: "open", handoff_reason: null, handed_off_at: null, open_question: null, last_processed_at: new Date().toISOString() };

  const { error } = await supabaseAdmin().from("conversations").update(update).eq("id", conversationId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
