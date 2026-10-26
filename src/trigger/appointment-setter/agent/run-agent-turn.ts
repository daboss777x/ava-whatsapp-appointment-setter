import OpenAI from "openai";
import type { ResponseInputItem } from "openai/resources/responses/responses";
import { requireEnv } from "../lib/env.js";
import { openaiTools, runTool, type ToolContext, type ToolResult } from "./tools.js";

const MAX_HOPS = 6;

let client: OpenAI | null = null;
const openai = () => (client ??= new OpenAI({ apiKey: requireEnv("OPENAI_API_KEY"), timeout: 45_000, maxRetries: 1 }));

export type ToolCallLog = { name: string; args: unknown; result: ToolResult };
export type AgentTurn = { reply: string; toolCalls: ToolCallLog[]; tokensIn: number; tokensOut: number; model: string; hops: number };

const CLAIMS_BOOKING = /\b(booked|rescheduled|moved it|you're all set|you are all set|confirmed for|cancell?ed)\b/i;
const BOOKING_TOOLS = new Set(["book_appointment", "reschedule_appointment", "cancel_appointment"]);

/**
 * One Ava turn: the Responses API loop with tool calls.
 * `history` is the conversation so far, oldest first, already mapped to user/assistant roles.
 */
export async function runAgentTurn(opts: {
  instructions: string;
  history: { role: "user" | "assistant"; content: string }[];
  ctx: ToolContext;
}): Promise<AgentTurn> {
  const model = process.env.OPENAI_MODEL || "gpt-6-luna";
  const input: ResponseInputItem[] = opts.history.map((m) => ({ role: m.role, content: m.content }));
  const toolCalls: ToolCallLog[] = [];
  let tokensIn = 0;
  let tokensOut = 0;
  let guardUsed = false;

  for (let hop = 1; hop <= MAX_HOPS; hop++) {
    const res = await openai().responses.create({
      model,
      instructions: opts.instructions,
      input,
      tools: openaiTools,
      parallel_tool_calls: false, // booking steps depend on each other; keep them in order
    });
    tokensIn += res.usage?.input_tokens ?? 0;
    tokensOut += res.usage?.output_tokens ?? 0;
    input.push(...(res.output as ResponseInputItem[]));

    const calls = res.output.filter((o) => o.type === "function_call");
    if (calls.length === 0) {
      const reply = res.output_text.trim();
      // Guard: never let Ava claim a booking change that didn't actually happen this turn.
      const changed = toolCalls.some((c) => BOOKING_TOOLS.has(c.name) && c.result.ok);
      if (!guardUsed && CLAIMS_BOOKING.test(reply) && !changed) {
        guardUsed = true;
        input.push({
          role: "developer",
          content:
            "Check your last reply: it says something was booked, moved or cancelled, but no booking tool succeeded this turn. " +
            "If you were only describing an appointment already listed in UPCOMING APPOINTMENTS, repeat the reply unchanged. " +
            "If a change is still needed, call the tool now. Otherwise rewrite the reply without claiming the change.",
        });
        continue;
      }
      return { reply, toolCalls, tokensIn, tokensOut, model, hops: hop };
    }

    for (const call of calls) {
      const result = await runTool(call.name, call.arguments, opts.ctx);
      toolCalls.push({ name: call.name, args: safeParse(call.arguments), result });
      input.push({ type: "function_call_output", call_id: call.call_id, output: JSON.stringify(result) });
    }
  }

  console.warn("agent hit hop cap", { hops: MAX_HOPS, tools: toolCalls.map((c) => c.name) });
  return {
    reply: "Sorry, I got a bit tangled there. Let me get someone from the team to follow up with you shortly.",
    toolCalls,
    tokensIn,
    tokensOut,
    model,
    hops: MAX_HOPS,
  };
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
