"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabaseBrowser, type Conversation, type Message, type ToolCall } from "@/lib/supabase";

const TZ = process.env.NEXT_PUBLIC_BUSINESS_TIMEZONE || "Africa/Nairobi";
const TZ_LABEL = process.env.NEXT_PUBLIC_BUSINESS_TZ_LABEL || "EAT";
const timeFmt = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: TZ });
const dayFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: TZ });

function customerName(c: Conversation["customer"]) {
  return c.display_name || c.wa_profile_name || c.wa_phone;
}

function relative(iso: string) {
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  if (mins < 24 * 60) return `${Math.round(mins / 60)}h`;
  return dayFmt.format(new Date(iso));
}

/** One plain-English line per tool call, for the transcript. */
function describeTool(t: ToolCall): string {
  const r = t.result as Record<string, unknown>;
  const a = (t.args ?? {}) as Record<string, unknown>;
  if (!t.result.ok) return `${t.name.replaceAll("_", " ")} failed: ${String(r.error ?? "error")}`;
  switch (t.name) {
    case "check_availability": {
      const n = Array.isArray(r.slots) ? r.slots.length : 0;
      return `Checked calendar ${a.start_date}${a.end_date !== a.start_date ? ` → ${a.end_date}` : ""}${a.part_of_day && a.part_of_day !== "any" ? ` (${a.part_of_day})` : ""}: ${n} free`;
    }
    case "book_appointment":
      return `Booked ${a.service}: ${r.confirmed_time}`;
    case "reschedule_appointment":
      return `Moved ${r.old_time} → ${r.new_time}`;
    case "cancel_appointment":
      return `Cancelled ${r.cancelled_time}`;
    case "save_customer_fact":
      return `Remembered ${a.key}: ${a.value}`;
    case "get_customer_appointments":
      return "Looked up their appointments";
    case "escalate_to_human":
      return `Escalated: ${a.reason}`;
    case "flag_for_team":
      return `Question for team: ${a.question}`;
    default:
      return t.name;
  }
}

function toolTone(t: ToolCall) {
  if (!t.result.ok) return "bg-red-50 text-red-700 ring-red-200";
  if (["book_appointment", "reschedule_appointment", "cancel_appointment"].includes(t.name)) return "bg-emerald-50 text-emerald-800 ring-emerald-200";
  if (t.name === "escalate_to_human") return "bg-amber-50 text-amber-800 ring-amber-200";
  if (t.name === "flag_for_team") return "bg-violet-50 text-violet-800 ring-violet-200";
  return "bg-slate-100 text-slate-600 ring-slate-200";
}

type InboxCache = { conversations: Conversation[]; lastMessage: Record<string, Message>; selectedId: string | null; messages: Message[] };
const CACHE_KEY = "ava-inbox-v1";

function readCache(): InboxCache | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? (JSON.parse(raw) as InboxCache) : null;
  } catch {
    return null;
  }
}

function writeCache(c: InboxCache) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(c));
  } catch {
    /* storage full or blocked: cache is only a speed-up */
  }
}

export default function Inbox() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [lastMessage, setLastMessage] = useState<Record<string, Message>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loaded, setLoaded] = useState(false); // true once we have something real to show (cache or server)
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selectedId;
  const knownIds = useRef<Set<string>>(new Set());
  knownIds.current = new Set(conversations.map((c) => c.id));

  // One round trip: every conversation with its customer and only its newest message.
  const loadConversations = useCallback(async () => {
    try {
      const { data, error } = await supabaseBrowser()
        .from("conversations")
        .select(
          "id, status, handled_by, handoff_reason, open_question, last_message_at, customer:customers(id, wa_phone, wa_profile_name, display_name, email), latest:messages(id, conversation_id, role, body, media_type, created_at)",
        )
        .order("last_message_at", { ascending: false })
        .order("created_at", { referencedTable: "messages", ascending: false })
        .limit(1, { referencedTable: "messages" })
        .limit(100);
      if (error) throw error;
      const rows = (data ?? []) as unknown as (Conversation & { latest: Message[] })[];
      const latest: Record<string, Message> = {};
      for (const r of rows) if (r.latest?.[0]) latest[r.id] = r.latest[0];
      setConversations(rows.map(({ latest: _l, ...c }) => c));
      setLastMessage(latest);
      setSelectedId((cur) => cur ?? rows[0]?.id ?? null);
      setLoaded(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setLoaded(true);
    }
  }, []);

  const loadMessages = useCallback(async (id: string) => {
    const { data, error } = await supabaseBrowser().from("messages").select("*").eq("conversation_id", id).order("created_at");
    if (error) setError(error.message);
    else if (selectedRef.current === id) setMessages((data ?? []) as Message[]);
  }, []);

  // Paint instantly from the last session's cache, then refresh from the server in parallel.
  useEffect(() => {
    const cached = readCache();
    if (cached) {
      setConversations(cached.conversations);
      setLastMessage(cached.lastMessage);
      setSelectedId(cached.selectedId);
      setMessages(cached.messages);
      setLoaded(true);
    }
    loadConversations();
    let sb;
    try {
      sb = supabaseBrowser();
    } catch {
      return;
    }
    const channel = sb
      .channel("inbox")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages" }, (payload) => {
        const m = payload.new as Message;
        if (!knownIds.current.has(m.conversation_id)) return void loadConversations(); // brand-new chat
        setLastMessage((prev) => ({ ...prev, [m.conversation_id]: m }));
        setConversations((prev) =>
          [...prev.map((c) => (c.id === m.conversation_id ? { ...c, last_message_at: m.created_at } : c))].sort(
            (a, b) => Date.parse(b.last_message_at) - Date.parse(a.last_message_at),
          ),
        );
        if (m.conversation_id === selectedRef.current) setMessages((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m]));
      })
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "conversations" }, (payload) => {
        const u = payload.new as Partial<Conversation> & { id: string };
        setConversations((prev) =>
          prev.map((c) =>
            c.id === u.id ? { ...c, status: u.status ?? c.status, handled_by: u.handled_by ?? c.handled_by, handoff_reason: u.handoff_reason ?? null, open_question: u.open_question ?? null } : c,
          ),
        );
      })
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "conversations" }, () => loadConversations())
      .on("postgres_changes", { event: "DELETE", schema: "public", table: "conversations" }, (payload) => {
        // A customer typed the reset keyword: drop their chat from the inbox straight away.
        const goneId = (payload.old as { id?: string }).id;
        if (!goneId) return void loadConversations();
        setConversations((prev) => prev.filter((c) => c.id !== goneId));
        if (selectedRef.current === goneId) {
          setSelectedId(null);
          setMessages([]);
        }
      })
      .subscribe((status) => {
        setLive(status === "SUBSCRIBED");
        if (status === "SUBSCRIBED") loadConversations(); // catch anything missed while (re)connecting
      });
    return () => {
      sb.removeChannel(channel);
    };
  }, [loadConversations]);

  useEffect(() => {
    if (selectedId) loadMessages(selectedId);
  }, [selectedId, loadMessages]);

  // Keep the cache fresh so the next reload paints instantly.
  useEffect(() => {
    if (loaded) writeCache({ conversations, lastMessage, selectedId, messages });
  }, [loaded, conversations, lastMessage, selectedId, messages]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  const selected = useMemo(() => conversations.find((c) => c.id === selectedId) ?? null, [conversations, selectedId]);
  const needsHuman = conversations.filter((c) => c.status === "needs_human").length;

  async function setMode(mode: "human" | "ai") {
    if (!selected) return;
    setBusy(true);
    setError(null);
    const res = await fetch("/api/takeover", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ conversationId: selected.id, mode }) });
    if (!res.ok) setError((await res.json()).error ?? "Couldn't update the conversation");
    await loadConversations();
    setBusy(false);
  }

  async function sendReply(e: React.FormEvent) {
    e.preventDefault();
    if (!selected || !draft.trim()) return;
    setBusy(true);
    setError(null);
    const res = await fetch("/api/reply", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ conversationId: selected.id, text: draft }) });
    if (res.ok) setDraft("");
    else setError((await res.json()).error ?? "Couldn't send the reply");
    setBusy(false);
  }

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center justify-between border-b border-slate-200 bg-white px-5 py-3">
        <div className="flex items-baseline gap-3">
          <h1 className="text-lg font-semibold tracking-tight">Ava Inbox</h1>
          <span className="text-sm text-slate-500">Northbeam Advisory · WhatsApp</span>
        </div>
        <div className="flex items-center gap-4 text-sm">
          {needsHuman > 0 && (
            <span className="rounded-full bg-red-600 px-2.5 py-0.5 text-xs font-semibold text-white">{needsHuman} need a human</span>
          )}
          <span className="flex items-center gap-2 text-slate-500">
            <span className={`h-2 w-2 rounded-full ${live ? "bg-emerald-500 animate-pulse" : "bg-slate-300"}`} />
            {live ? "Live" : "Connecting…"}
          </span>
        </div>
      </header>

      {error && <div className="border-b border-red-200 bg-red-50 px-5 py-2 text-sm text-red-700">{error}</div>}

      <div className="flex min-h-0 flex-1">
        {/* Conversation list */}
        <aside className="w-80 shrink-0 overflow-y-auto border-r border-slate-200 bg-white">
          {!loaded && <p className="p-6 text-sm text-slate-400">Loading conversations…</p>}
          {loaded && conversations.length === 0 && (
            <p className="p-6 text-sm text-slate-500">No conversations yet. Message the WhatsApp number and it'll appear here.</p>
          )}
          {conversations.map((c) => {
            const last = lastMessage[c.id];
            const active = c.id === selectedId;
            return (
              <button
                key={c.id}
                onClick={() => {
                  if (c.id !== selectedId) setMessages([]);
                  setSelectedId(c.id);
                }}
                className={`flex w-full flex-col gap-1 border-b border-slate-100 px-4 py-3 text-left transition-colors ${active ? "bg-blue-50" : "hover:bg-slate-50"}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-medium">{customerName(c.customer)}</span>
                  <span className="shrink-0 text-xs tabular-nums text-slate-400">{relative(c.last_message_at)}</span>
                </div>
                <p className="truncate text-sm text-slate-500">
                  {last ? `${last.role === "customer" ? "" : last.role === "assistant" ? "Ava: " : "Team: "}${last.body ?? `[${last.media_type}]`}` : "…"}
                </p>
                <div className="flex gap-1.5">
                  {c.status === "needs_human" && <span className="rounded bg-red-100 px-1.5 py-0.5 text-[11px] font-semibold text-red-700">NEEDS HUMAN · AVA COVERING</span>}
                  {c.handled_by === "human" && c.status !== "needs_human" && (
                    <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-semibold text-amber-800">TEAM HANDLING</span>
                  )}
                  {c.handled_by === "ai" && <span className="rounded bg-blue-100 px-1.5 py-0.5 text-[11px] font-semibold text-blue-700">AVA</span>}
                  {c.open_question && <span className="rounded bg-violet-100 px-1.5 py-0.5 text-[11px] font-semibold text-violet-700">QUESTION FOR TEAM</span>}
                </div>
              </button>
            );
          })}
        </aside>

        {/* Transcript */}
        <main className="flex min-w-0 flex-1 flex-col">
          {selected ? (
            <>
              <div className="flex items-center justify-between gap-4 border-b border-slate-200 bg-white px-5 py-3">
                <div className="min-w-0">
                  <p className="truncate font-semibold">{customerName(selected.customer)}</p>
                  <p className="truncate text-xs text-slate-500">
                    {selected.customer.wa_phone}
                    {selected.customer.email ? ` · ${selected.customer.email}` : ""}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  {!(selected.handled_by === "human" && selected.status !== "needs_human") && (
                    <button onClick={() => setMode("human")} disabled={busy} className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50">
                      Take over
                    </button>
                  )}
                  {selected.handled_by === "human" && (
                    <button onClick={() => setMode("ai")} disabled={busy} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50">
                      {selected.status === "needs_human" ? "Dismiss & hand back" : "Hand back to Ava"}
                    </button>
                  )}
                </div>
              </div>

              {selected.status === "needs_human" && selected.handoff_reason && (
                <div className="border-b border-red-200 bg-red-50 px-5 py-2 text-sm text-red-800">
                  <span className="font-semibold">Ava escalated:</span> {selected.handoff_reason}{" "}
                  <span className="text-red-600">Ava is covering until you take over or reply. It goes back to her after 2 working hours.</span>
                </div>
              )}
              {selected.open_question && (
                <div className="whitespace-pre-line border-b border-violet-200 bg-violet-50 px-5 py-2 text-sm text-violet-900">
                  <span className="font-semibold">Question for the team</span> (Ava is still chatting; reply here to answer it):{"\n"}
                  {selected.open_question}
                </div>
              )}

              <div className="flex-1 space-y-3 overflow-y-auto px-5 py-5">
                {messages.map((m) => {
                  const mine = m.role !== "customer";
                  return (
                    <div key={m.id} className={`flex flex-col ${mine ? "items-end" : "items-start"}`}>
                      {m.tool_calls?.length ? (
                        <div className="mb-1.5 flex max-w-[75%] flex-wrap justify-end gap-1.5">
                          {m.tool_calls.map((t, i) => (
                            <span key={i} className={`rounded-md px-2 py-0.5 font-mono text-[11px] ring-1 ${toolTone(t)}`}>
                              {describeTool(t)}
                            </span>
                          ))}
                        </div>
                      ) : null}
                      <div
                        className={`max-w-[75%] whitespace-pre-wrap rounded-2xl px-4 py-2 text-[15px] leading-snug shadow-sm ${
                          m.role === "customer"
                            ? "rounded-bl-sm bg-white"
                            : m.role === "assistant"
                              ? "rounded-br-sm bg-blue-600 text-white"
                              : "rounded-br-sm bg-emerald-600 text-white"
                        }`}
                      >
                        {m.body ?? <em className="opacity-70">[{m.media_type} message]</em>}
                      </div>
                      <span className="mt-1 text-[11px] tabular-nums text-slate-400">
                        {m.role === "assistant" ? "Ava · " : m.role === "human_agent" ? "Team · " : ""}
                        {timeFmt.format(new Date(m.created_at))} {TZ_LABEL}
                        {m.role === "assistant" && m.latency_ms ? ` · ${(m.latency_ms / 1000).toFixed(1)}s` : ""}
                      </span>
                    </div>
                  );
                })}
                <div ref={bottomRef} />
              </div>

              {selected.handled_by === "human" ? (
                <form onSubmit={sendReply} className="flex gap-2 border-t border-slate-200 bg-white p-3">
                  <input
                    id="reply"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    placeholder="Reply as the team. Sends on WhatsApp."
                    className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-[15px] outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"
                  />
                  <button type="submit" disabled={busy || !draft.trim()} className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50">
                    Send
                  </button>
                </form>
              ) : (
                <div className="border-t border-slate-200 bg-white px-5 py-3 text-sm text-slate-500">Ava is handling this chat. Press Take over to reply yourself.</div>
              )}
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center text-slate-400">Select a conversation</div>
          )}
        </main>
      </div>
    </div>
  );
}
