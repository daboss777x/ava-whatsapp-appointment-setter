# AI Appointment Setter — Build Research & Implementation Spec

**Researched:** 21 October 2026
**Status:** Research only. No code written yet.
**Goal:** A WhatsApp AI agent that answers questions from a knowledge base, checks Google Calendar availability, books/edits appointments, remembers every customer, sends email reminders, and gives the business a dashboard to watch conversations. Hosted on Trigger.dev.

---

## 1. Verdict up front

Your instinct on the stack is good. Supabase is the right memory store. Trigger.dev is the right host. But five things I found during research should change the design before you write a line of code:

| # | Finding | What it changes |
|---|---------|-----------------|
| 1 | **Trigger.dev cannot receive webhooks directly.** The old `defineHttpEndpoint()` was a v2 feature and is gone. In v4 you trigger tasks *from* your own HTTP endpoint. | You need one small public HTTPS endpoint in front of Trigger.dev. **Use a Supabase Edge Function** — you already have Supabase, it's free, and it deploys in one command. |
| 2 | **WhatsApp pricing changed on 1 October 2026 — three weeks ago.** Service messages (your AI's normal replies inside the 24-hour window) used to be free. Now you get **1,000 free service messages per phone number per month**, then you pay per message. | Your per-conversation economics are now real. Budget for it, and cap runaway loops. See §12. |
| 3 | **GPT-6 Astra cannot call tools on the Chat Completions API at all.** Tool calling on current models requires the **Responses API**. | Do not write this against `chat.completions`. Use `client.responses.create()`. Different request/response shape — details in §9. |
| 4 | **Trigger.dev has native `debounce` with a `trailing` mode.** | This solves "customer sends 5 messages in 8 seconds" with zero extra infrastructure. No Redis, no buffer table, no polling. This is the single nicest fit between your problem and the platform. |
| 5 | **Trigger.dev tasks are TypeScript.** Python runs only as a *subprocess* via `@trigger.dev/python`. | Your "scripts" should be **TypeScript**, not Python. See §10 for the honest tradeoff and the Python escape hatch if you still want it. |

---

## 2. Architecture

```
                   ┌──────────────────────────────────────┐
  Customer         │         WhatsApp Cloud API           │
  on WhatsApp ◄───►│            (Meta Graph)              │
                   └───────┬──────────────────▲───────────┘
                           │ webhook POST     │ POST /messages
                           ▼                  │
              ┌────────────────────────┐      │
              │  Supabase Edge Function│      │
              │  `whatsapp-webhook`    │      │
              │  • verify HMAC sig     │      │
              │  • return 200 in <1s   │      │
              │  • insert inbound msg  │      │
              │  • tasks.trigger(...)  │      │
              └───────┬────────────────┘      │
                      │                       │
                      ▼                       │
     ┌────────────────────────────────────────┴──────────────┐
     │                    TRIGGER.DEV                        │
     │                                                       │
     │  handle-inbound-message  (debounce 6s trailing,       │
     │                           concurrencyKey = phone)     │
     │        │                                              │
     │        ├─► load customer + last N turns from Supabase │
     │        ├─► RAG: embed query → match_kb() → context    │
     │        ├─► OpenAI Responses API loop (tools)          │
     │        │     ├ check_availability   → GCal freeBusy   │
     │        │     ├ book_appointment     → GCal insert     │
     │        │     ├ reschedule/cancel    → GCal patch/del  │
     │        │     ├ search_knowledge     → pgvector        │
     │        │     ├ save_customer_fact   → Supabase        │
     │        │     └ escalate_to_human    → Supabase flag   │
     │        ├─► send WhatsApp reply                        │
     │        └─► persist assistant turn + usage             │
     │                                                       │
     │  send-reminder     (scheduled via delay / wait.until) │
     │  rebuild-knowledge (manual / on KB file change)       │
     │  nightly-summary   (cron)                             │
     └───────────────────────┬───────────────────────────────┘
                             │
                             ▼
     ┌───────────────────────────────────────────────────────┐
     │                     SUPABASE                          │
     │  Postgres: customers, conversations, messages,        │
     │            appointments, customer_facts,              │
     │            kb_chunks (pgvector), handoffs             │
     │  Realtime: pushes new rows to the dashboard           │
     │  Auth:     protects the dashboard                     │
     └───────────────────────┬───────────────────────────────┘
                             │ Realtime subscription
                             ▼
     ┌───────────────────────────────────────────────────────┐
     │  Next.js dashboard (Vercel)                           │
     │  live inbox • transcripts • take-over • bookings      │
     └───────────────────────────────────────────────────────┘

     Resend ◄── send-reminder task (email reminders)
```

**Why the Edge Function in front:** Meta requires your webhook to answer within a few seconds or it retries and eventually disables the subscription. The Edge Function does three cheap things (verify signature, write row, fire task) and returns `200` immediately. All the slow work — embeddings, LLM calls, calendar round-trips — happens inside Trigger.dev where there is no timeout.

---

## 3. The stack

| Layer | Choice | Why this one |
|---|---|---|
| Messaging | **WhatsApp Cloud API** (direct with Meta) | No BSP markup. Twilio/360dialog add a per-message fee on top of Meta's. Go direct unless you want Twilio's sandbox for faster day-one testing. |
| Webhook receiver | **Supabase Edge Function** (Deno) | Free, already in your stack, public HTTPS with valid TLS, deploy with `--no-verify-jwt`. |
| Orchestration | **Trigger.dev v4** | Durable runs, no execution timeout, native `debounce`, `concurrencyKey` for per-customer isolation, `wait.until()` for reminders, Realtime for streaming. |
| Brain | **OpenAI Responses API** | Required for tool calling on current models. `gpt-6.1-sol` is the right default (see §9). |
| Memory + KB | **Supabase Postgres + pgvector** | One database for conversation history, structured customer facts, and the vector index. No second system. |
| Calendar | **Google Calendar API v3** | `freeBusy.query` for availability, `events.insert/patch/delete` for booking. |
| Email | **Resend** | 3,000/mo free, React Email templates, clean TS SDK. Do **not** use Gmail API for this — it's rate-limited and not built for app mail. |
| Dashboard | **Next.js + Supabase Realtime** | Realtime pushes new message rows straight to the UI. Supabase Auth gates it. |

---

## 4. Accounts, API keys and secrets

Everything below goes into Trigger.dev environment variables (Dashboard → your project → Environment Variables) and, for the few the Edge Function needs, into Supabase secrets. **Nothing goes in git.**

### 4.1 Meta / WhatsApp

Create at [developers.facebook.com](https://developers.facebook.com) → new app → type **Business** → add the **WhatsApp** product.

| Secret | Where to get it | Notes |
|---|---|---|
| `WHATSAPP_ACCESS_TOKEN` | App → WhatsApp → API Setup | The 24-hour test token is fine for dev. For production generate a **System User token** in Business Settings with `whatsapp_business_messaging` + `whatsapp_business_management` — those don't expire. |
| `WHATSAPP_PHONE_NUMBER_ID` | App → WhatsApp → API Setup | Numeric. This is **not** the phone number. |
| `WHATSAPP_BUSINESS_ACCOUNT_ID` | Same screen | Needed for managing templates. |
| `WHATSAPP_APP_SECRET` | App → Settings → Basic → App Secret | **This is the HMAC key** for verifying webhook signatures. It is not the access token. People get this wrong constantly. |
| `WHATSAPP_VERIFY_TOKEN` | **You invent it.** | A random string. You paste the same value into Meta's webhook config. Its only job is proving the endpoint answering is yours. `openssl rand -hex 32`. |

You will also need to complete **Business Verification** and register a phone number before you can message people who aren't on your test allowlist.

### 4.2 OpenAI

| Secret | Where |
|---|---|
| `OPENAI_API_KEY` | platform.openai.com → API keys. Create a **project-scoped** key so you can track this app's spend separately. |

Set a monthly budget cap in Billing → Limits. Do this on day one.

### 4.3 Google Calendar

**Use OAuth with a refresh token, not a service account.** Service accounts with domain-wide delegation only work if the business runs Google Workspace *and* you're a Workspace admin. For a single business calendar — which is your case — the OAuth refresh-token flow is simpler and works with a plain Gmail account.

1. Google Cloud Console → new project → enable **Google Calendar API**
2. OAuth consent screen → External → add the business owner's email as a test user
3. Credentials → **OAuth client ID** → Web application → add `http://localhost:3000/oauth/callback` as a redirect URI
4. Run a one-time local script with `access_type=offline&prompt=consent` to get a refresh token
5. Store the refresh token; exchange it for access tokens at runtime

| Secret | Notes |
|---|---|
| `GOOGLE_CLIENT_ID` | From step 3 |
| `GOOGLE_CLIENT_SECRET` | From step 3 |
| `GOOGLE_REFRESH_TOKEN` | From step 4. Valid indefinitely unless revoked. |
| `GOOGLE_CALENDAR_ID` | `primary`, or the specific calendar's ID from Calendar Settings |

**Scope:** `https://www.googleapis.com/auth/calendar` (you need write access, so the readonly scope won't do).

> ⚠️ While your OAuth app is in **Testing** status, refresh tokens expire after 7 days. Publish the app (or keep it Internal if on Workspace) before going live, or you'll be re-authorising every week.

### 4.4 Supabase

| Secret | Where | Used by |
|---|---|---|
| `SUPABASE_URL` | Project Settings → API | Everything |
| `SUPABASE_SERVICE_ROLE_KEY` | Project Settings → API | Trigger.dev + Edge Function only. **Never ships to the browser.** Bypasses RLS. |
| `SUPABASE_ANON_KEY` | Project Settings → API | Dashboard frontend only |

### 4.5 Resend

| Secret | Where |
|---|---|
| `RESEND_API_KEY` | resend.com → API Keys |

Verify a sending domain (add the DKIM/SPF DNS records Resend gives you). Reminders from `noreply@yourbusiness.com` land in inboxes; reminders from an unverified domain land in spam.

### 4.6 Trigger.dev

| Secret | Where |
|---|---|
| `TRIGGER_SECRET_KEY` | Trigger.dev dashboard → project → API keys. Used by the Edge Function to trigger tasks. |
| `TRIGGER_PROJECT_REF` | Shown on project setup, goes in `trigger.config.ts` |

---

## 5. Supabase data model

Run this in the Supabase SQL editor. This is the complete schema.

```sql
-- ============ extensions ============
create extension if not exists vector;
create extension if not exists pg_trgm;

-- ============ customers ============
-- One row per WhatsApp phone number. This is the identity anchor.
create table customers (
  id              uuid primary key default gen_random_uuid(),
  wa_phone        text unique not null,          -- E.164, e.g. +2348012345678
  wa_profile_name text,                          -- name WhatsApp reports
  display_name    text,                          -- name the agent learned/confirmed
  email           text,
  timezone        text default 'Africa/Lagos',
  language         text default 'en',
  status          text default 'active'
                  check (status in ('active','blocked','archived')),
  first_seen_at   timestamptz default now(),
  last_seen_at    timestamptz default now(),
  created_at      timestamptz default now()
);
create index on customers (last_seen_at desc);

-- ============ conversations ============
-- A conversation = a continuous stretch of chat. Close one after N days idle
-- so the dashboard doesn't show one infinite thread per customer.
create table conversations (
  id              uuid primary key default gen_random_uuid(),
  customer_id     uuid not null references customers(id) on delete cascade,
  status          text default 'open'
                  check (status in ('open','closed','needs_human')),
  -- when the 24h WhatsApp service window closes. After this you may only
  -- send pre-approved template messages.
  window_expires_at timestamptz,
  handled_by      text default 'ai' check (handled_by in ('ai','human')),
  summary         text,                          -- rolling summary, see §7.3
  opened_at       timestamptz default now(),
  closed_at       timestamptz
);
create index on conversations (customer_id, opened_at desc);
create index on conversations (status) where status != 'closed';

-- ============ messages ============
create table messages (
  id               uuid primary key default gen_random_uuid(),
  conversation_id  uuid not null references conversations(id) on delete cascade,
  customer_id      uuid not null references customers(id) on delete cascade,
  role             text not null
                   check (role in ('customer','assistant','human_agent','system')),
  body             text,
  -- Meta's message id. UNIQUE = your duplicate-delivery guard. Meta retries.
  wa_message_id    text unique,
  media_url        text,
  media_type       text,
  -- audit trail of what the agent did on this turn
  tool_calls       jsonb,
  tokens_in        int,
  tokens_out       int,
  model            text,
  latency_ms       int,
  delivery_status  text,                         -- sent/delivered/read/failed
  created_at       timestamptz default now()
);
create index on messages (conversation_id, created_at);
create index on messages (customer_id, created_at desc);

-- ============ customer_facts ============
-- Long-term memory. Distinct from transcript history: these are durable,
-- structured things the agent learned and should always know.
create table customer_facts (
  id           uuid primary key default gen_random_uuid(),
  customer_id  uuid not null references customers(id) on delete cascade,
  key          text not null,        -- 'preferred_time', 'service_interest', 'referral_source'
  value        text not null,
  confidence   real default 1.0,
  source       text default 'agent', -- 'agent' | 'human' | 'form'
  updated_at   timestamptz default now(),
  unique (customer_id, key)
);

-- ============ appointments ============
create table appointments (
  id                uuid primary key default gen_random_uuid(),
  customer_id       uuid not null references customers(id) on delete cascade,
  conversation_id   uuid references conversations(id) on delete set null,
  gcal_event_id     text unique,       -- so you can patch/delete later
  service           text,
  starts_at         timestamptz not null,
  ends_at           timestamptz not null,
  timezone          text not null,
  location          text,
  meet_link         text,
  attendee_email    text,
  status            text default 'confirmed'
                    check (status in ('confirmed','rescheduled','cancelled','completed','no_show')),
  notes             text,
  reminder_24h_sent boolean default false,
  reminder_1h_sent  boolean default false,
  created_at        timestamptz default now(),
  updated_at        timestamptz default now()
);
create index on appointments (starts_at);
create index on appointments (customer_id, starts_at desc);

-- ============ knowledge base (RAG) ============
create table kb_chunks (
  id          uuid primary key default gen_random_uuid(),
  source_file text not null,            -- 'knowledge.md'
  heading     text,                     -- the markdown heading this chunk sits under
  content     text not null,
  embedding   vector(1536),             -- text-embedding-3-small
  token_count int,
  version     int not null default 1,   -- bump on rebuild, delete old versions after
  created_at  timestamptz default now()
);
create index on kb_chunks using hnsw (embedding vector_cosine_ops)
  with (m = 16, ef_construction = 64);

-- PostgREST can't use pgvector operators directly, so wrap it in a function
-- and call it with .rpc('match_kb', {...}).
create or replace function match_kb (
  query_embedding vector(1536),
  match_threshold float default 0.3,
  match_count     int   default 5
)
returns table (id uuid, heading text, content text, similarity float)
language sql stable
as $$
  select
    kb_chunks.id,
    kb_chunks.heading,
    kb_chunks.content,
    1 - (kb_chunks.embedding <=> query_embedding) as similarity
  from kb_chunks
  where 1 - (kb_chunks.embedding <=> query_embedding) > match_threshold
  order by kb_chunks.embedding <=> query_embedding
  limit match_count;
$$;

-- ============ handoffs ============
-- When the AI gives up or the customer asks for a person.
create table handoffs (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  reason          text not null,
  resolved        boolean default false,
  resolved_by     text,
  created_at      timestamptz default now(),
  resolved_at     timestamptz
);

-- ============ realtime for the dashboard ============
alter publication supabase_realtime add table messages;
alter publication supabase_realtime add table conversations;
alter publication supabase_realtime add table appointments;
alter publication supabase_realtime add table handoffs;
```

**On RLS:** enable Row Level Security on every table. Trigger.dev and the Edge Function use the service-role key (which bypasses RLS). The dashboard uses the anon key plus Supabase Auth, so write a policy like `using (auth.jwt() ->> 'role' = 'staff')` against a `staff` table. Get this right before the dashboard goes live — otherwise anyone with your anon key reads every customer conversation.

---

## 6. Build sequence

Ten phases. Each one ends at something you can actually test.

### Phase 0 — Scaffold
```bash
mkdir appointment-setter && cd appointment-setter
npm init -y
npx trigger.dev@latest init
npm i @trigger.dev/sdk openai @supabase/supabase-js resend googleapis zod
```
Fill in `trigger.config.ts` with your project ref. Verify with `npx trigger.dev@latest dev`.

### Phase 1 — Database
Run the schema from §5. Seed one fake customer and one fake conversation so you have something to query.

### Phase 2 — Knowledge base ingestion
Write `knowledge.md` (see §8.4 for how to structure it so chunking works well). Build a `rebuild-knowledge` Trigger.dev task that:
1. Reads `knowledge.md`
2. Splits on `##` headings; if a section exceeds ~500 tokens, split again on paragraphs with ~50-token overlap
3. Embeds each chunk with `text-embedding-3-small`
4. Inserts with `version = max(version)+1`, then deletes older versions

Test by calling `match_kb()` from the SQL editor with a hand-made embedding. You should get sensible hits before you wire up any chat.

### Phase 3 — Google Calendar tools, in isolation
Before touching WhatsApp, build and unit-test four functions as plain scripts you run with `tsx`:
- `checkAvailability(dateRange)` → `freeBusy.query`, subtract busy blocks from business hours, return bookable slots
- `bookAppointment(slot, customer)` → `events.insert`
- `rescheduleAppointment(eventId, newSlot)` → `events.patch`
- `cancelAppointment(eventId)` → `events.delete`

Get these correct on their own. Timezone bugs here are the single most common failure in appointment bots, and they're far easier to find without an LLM in the loop.

### Phase 4 — The agent loop, via CLI
Build `runAgentTurn(customerId, messages)` and drive it from a terminal script. No WhatsApp yet. Iterate on the system prompt, the SOPs, and the tool definitions until the agent books correctly in a text REPL. **This is where most of your quality comes from — spend real time here.**

### Phase 5 — WhatsApp inbound
Deploy the Supabase Edge Function. Point Meta's webhook at it. Confirm the GET verification handshake, then confirm an inbound message lands in `messages`.

### Phase 6 — Connect the loop
Have the Edge Function trigger `handle-inbound-message` with `debounce` and `concurrencyKey`. The task loads context, runs the agent, sends the reply via the Graph API.

### Phase 7 — Reminders
On booking, schedule `send-reminder` twice with `delay`. Email via Resend; WhatsApp reminder via an approved Utility template.

### Phase 8 — Dashboard
Next.js, Supabase Auth, Realtime subscription on `messages`.

### Phase 9 — Human takeover
A "Take over" button that flips `conversations.handled_by = 'human'`. `handle-inbound-message` checks this first and exits early if a human is driving.

### Phase 10 — Harden
Retries, dead-letter alerting, token budget caps, a daily digest, failure alerts to the owner.

---

## 7. The hard parts, solved

### 7.1 Handling many chatters at once — correctly

You asked for parallel processing. The precise requirement is subtler: **parallel across customers, strictly serial within a customer.** If two runs for the same person execute simultaneously, they read the same history, both reply, and the customer gets two contradictory messages — or worse, two bookings.

Trigger.dev gives you exactly this in one line:

```ts
await tasks.trigger("handle-inbound-message",
  { customerId, conversationId },
  {
    concurrencyKey: customerPhone,   // serial per person
    debounce: {
      key: `inbound:${customerPhone}`,
      delay: "6s",
      mode: "trailing",              // use the LAST trigger's data
      maxDelay: "30s",               // don't let a chatty user delay forever
    },
  }
);
```

- `concurrencyKey` creates a separate queue per phone number. Customer A and Customer B run in parallel; two messages from Customer A run one after the other.
- `debounce` with `mode: "trailing"` collapses a burst. Customer sends "hi" / "i want to book" / "for tuesday" in six seconds → **one** run, **one** LLM call, **one** reply.

Account-wide concurrency is capped by plan: 20 concurrent runs on Free, 50 on Hobby, 200+ on Pro.

> **The debounce+concurrencyKey combination is the main reason Trigger.dev is a better fit here than a plain serverless function.** On Vercel or Lambda you'd be building this yourself with Redis locks.

**Design the task to be idempotent and stateless about *which* message triggered it.** Don't pass message text in the payload. Pass only the conversation id, then have the task read everything since `last_processed_at`. This way a trailing debounce never drops a message, and a retry never double-replies.

### 7.2 Don't let the agent double-book

Two safeguards, both needed:

1. **Re-verify at booking time.** The availability check the agent did 90 seconds ago may be stale. Inside `book_appointment`, call `freeBusy.query` again for that exact slot before inserting. If it's gone, return a tool error listing alternatives, and let the model apologise and re-offer.
2. **Idempotency key on the booking task.** `idempotencyKey: hash(customerId + slotISO)` — if the model fires the tool twice, the second is a no-op.

### 7.3 Conversation context without blowing up cost

Don't send the entire history on every turn. Use three tiers:

| Tier | What | How it's built |
|---|---|---|
| **Profile** | `customers` row + all `customer_facts` | Direct query. Always included. ~100 tokens. |
| **Summary** | `conversations.summary` — a rolling paragraph | Regenerated by a cheap `gpt-6-luna` call every 10 turns |
| **Recent** | Last 10–15 messages verbatim | Direct query |

That keeps each turn around 2–4k input tokens regardless of how long the relationship has run, while the agent still "remembers" a customer from three months ago.

### 7.4 The 24-hour window — the thing that bites everyone

WhatsApp only lets you send free-form messages within **24 hours of the customer's last message**. Outside that window you may send **only pre-approved template messages**.

This matters directly for reminders: an appointment booked today for next Tuesday means Tuesday's reminder falls far outside the window. **You must create and get approval for a Utility template** — submit it in Meta Business Manager, approval typically takes minutes to a few hours.

Store `window_expires_at` on the conversation and branch on it:

```ts
const canSendFreeform = conversation.window_expires_at > new Date();
// if false → send an approved template instead
```

### 7.5 Duplicate webhook deliveries

Meta retries on any non-200 and sometimes delivers twice regardless. The `unique` constraint on `messages.wa_message_id` is your guard — insert with `onConflict: 'wa_message_id', ignoreDuplicates: true` and only trigger the task if a row was actually created.

---

## 8. Giving it a personality and SOPs

Structure the prompt in four layers, each in its own file, each separately editable.

### 8.1 `prompts/identity.md` — who it is

```markdown
You are Ada, the appointment coordinator for {{BUSINESS_NAME}}.

VOICE
- Warm, brief, competent. You sound like a good receptionist, not a chatbot.
- 1–3 sentences per message. This is WhatsApp, not email.
- Plain language. No corporate filler: never "I'd be happy to assist you
  with that today."
- One question at a time. Never stack three questions in one message.
- Light, sparing emoji — at most one, and only when the mood fits. Never in
  a message about a problem.
- Match the customer's register. If they're terse, be terse. If they're
  chatty, warm up a little.

NEVER
- Never invent prices, availability, policies, or services. If it is not in
  your knowledge base or your calendar tools, say you'll check and flag it
  for a human.
- Never claim an appointment is booked until book_appointment returns success.
- Never argue. If a customer is unhappy, acknowledge and escalate.
- Never mention you are an AI unless directly asked. If asked: answer
  honestly and briefly, then carry on.
```

### 8.2 `prompts/sops.md` — how it works

SOPs are decision procedures, not prose. Write them as numbered steps the model can follow literally.

```markdown
## SOP-1 · New enquiry
1. Greet by name if you know it from customer_facts; otherwise ask for it once.
2. Identify what they want. If ambiguous, ask ONE clarifying question.
3. If the question is informational → search_knowledge, answer, then offer
   to book: "Want me to find you a time?"
4. If they want to book → SOP-2.

## SOP-2 · Booking
1. Ask which service, if not already clear.
2. Ask for a rough preference: "Mornings or afternoons? Any day that suits?"
3. check_availability for that window.
4. Offer AT MOST 3 slots, written in the customer's local timezone, in plain
   language: "Tuesday 2pm, Wednesday 10am, or Thursday 4pm?"
5. On confirmation, collect email if you don't have one (needed for the
   calendar invite and reminders).
6. book_appointment. ONLY after it returns success, confirm:
   "Done — Tuesday 14 Nov, 2pm. You'll get an email confirmation."
7. save_customer_fact for anything learned (preferred time, service interest).

## SOP-3 · Reschedule
1. Look up their appointment. If more than one, ask which.
2. Ask what works better.
3. check_availability → offer up to 3 → reschedule_appointment.
4. Confirm the new time explicitly. Never say "moved" without restating
   the new date and time in full.

## SOP-4 · Cancellation
1. Confirm which appointment, in full ("your 2pm on Tuesday the 14th?").
2. Cancel. Do not interrogate them about why.
3. One soft re-book offer, then let it go: "No problem. Want me to find
   another time, or shall I leave it for now?"

## SOP-5 · Out of scope
Triggers: pricing not in the KB, complaints, refunds, medical/legal/financial
advice, anything you are less than confident about.
1. Do not guess. Do not improvise a policy.
2. "Let me get someone from the team to confirm that for you — I'll have
   them message you shortly."
3. Call escalate_to_human with a one-line reason.
4. Stop replying on that topic. You may still help with scheduling.

## SOP-6 · Explicit human request
If they ask for a person at any point: escalate immediately, no friction,
no "are you sure?". One message: "Of course — passing you to the team now."

## SOP-7 · No-reply follow-up
If a customer went quiet mid-booking and the 24h window is still open, send
exactly ONE nudge after ~4 hours. Never a second one.
```

### 8.3 Runtime context block

Injected fresh on every turn:

```
CURRENT CONTEXT
Date/time now: {{NOW_ISO}} ({{BUSINESS_TZ}})
Customer: {{NAME}} · {{PHONE}} · timezone {{CUSTOMER_TZ}}
Known facts:
{{FACTS}}
Upcoming appointments:
{{APPOINTMENTS}}
Conversation summary so far:
{{SUMMARY}}
```

> The date line is not optional. Without it the model will cheerfully offer "next Tuesday" based on its training cutoff and book someone into the past.

### 8.4 `knowledge.md` — write it for chunking

Your KB file retrieves far better if you write it as self-contained Q&A-ish sections under clear `##` headings. Each chunk gets retrieved alone, without its neighbours, so each must stand on its own.

```markdown
## What services do you offer?
We offer three: a 30-minute initial consultation (free), a 60-minute
strategy session (₦45,000), and ongoing monthly retainers (from ₦250,000).

## What are your opening hours?
Monday to Friday, 9am–6pm WAT. Closed weekends and Nigerian public holidays.
Last booking slot each day is 5pm.

## Where are you located?
17 Admiralty Way, Lekki Phase 1, Lagos. Consultations can also be held over
Google Meet — say which you prefer when booking.

## What is your cancellation policy?
Cancel or reschedule free up to 24 hours before. Inside 24 hours we charge
50% of the session fee.
```

Avoid: one giant wall of prose, tables that split mid-chunk, or `##` sections longer than ~400 words.

---

## 9. The OpenAI integration

### 9.1 Model choice

Current lineup (verified on OpenAI's docs, Oct 2026):

| Model | Input / Output per 1M | Use it for |
|---|---|---|
| `gpt-6-astra` | $10 / $50 | Overkill here. Reserve for escalation analysis if ever. |
| **`gpt-6.1-sol`** | **$2 / $10** | **Your main conversational agent.** Near-flagship quality, tool calling, 1.05M context. |
| `gpt-6-luna` | $0.10 / $0.50 | Rolling summaries, intent classification, the nightly digest. |
| `text-embedding-3-small` | $0.02 | KB chunks and query embeddings. 1536 dims. |

Start on `gpt-6.1-sol`. If replies are good but slow or costly, test `gpt-6-luna` on simple turns and route the hard ones up.

### 9.2 Use the Responses API

**GPT-6 Astra cannot call tools on Chat Completions at all**, and since GPT-5.4 Chat Completions only runs tool calls with reasoning off. Tool calling on current models means `client.responses.create()`.

Tool definitions are **internally tagged** here — flatter than the Chat Completions shape:

```ts
const tools = [{
  type: "function",
  name: "check_availability",
  description: "Find bookable appointment slots in a date range.",
  parameters: {
    type: "object",
    properties: {
      start_date: { type: "string", description: "ISO date, inclusive" },
      end_date:   { type: "string", description: "ISO date, inclusive" },
      duration_minutes: { type: "integer" },
    },
    required: ["start_date", "end_date", "duration_minutes"],
    additionalProperties: false,
  },
  strict: true,
}];
```

With `strict: true` (the default on Responses), every property must be listed in `required` and `additionalProperties` must be `false`. For a genuinely optional field use a nullable type: `{ type: ["string", "null"] }`.

The loop:

```ts
let input = [...history, { role: "user", content: latestText }];

for (let hop = 0; hop < 6; hop++) {
  const res = await client.responses.create({
    model: "gpt-6.1-sol",
    instructions: systemPrompt,
    tools,
    input,
  });

  input = [...input, ...res.output];

  const calls = res.output.filter((o) => o.type === "function_call");
  if (calls.length === 0) {
    return res.output_text;           // final reply to the customer
  }

  // Independent tool calls can run in parallel
  const results = await Promise.all(
    calls.map(async (c) => ({
      type: "function_call_output",
      call_id: c.call_id,
      output: JSON.stringify(await runTool(c.name, JSON.parse(c.arguments))),
    }))
  );
  input.push(...results);
}
```

Cap the hops. A model stuck in a tool loop will burn your budget quietly.

### 9.3 Tool errors are messages, not exceptions

Never throw out of `runTool`. Return a structured error the model can reason about:

```ts
return {
  ok: false,
  error: "slot_taken",
  message: "That 2pm slot was booked while we were talking.",
  alternatives: ["2026-11-14T15:00:00+01:00", "2026-11-15T10:00:00+01:00"],
};
```

The model will then apologise and offer the alternatives on its own. If you throw, the run fails and the customer gets silence.

---

## 10. The "scripts" — Python vs TypeScript

You asked for Python. Here's the honest picture.

**Trigger.dev tasks are TypeScript.** There's an official `@trigger.dev/python` extension, but it works by shelling out to a Python subprocess inside the task container:

```ts
import { pythonExtension } from "@trigger.dev/python/extension";
export default defineConfig({
  project: "<ref>",
  build: { extensions: [pythonExtension({
    requirementsFile: "./requirements.txt",   // production only
    scripts: ["./python/**/*.py"],
  })]},
});
```
```ts
import { python } from "@trigger.dev/python";
const result = await python.runScript("./python/book_appointment.py", [JSON.stringify(args)]);
const parsed = JSON.parse(result.stdout);
```

**Why that's the wrong choice for your tools:** every tool call pays subprocess spawn + interpreter startup (roughly 200–500ms), you serialise everything through stdout as strings, you lose type safety at the boundary, and errors arrive as stderr text you have to parse. Your tools are thin HTTP wrappers around Google Calendar and Supabase — there is no Python library advantage to offset that cost.

### Recommendation

**Write the tools in TypeScript.** Same language as the tasks, no process boundary, `zod` schemas that generate your JSON Schema tool definitions for free, Google's official `googleapis` SDK, Supabase's official `supabase-js`.

Keep the Python extension in your back pocket for the things Python is genuinely better at, if you ever need them: pandas analytics over conversation data, a scikit-learn no-show predictor, PDF generation.

```
src/
  trigger/
    handle-inbound-message.ts     # main loop
    send-reminder.ts
    rebuild-knowledge.ts
    nightly-summary.ts
  tools/
    index.ts                      # registry: name → { schema, handler }
    calendar/
      check-availability.ts
      book-appointment.ts
      reschedule-appointment.ts
      cancel-appointment.ts
    memory/
      save-customer-fact.ts
      get-customer-context.ts
    knowledge/
      search-knowledge.ts
    escalation/
      escalate-to-human.ts
  lib/
    whatsapp.ts                   # send text, send template, mark read
    google.ts                     # OAuth refresh + calendar client
    supabase.ts
    openai.ts
  prompts/
    identity.md
    sops.md
knowledge.md
```

### The tool catalogue

| Tool | Does | Returns |
|---|---|---|
| `check_availability` | `freeBusy.query`, subtract busy from business hours | Up to 5 slots, ISO + human-readable in customer's tz |
| `book_appointment` | Re-verify slot → `events.insert` with attendee + Meet link → insert into `appointments` → schedule reminders | `{ok, appointment_id, confirmed_time}` |
| `reschedule_appointment` | Verify new slot → `events.patch` → update row → reschedule reminders | `{ok, old_time, new_time}` |
| `cancel_appointment` | `events.delete` → status `cancelled` → cancel pending reminder runs | `{ok}` |
| `search_knowledge` | Embed query → `match_kb()` | Top-k chunks with headings |
| `save_customer_fact` | Upsert into `customer_facts` | `{ok}` |
| `get_customer_appointments` | Query upcoming | Array |
| `escalate_to_human` | Insert `handoffs`, flip conversation to `needs_human`, notify owner | `{ok}` |

Define each with `zod`, derive the JSON Schema from it, and you get runtime validation of the model's arguments plus the tool definition from one source.

---

## 11. Reminders

### Scheduling
When `book_appointment` succeeds, fire two delayed runs:

```ts
await sendReminder.trigger(
  { appointmentId, kind: "24h" },
  {
    delay: new Date(startsAt.getTime() - 24 * 3600_000),
    idempotencyKey: `reminder-24h-${appointmentId}`,
  }
);
await sendReminder.trigger(
  { appointmentId, kind: "1h" },
  {
    delay: new Date(startsAt.getTime() - 3600_000),
    idempotencyKey: `reminder-1h-${appointmentId}`,
  }
);
```

The idempotency keys mean a retried booking won't produce duplicate reminders.

`send-reminder` must **re-read the appointment and exit if status is `cancelled` or `rescheduled`**. Don't rely on cancelling the scheduled run — belt and braces.

Waits over 5 seconds don't consume compute on Trigger.dev Cloud, and the concurrency slot is released once the machine is checkpointed (about 60 seconds into a wait). A reminder sitting for three days costs you essentially nothing.

### Channels
- **Email** via Resend. React Email template with the date, time, location/Meet link, and a reschedule instruction.
- **WhatsApp** via an approved **Utility** template, because you're almost always outside the 24-hour window:

```
Hi {{1}}, reminder: your {{2}} with {{3}} is tomorrow at {{4}}.
Reply RESCHEDULE if you need a different time.
```

Register this in Meta Business Manager → WhatsApp Manager → Message Templates. Category **Utility** (cheaper than Marketing and won't get rejected as promotional).

---

## 12. Costs

Modelled on 1,000 conversations/month, ~8 messages each, business in Nigeria, customers mostly local.

| Item | Basis | Monthly |
|---|---|---|
| OpenAI — agent | 8,000 turns × ~3k in / 250 out on `gpt-6.1-sol` | ~$68 |
| OpenAI — summaries + embeddings | `gpt-6-luna` + `text-embedding-3-small` | ~$3 |
| WhatsApp service messages | 8,000 outbound, 1,000 free, rest at local service rate | ~$30–60 |
| WhatsApp utility templates | ~2,000 reminders | ~$10–30 |
| Trigger.dev | Hobby $10 (includes $10 usage); ~8k runs × short compute | $10–25 |
| Supabase | Free tier covers this comfortably; Pro if you want backups | $0–25 |
| Resend | 2,000 emails < free tier | $0 |
| Vercel | Hobby | $0 |
| **Total** | | **≈ $120–210/month** |

**Three cost levers, in order of impact:**
1. **Debounce is a direct discount.** Collapsing a 4-message burst into one run cuts both an LLM call and WhatsApp's outbound count.
2. **Route simple turns to `gpt-6-luna`.** A `gpt-6-luna` intent classifier in front, sending only booking/complex turns to `gpt-6.1-sol`, can cut the LLM line by half.
3. **Tier your context.** §7.3 keeps input tokens flat instead of growing with conversation length.

> ⚠️ **Set hard caps on day one:** an OpenAI monthly budget limit, a max-turns-per-conversation-per-day guard in your task, and a max tool-hop cap. A loop between your agent and an auto-responder on the other end can otherwise run up real money overnight.

---

## 13. The dashboard

Keep it small. Four screens.

1. **Inbox** — conversations sorted by last activity. Badges: `needs_human`, `window closing`, `unread`. Supabase Realtime subscription on `messages` pushes new rows in live.
2. **Conversation view** — full transcript with tool calls shown inline as collapsed grey rows ("checked availability 14–16 Nov", "booked Tue 2pm"). This is your debugging view as much as the business's monitoring view. Plus a **Take over** button that sets `handled_by = 'human'` and opens a reply box that sends via the Graph API as a human message.
3. **Appointments** — upcoming list, status, cancel/reschedule.
4. **Knowledge** — a textarea for `knowledge.md` and a "Rebuild" button that triggers `rebuild-knowledge`. This is what lets the business improve the agent's answers without touching code, and it's worth building early.

**Stack:** Next.js App Router on Vercel, `@supabase/ssr`, Supabase Auth with magic links, Tailwind.

**Alternative if you want it in a day:** skip Next.js and use **Supabase Studio table views + a Retool/Appsmith** front end. Less polish, but the data model above works unchanged, and you can swap in a real dashboard later.

> Trigger.dev Realtime (`useRealtimeRun`, `useRealtimeStream`) is excellent, but it's for watching *runs*. Your dashboard watches *conversations*, which live in Supabase. Use **Supabase Realtime** for the inbox. Reach for Trigger.dev Realtime only if you later want to stream the agent's reply token-by-token into the dashboard as it types.

---

## 14. Gotchas worth knowing before you hit them

| Trap | Fix |
|---|---|
| Timezones. The single biggest source of appointment-bot bugs. | Store everything in UTC (`timestamptz`). Convert to the customer's tz only for display. Always state the timezone to the customer. Inject the current date/time into every prompt. |
| Parsing JSON before verifying the HMAC signature | Verify against the **raw body bytes**. Parsing first invalidates the HMAC. Use `crypto.timingSafeEqual`, not `===`. |
| Using the access token as the HMAC key | The HMAC key is the **App Secret**. Different value, different place in the dashboard. |
| OAuth refresh token dying every 7 days | Publish the OAuth consent screen out of Testing status. |
| Agent says "booked!" before the tool ran | Explicit SOP rule, plus check: if the reply claims a booking and no `book_appointment` succeeded this turn, suppress and retry. |
| Meta disabling your webhook | It disables subscriptions after sustained failures. Return 200 fast and unconditionally after signature verification; do all work async. |
| Template rejected by Meta | Don't put promotional language in a Utility template. Keep variables to the minimum. |
| Customer messages an image/voice note | Decide now: transcribe (Whisper for voice) or reply "I can't read images yet — can you type it?" Handle it explicitly or the agent will ignore the message and look broken. |
| Agent hallucinates a price | Only answers from `search_knowledge` results. SOP-5 covers the gap. Keep `knowledge.md` genuinely complete on pricing. |
| Group chats | Cloud API webhooks can include group messages. Filter them out unless you explicitly want them. |

---

## 15. Decisions you need to make

1. **Direct Meta Cloud API or Twilio?** Direct is cheaper and what this spec assumes. Twilio's sandbox lets you test in 10 minutes without business verification — worth considering if you want to validate the agent before doing Meta's verification paperwork.
2. **Business hours, slot length, buffer between appointments, how far ahead bookings open.** Needed before Phase 3.
3. **One calendar or several?** (per staff member changes `check_availability` — `freeBusy.query` handles up to 50 calendars in one call, so multi-staff is cheap to add, but decide now.)
4. **In-person, Google Meet, or both?** Affects whether `events.insert` needs `conferenceData`.
5. **What escalation looks like.** Email to the owner? WhatsApp to the owner's personal number? A dashboard badge only?
6. **Languages.** Nigerian customers may write in Pidgin. `gpt-6.1-sol` handles it, but your SOPs should say whether to reply in kind.

---

## 16. Suggested order of attack

If you want the shortest path to something real: **Phases 0 → 1 → 2 → 3 → 4** gets you an agent you can talk to in a terminal that genuinely books into the real calendar with real knowledge. That's about 60% of the value and none of the Meta paperwork. Do that first, prove the conversation quality, *then* do Phases 5–6 to put WhatsApp in front of it.

---

## Sources

- [Trigger.dev — Python extension](https://trigger.dev/docs/config/extensions/pythonExtension)
- [Trigger.dev — Concurrency & queues](https://trigger.dev/docs/queue-concurrency)
- [Trigger.dev — Triggering & trigger options](https://trigger.dev/docs/triggering)
- [Trigger.dev — Debounced task runs](https://trigger.dev/changelog/debounced-task-runs)
- [Trigger.dev — Wait functions](https://trigger.dev/docs/wait)
- [Trigger.dev — Realtime overview](https://trigger.dev/docs/realtime/overview)
- [Trigger.dev for AI agents (2026) — chat.agent, streams, pricing](https://cadenya.com/other-content/trigger-dev-for-ai-agents)
- [Trigger.dev — HTTP endpoints changelog (v2, now removed)](https://trigger.dev/changelog/http-endpoints)
- [Is Trigger.dev Free? Plans, Limits & Pricing (2026)](https://hokai.io/hub/tools/trigger)
- [Meta — WhatsApp Business Platform pricing](https://developers.facebook.com/docs/whatsapp/pricing)
- [WhatsApp API Pricing 2026: Free 24-Hour Window Ends in October](https://blog.peppercloud.com/whatsapp-api-pricing-everything-you-need-to-know/)
- [Guide to WhatsApp Webhooks: Features and Best Practices](https://hookdeck.com/webhooks/platforms/guide-to-whatsapp-webhooks-features-and-best-practices)
- [Handling WhatsApp Cloud API Webhooks in Node.js: Signatures, Retries, Duplicates](https://dev.to/wapgrowai_org/handling-whatsapp-cloud-api-webhooks-in-nodejs-signatures-retries-and-duplicate-events-4dci)
- [WhatsApp Webhook Setup Guide 2026](https://www.zarghamlabs.com/whatsapp-webhook-setup-guide-2026/)
- [OpenAI — Models & pricing](https://developers.openai.com/api/docs/models)
- [OpenAI — Function calling (Responses API)](https://developers.openai.com/api/docs/guides/function-calling)
- [OpenAI — Embeddings](https://developers.openai.com/api/docs/guides/embeddings)
- [OpenAI — Migrate to the Responses API](https://developers.openai.com/api/docs/guides/migrate-to-responses)
- [Chat Completions vs Responses API: What Actually Changed](https://dev.to/dev-in-progress/chat-completions-vs-openai-responses-api-what-actually-changed-4bco)
- [Google Calendar API — freebusy.query](https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query)
- [Google — Using OAuth 2.0 for web server applications](https://developers.google.com/identity/protocols/oauth2/web-server)
- [Google — Domain-wide delegation](https://support.google.com/a/answer/162106?hl=en)
- [Supabase — Vector columns & pgvector](https://supabase.com/docs/guides/ai/vector-columns)
- [Supabase — Securing Edge Functions](https://supabase.com/docs/guides/functions/auth)
- [Supabase Pricing 2026: Free Tier Limits & Real Costs](https://designrevision.com/blog/supabase-pricing)
- [Gmail vs Resend comparison (2026)](https://forwardemail.net/en/blog/gmail-vs-resend-email-service-comparison)
- [Email API Pricing Comparison (2026)](https://www.buildmvpfast.com/api-costs/email)
- [WhatsApp debounce flow: combining rapid messages into one AI response](https://community.n8n.io/t/whatsapp-debounce-flow-combine-multiple-rapid-messages-into-one-ai-response-using-redis-n8n/225494)
- [Conversational AI Agents: Reply to Conversations, Not Messages](https://pranavgore.com/blogs/conversational-ai-agents-reply-to-conversations/)
