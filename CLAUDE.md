# Ava: AI WhatsApp Appointment Setter

## What this project is

Ava is an AI receptionist for a business's WhatsApp number. She answers customer questions from a Markdown knowledge base and books, reschedules and cancels 30-minute Google Meet calls in a real Google Calendar. She remembers returning customers and hands chats to a human team when needed. A Next.js dashboard gives the team a live inbox with **Take over** / **Hand back** and the ability to reply.

The demo business is **Northbeam Advisory**, a fictional Nairobi consultancy (timezone `Africa/Nairobi`, label `EAT`, Kenyan public holidays).

Stack: **Trigger.dev v4** (tasks) · **OpenAI Responses API** (tool-calling agent) · **Supabase** (Postgres, Edge Functions, Realtime) · **Google Calendar API** (service account) · **WhatsApp Cloud API** · **Next.js 15** dashboard. TypeScript throughout.

## Message flow

1. Customer messages the WhatsApp number → Meta POSTs to `supabase/functions/whatsapp-webhook` (Deno).
2. The webhook verifies the `X-Hub-Signature-256` HMAC, drops duplicates, upserts the customer, opens or reuses their conversation and stores the message. It then triggers `handle-inbound-message` through the Trigger.dev REST API, with `concurrencyKey = phone` and `debounce { key: phone, delay: "6s", mode: "trailing", maxDelay: "30s" }`. If the message equals `RESET_KEYWORD`, it triggers `reset-customer` instead.
3. `handle-inbound-message` → `agent/process-conversation.ts`:
   - reads all unprocessed customer messages from the DB (never trusts the payload)
   - checks handover state (human handling → silent; escalated but unclaimed → "handover" mode; unclaimed for 2 working hours → auto hand-back)
   - enforces the daily reply cap (60) and sends a fallback for media-only messages
   - builds instructions (`agent/prompt.ts`) from `prompts/*.md` plus customer facts, upcoming appointments and the last 20 messages
   - runs the tool loop (`agent/run-agent-turn.ts`), then converts Markdown to WhatsApp formatting, sends the reply and stores it with token/latency metadata
4. The dashboard reads with the anon key (Realtime). `/api/takeover` updates `conversations.handled_by`, and `/api/reply` triggers `send-human-reply`.

## Key files

| Path | Role |
|---|---|
| `src/trigger/appointment-setter/handle-inbound-message.ts` | Main task, plus the per-customer queue (`inboundQueue`, concurrency 1) |
| `src/trigger/appointment-setter/agent/process-conversation.ts` | Orchestrates one reply turn; handover logic; caps |
| `src/trigger/appointment-setter/agent/run-agent-turn.ts` | OpenAI tool-calling loop (`OPENAI_MODEL`, default `gpt-6-luna`) |
| `src/trigger/appointment-setter/agent/tools.ts` | Agent tools: `check_availability`, `book_appointment`, `get_customer_appointments`, `reschedule_appointment`, `cancel_appointment`, `save_customer_fact`, `escalate_to_human`, `cancel_handover`, `flag_for_team` (Zod schemas → strict function tools) |
| `src/trigger/appointment-setter/agent/prompt.ts` | Assembles system instructions from the prompt files and customer context |
| `src/trigger/appointment-setter/prompts/{identity,sops,knowledge}.md` | Personality, procedures and the business FAQ. Bundled at deploy via `additionalFiles` in `trigger.config.ts` |
| `src/trigger/appointment-setter/lib/calendar.ts` | Google service-account JWT auth, free/busy, slot generation, `RULES` (hours, slot length, buffer, notice, horizon, workdays) |
| `src/trigger/appointment-setter/lib/holidays.ts` | Kenyan public holidays (update yearly; Eid dates are estimates) |
| `src/trigger/appointment-setter/lib/{whatsapp,supabase,time,http,env}.ts` | Graph API send / mark-read, DB helpers, timezone maths, fetch with timeout + retry, env validation |
| `src/trigger/appointment-setter/send-human-reply.ts` | Dashboard → WhatsApp for team replies |
| `src/trigger/appointment-setter/reset-customer.ts` | Wipes a phone number's data + upcoming calendar events (testing aid) |
| `src/trigger/appointment-setter/simulate-message.ts` | Test Ava with no WhatsApp: same DB and agent, reply returned instead of sent |
| `src/trigger/appointment-setter/test-calendar.ts` | Test calendar plumbing with no AI (`mode: "slots"` or `"full"`) |
| `supabase/functions/whatsapp-webhook/index.ts` | Production webhook |
| `supabase/functions/demo-webhook/index.ts` | Optional demo endpoint that only logs Meta's handshake/events to `demo_webhook_hits` |
| `supabase/migrations/00{1..4}_*.sql` | Schema: `customers`, `conversations`, `messages`, `customer_facts`, `appointments`, handover/team-question columns, demo table |
| `dashboard/` | Next.js live inbox (`app/page.tsx`, `app/api/{takeover,reply}/route.ts`) |
| `docs/` | `ARCHITECTURE.html` (visual), `RESEARCH.md` (original build spec), `trigger-ref.md` (Trigger.dev v4 code reference) |

## Commands

```bash
npm install
npm run dev            # Trigger.dev dev server (tasks run locally)
npm run typecheck      # tsc --noEmit
npx trigger.dev@latest deploy                                   # deploy tasks to prod
npx supabase functions deploy whatsapp-webhook --no-verify-jwt  # deploy webhook
cd dashboard && npm run dev                                     # dashboard on :3000
```

Test without WhatsApp: trigger `simulate-message` with `{ "phone": "+15550000001", "text": "Hi", "name": "Sam" }` (add `"reset": true` to start fresh) and `test-calendar` with `{ "mode": "slots" }`. Prefer the Trigger.dev MCP tools (`mcp__trigger__trigger_task`, `get_run_details`, `list_runs`, `deploy`) over the CLI when they're available. They're configured in `mcp.json`.

## Conventions

- **TypeScript only.** All backend logic runs as Trigger.dev tasks (`@trigger.dev/sdk` v4: `task` / `schemaTask`, never v2 `client.defineJob`). Use native `fetch`, with no axios.
- Imports between task files use the `.js` extension (`./lib/env.js`).
- Validate env vars at the top of every task with `requireEnvs([...])` from `lib/env.ts`. Never log secret values or hardcode credentials or IDs.
- Business facts belong in `prompts/knowledge.md`, not in code. Ava must never invent prices or policies.
- Keep the DB as the source of truth: tasks re-read state rather than trusting payloads, so retries and debounced runs never double-answer.
- `triggerAndWait()` returns a `Result`, so check `result.ok`. Never wrap `triggerAndWait` or `wait.*` in `Promise.all`. Use `idempotencyKey` wherever the same item can be triggered twice.
- Match the existing style: short functions, comments that explain *why*, and early returns with `{ ok: false, error, message }` from tools.

## Environment & deploys

- Secrets live in `.env` (gitignored). `.env.example` documents every key and where to get it. Dashboard secrets go in `dashboard/.env.local`, and Edge Function secrets are set with `npx supabase secrets set`.
- Every task env var must also be added to Trigger.dev → project → Environment Variables (prod and staging) before deploying. A missing dashboard env var is the #1 cause of failed production runs.
- `trigger.config.ts` holds the Trigger.dev project ref (`proj_…`).
- `.github/workflows/deploy.yml` typechecks on push to `master` and deploys when the `TRIGGER_ACCESS_TOKEN` repo secret is set.
- Never deploy or push to production without the user's explicit approval after a successful local test.

## Known demo shortcuts (fix before real customer data)

- Dashboard API routes have no authentication.
- `001_init.sql` grants the `anon` role SELECT on customers, conversations, messages and appointments, for the demo dashboard.
- `RESET_KEYWORD` falls back to a public default in code. Always set it as a secret.

## Credits

`docs/trigger-ref.md`, `trigger.config.ts` and `tsconfig.json` started from Nate Herk's [AI Automation Society](https://www.skool.com/ai-automation-society) Skool community.
