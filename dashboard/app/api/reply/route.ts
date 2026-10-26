import { NextResponse } from "next/server";
import { tasks } from "@trigger.dev/sdk";

/** POST { conversationId, text }: a team member's reply, sent through WhatsApp by the send-human-reply task. */
export async function POST(req: Request) {
  if (!process.env.TRIGGER_SECRET_KEY) {
    return NextResponse.json({ error: "TRIGGER_SECRET_KEY is not set in dashboard/.env.local" }, { status: 500 });
  }
  const { conversationId, text } = (await req.json()) as { conversationId?: string; text?: string };
  if (!conversationId || !text?.trim()) return NextResponse.json({ error: "conversationId and text are required" }, { status: 400 });

  const handle = await tasks.trigger("send-human-reply", { conversationId, text: text.trim() });
  return NextResponse.json({ ok: true, runId: handle.id });
}
