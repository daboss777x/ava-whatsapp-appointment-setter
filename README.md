# Ava: AI WhatsApp Appointment Setter

Ava is an AI receptionist that lives in your business's WhatsApp. She answers customer questions from your own knowledge base and checks your real Google Calendar. She books, reschedules and cancels 30-minute Google Meet calls, and she remembers returning customers. When a chat needs a person, she hands it to your team, and the team can take over any chat from a live inbox dashboard.

It runs on **Trigger.dev** (background tasks), **OpenAI** (the brain), **Supabase** (database + webhook), **Google Calendar** and the **WhatsApp Cloud API**.

> The demo business, *Northbeam Advisory* (a Nairobi consultancy), is fictional. Swap in your own business by editing three Markdown files and a handful of settings; no code changes are needed for most businesses.

---

## Who this is for

Any business where customers **message first and then book a time** gets the most from Ava. That's especially true in markets where WhatsApp is the main way customers reach a business, such as Africa, Latin America, India, the Middle East and much of Europe.

| Business type | What Ava takes off your plate |
|---|---|
| **Clinics, dentists, physios, vets** | "Are you open Saturday?", "How much is a consultation?", booking and moving appointments |
| **Salons, barbers, spas, beauty studios** | Price lists, availability, rebooking regulars, cancellations |
| **Consultants, coaches, agencies, accountants, lawyers** | Qualifying leads, booking discovery calls, sending the Meet link |
| **Gyms, fitness and yoga studios** | Intro sessions, PT bookings, membership FAQs |
| **Tutors, schools, training providers** | Enquiries from parents and students, trial lessons, schedules |
| **Real estate, mortgage brokers, car dealers** | Viewing / consultation bookings, first-line questions at any hour |
| **Trades and home services** | Quote calls, site-visit scheduling, "do you cover my area?" |

### How it creates value

- **Never miss a lead after hours.** Many enquiries arrive in the evening or at weekends. Ava replies in seconds, 24/7, while the customer is still interested. Without her, they message the next business on their list.
- **Win back staff time.** Answering the same 20 questions and going back and forth over times can take a receptionist or owner hours every day. Ava handles routine chats end to end, and your team only sees the ones that need a human.
- **Cut costs.** A full-time receptionist costs a salary. Ava costs roughly **the price of a few cents of AI usage per conversation** plus hosting that fits inside free tiers at small volume (see [REQUIREMENTS.md](REQUIREMENTS.md#running-costs)).
- **Fewer no-shows and double-bookings.** Ava only offers times that are really free. She re-checks the calendar before booking, keeps buffers between calls and skips public holidays. Every customer gets a written confirmation with the Meet link.
- **Consistent answers.** Ava answers only from your knowledge base, and she never invents prices or policies. Questions she can't answer are flagged to your team without dropping the conversation.
- **Customers feel remembered.** Ava keeps each customer's name, email, interests and upcoming bookings, so returning customers don't have to repeat themselves.

---

## What Ava does

- **Answers FAQs** from `prompts/knowledge.md` (services, prices, hours, location, payment, policies)
- **Books / reschedules / cancels** 30-min Google Meet calls in your Google Calendar, Mon–Fri 9–5 by default, with buffers, minimum notice, a 14-day booking horizon and public holidays
- **Remembers customers**: name, email, company, preferences and upcoming appointments
- **Handles message bursts**: if a customer sends 4 messages in a row, Ava waits for them to finish and sends **one** reply
- **Handles many customers at once**: one queue per customer, so chats run in parallel without crossing wires
- **Escalates to a human** for complaints, billing disputes or "can I talk to a person?", and keeps covering politely until someone picks it up. If nobody does within 2 working hours, the chat goes back to Ava
- **Flags questions for the team** that the knowledge base can't answer, without handing over the chat
- **Live inbox dashboard** (Next.js) where your team sees every conversation, presses **Take over** and replies to the customer in WhatsApp
- **Safety rails**: a daily reply cap per customer, a polite fallback for voice notes and images, webhook signature verification and duplicate-delivery protection

## How it works

```
Customer on WhatsApp
       │
       ▼
Meta WhatsApp Cloud API ──webhook──► Supabase Edge Function  (verifies signature, saves message)
                                            │
                                            ▼  trigger (debounced 6s per customer)
                                     Trigger.dev task: handle-inbound-message
                                            │
                       ┌────────────────────┼────────────────────┐
                       ▼                    ▼                    ▼
                 OpenAI (agent +      Google Calendar       Supabase (customers,
                 tool calling)        (free/busy, events)   chats, bookings, facts)
                       │
                       ▼
               Reply sent via WhatsApp ◄── Team can take over from the Next.js dashboard
```

Open [docs/ARCHITECTURE.html](docs/ARCHITECTURE.html) in a browser for a visual walkthrough. [docs/RESEARCH.md](docs/RESEARCH.md) is the original build spec, with the reasoning behind each design choice.

## Project structure

```
src/trigger/appointment-setter/
  handle-inbound-message.ts   ← main task: one run per burst of customer messages
  send-human-reply.ts         ← dashboard → WhatsApp when a team member replies
  reset-customer.ts           ← testing aid: wipe a phone number and start fresh
  simulate-message.ts         ← test Ava with no WhatsApp at all
  test-calendar.ts            ← test Google Calendar with no AI at all
  agent/                      ← prompt builder, OpenAI tool-calling loop, tools
  lib/                        ← calendar, WhatsApp, Supabase, time, holidays, env helpers
  prompts/
    identity.md               ← Ava's personality and tone
    sops.md                   ← step-by-step procedures (booking, rescheduling, escalation…)
    knowledge.md              ← your business FAQ: the only facts Ava may quote
supabase/
  functions/whatsapp-webhook/ ← receives WhatsApp messages, triggers Trigger.dev
  functions/demo-webhook/     ← optional: logs Meta's webhook handshake, for setup walkthroughs
  migrations/                 ← database schema (run in order)
dashboard/                    ← Next.js live inbox for your team
docs/                         ← architecture diagram, build research, Trigger.dev reference
trigger.config.ts             ← Trigger.dev project config
```

---

## Setup guide

Allow about **1–2 hours** the first time; most of it is clicking through the Meta and Google consoles. The full list of accounts and tools is in [REQUIREMENTS.md](REQUIREMENTS.md).

### Step 1: Get the code

```bash
git clone https://github.com/daboss777x/ava-whatsapp-appointment-setter.git
cd ava-whatsapp-appointment-setter
npm install
cp .env.example .env
```

You'll fill in `.env` as you go. Every variable in `.env.example` has a comment saying where to find it.

### Step 2: Trigger.dev

1. Sign up at [cloud.trigger.dev](https://cloud.trigger.dev) and create a project.
2. Copy the **project ref** (starts with `proj_`) from Project settings into `trigger.config.ts`, replacing `proj_YOUR_PROJECT_REF`.
3. From **API keys**, copy the **DEV** secret key (`tr_dev_…`) into `.env` as `TRIGGER_SECRET_KEY`.
4. Log in from your terminal: `npx trigger.dev@latest login`

### Step 3: Supabase (database + webhook)

1. Create a project at [supabase.com](https://supabase.com).
2. Open **SQL Editor** and run each file in `supabase/migrations/` **in order** (`001` → `004`; `004` is optional and only used by the demo webhook).
3. From **Project Settings → API**, copy into `.env`:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY` (secret: server-side only)

### Step 4: OpenAI

1. At [platform.openai.com](https://platform.openai.com), create a project-scoped API key and add billing credit.
2. Put it in `.env` as `OPENAI_API_KEY`. `OPENAI_MODEL` defaults to `gpt-6-luna`. Use any tool-calling model you have access to.

### Step 5: Google Calendar

1. In [Google Cloud Console](https://console.cloud.google.com), create a project and **enable the Google Calendar API**.
2. Go to **IAM & Admin → Service Accounts**, create a service account, then **Keys → Add key → JSON** to download its key file.
3. Copy `client_email` → `GOOGLE_SERVICE_ACCOUNT_EMAIL` and `private_key` → `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` (keep the `\n`s and wrap the value in quotes).
4. In Google Calendar, open your calendar's **Settings → Share with specific people**, add the service account email and give it **Make changes to events**.
5. Set `GOOGLE_CALENDAR_ID` (usually your Gmail address).
6. Create one reusable Google Meet link (meet.google.com → *Create a meeting for later*) and set `MEET_LINK`.

### Step 6: Test Ava before touching WhatsApp

```bash
npm run dev          # starts the Trigger.dev dev server
```

From the Trigger.dev dashboard **Test** page, or with the Trigger.dev MCP in Claude Code, run:

- `test-calendar` with `{ "mode": "slots" }` → should list free slots from your calendar
- `simulate-message` with `{ "phone": "+15550000001", "text": "Hi, what do you offer?", "name": "Sam" }` → returns Ava's reply
- Keep chatting with the same phone number and try booking. The event should appear in your Google Calendar.

### Step 7: WhatsApp (Meta Cloud API)

1. At [developers.facebook.com](https://developers.facebook.com), create an app of type **Business** and add the **WhatsApp** product.
2. From **WhatsApp → API Setup**, copy the **Phone number ID** → `WHATSAPP_PHONE_NUMBER_ID`.
3. Create a **permanent token**: Business Settings → System users → add a user → assign the app → generate a token with `whatsapp_business_messaging` + `whatsapp_business_management` → `WHATSAPP_ACCESS_TOKEN`. (The temporary token on API Setup expires in 24h.)
4. Copy **App → Settings → Basic → App Secret** → `WHATSAPP_APP_SECRET`.
5. Invent a verify token (`openssl rand -hex 32`) → `WHATSAPP_VERIFY_TOKEN`.

### Step 8: Deploy the webhook (Supabase Edge Function)

```bash
npx supabase login
npx supabase link --project-ref YOUR_SUPABASE_PROJECT_REF
npx supabase secrets set \
  WHATSAPP_APP_SECRET=... \
  WHATSAPP_VERIFY_TOKEN=... \
  TRIGGER_SECRET_KEY=tr_dev_... \
  RESET_KEYWORD=pick-your-own-secret-word
npx supabase functions deploy whatsapp-webhook --no-verify-jwt
```

Then in Meta: **WhatsApp → Configuration → Webhook**, enter:
- Callback URL: `https://YOUR_SUPABASE_PROJECT_REF.supabase.co/functions/v1/whatsapp-webhook`
- Verify token: the same `WHATSAPP_VERIFY_TOKEN`
- Subscribe to the **messages** field.

Send a WhatsApp message to your business number. With `npm run dev` running, Ava replies. 🎉

> `RESET_KEYWORD`: if a sender messages exactly this word, everything stored about **their own number** is wiped and they start over as a new customer. That's handy for testing. Choose your own word, because the code default is public.

### Step 9: The team dashboard

```bash
cd dashboard
npm install
cp .env.local.example .env.local   # fill in Supabase URL, anon key, service role key, TRIGGER_SECRET_KEY
npm run dev                        # http://localhost:3000
```

You'll see every conversation live. **Take over** silences Ava for that chat, replies you type are sent to the customer on WhatsApp, and **Hand back** returns the chat to Ava.

### Step 10: Go to production

1. Add **every** variable from `.env` to Trigger.dev → your project → **Environment Variables** (Production, and Staging if you use it). This is the #1 cause of production failures.
2. Deploy the tasks: `npx trigger.dev@latest deploy`. Or add a `TRIGGER_ACCESS_TOKEN` repo secret (a Trigger.dev personal access token), and every push to `master` deploys automatically via `.github/workflows/deploy.yml`.
3. Swap the Edge Function's `TRIGGER_SECRET_KEY` to your **prod** key (`tr_prod_…`), and update the dashboard's too.
4. Host the dashboard anywhere Next.js runs (e.g. Vercel). **Add authentication first** (see Security below).

---

## Make it your own business

| What | Where |
|---|---|
| Ava's name, personality, tone | `src/trigger/appointment-setter/prompts/identity.md` |
| Booking / escalation procedures | `src/trigger/appointment-setter/prompts/sops.md` |
| Your services, prices, hours, FAQs | `src/trigger/appointment-setter/prompts/knowledge.md` |
| Business name, timezone, timezone label | `.env`: `BUSINESS_NAME`, `BUSINESS_TIMEZONE`, `BUSINESS_TZ_LABEL` |
| Opening hours, slot length, buffer, notice, horizon, workdays | `RULES` in `src/trigger/appointment-setter/lib/calendar.ts` |
| Bookable service names | `service` enum in `book_appointment`, `src/trigger/appointment-setter/agent/tools.ts` |
| Public holidays (Kenya by default) | `src/trigger/appointment-setter/lib/holidays.ts` |
| Daily reply cap, auto hand-back time | top of `src/trigger/appointment-setter/agent/process-conversation.ts` |

**Using Claude Code?** Open the repo in Claude Code and ask, for example: *"Rebrand Ava for my dental clinic in Lagos: here are our services and prices…"*. [CLAUDE.md](CLAUDE.md) gives Claude the full map of the project.

## Security notes before real customers

This repo is set up as a **demo**. Before you put real customer data through it:

- **Add login to the dashboard.** Its API routes (`/api/takeover`, `/api/reply`) have no authentication. Use Supabase Auth, Vercel password protection or similar.
- **Tighten the database policies.** `001_init.sql` includes `demo anon read …` policies, which let anyone with the anon key read conversations. Replace them with policies for signed-in staff only.
- **Keep secrets server-side.** Never put `SUPABASE_SERVICE_ROLE_KEY` or `TRIGGER_SECRET_KEY` in a `NEXT_PUBLIC_` variable, and never commit `.env`. `.gitignore` already excludes it.
- **Respect WhatsApp's rules.** Outside the 24-hour customer-service window you can only send pre-approved template messages, so Ava only replies to customers who messaged first.

---

## Credits

- The Trigger.dev starter files, **`docs/trigger-ref.md`**, **`trigger.config.ts`** and **`tsconfig.json`**, come from **Nate Herk's [AI Automation Society](https://www.skool.com/ai-automation-society) Skool community**. Go join it if you want to build automations like this one.
- Built with [Claude Code](https://claude.com/claude-code).
