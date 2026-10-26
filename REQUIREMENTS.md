# Requirements

Everything you need to build, run and deploy Ava. The setup steps are in the [README](README.md#setup-guide).

## Platforms & accounts

| Platform | What it's used for | Plan needed | Sign up |
|---|---|---|---|
| **Trigger.dev** (v4) | Runs every background task: the AI agent, sending replies, testing tools. Handles queues, debouncing, retries and logs | Free tier is enough to start | [cloud.trigger.dev](https://cloud.trigger.dev) |
| **OpenAI** | The language model Ava thinks with (Responses API + tool calling) | Pay-as-you-go with billing credit | [platform.openai.com](https://platform.openai.com) |
| **Supabase** | Postgres database (customers, conversations, messages, appointments, facts), the WhatsApp webhook Edge Function, and realtime data for the dashboard | Free tier is enough to start | [supabase.com](https://supabase.com) |
| **Meta for Developers / WhatsApp Cloud API** | Receives and sends WhatsApp messages | Free to set up. Needs a Meta Business account and a phone number not already on WhatsApp | [developers.facebook.com](https://developers.facebook.com) |
| **Google Cloud** (Calendar API + service account) | Reads free/busy times and creates, moves and deletes events | Free | [console.cloud.google.com](https://console.cloud.google.com) |
| **Google Calendar + Google Meet** | The business calendar Ava books into, and the Meet link sent to customers | Any Google account (Workspace optional) | [calendar.google.com](https://calendar.google.com) |
| **GitHub** *(optional)* | Hosting the repo, plus auto-deploy to Trigger.dev via GitHub Actions on push to `master` | Free | [github.com](https://github.com) |
| **Vercel** or any Next.js host *(optional)* | Hosting the team dashboard in production | Free tier is enough | [vercel.com](https://vercel.com) |

## Tools on your machine

| Tool | Version | Why |
|---|---|---|
| **Node.js** | 22.x (what CI uses; 20+ should work) | Runs the Trigger.dev CLI and the dashboard |
| **npm** | Comes with Node | Installs dependencies |
| **Git** | Any recent | Cloning and pushing |
| **Trigger.dev CLI** | `trigger.dev@4.7.6` (installed as a dev dependency; or `npx trigger.dev@latest`) | `dev` server, `login`, `deploy` |
| **Supabase CLI** | Latest, via `npx supabase` | Linking the project, setting secrets, deploying Edge Functions |
| **OpenSSL** *(optional)* | Any | Generating a random webhook verify token (`openssl rand -hex 32`) |
| **Claude Code** *(optional)* | Latest | Building and customising with AI. `mcp.json` registers the Trigger.dev MCP server so Claude can trigger test runs, read logs and deploy |

## Languages & runtimes

- **TypeScript** (strict) for all code
- **Node.js** runtime for the Trigger.dev tasks
- **Deno** runtime for the Supabase Edge Functions (provided by Supabase; nothing to install)
- **SQL** (Postgres) for the migrations

## npm packages

### Root (Trigger.dev tasks)

| Package | Version | Purpose |
|---|---|---|
| `@trigger.dev/sdk` | ^4.7.6 | Task definitions, queues, logger |
| `@supabase/supabase-js` | ^2.118.0 | Database access |
| `openai` | ^7.39.0 | OpenAI Responses API client |
| `zod` | ^4.6.7 | Payload and tool-argument schemas |
| `@trigger.dev/build` *(dev)* | ^4.7.6 | Build extension that bundles the prompt Markdown files |
| `trigger.dev` *(dev)* | ^4.7.6 | CLI |
| `typescript` *(dev)* | ^5.9.3 | Type checking |
| `@types/node` *(dev)* | ^26.6.5 | Node types |

### Dashboard (`dashboard/`)

| Package | Version | Purpose |
|---|---|---|
| `next` | 15.5.28 | Web framework (App Router, Turbopack) |
| `react`, `react-dom` | 19.1.0 | UI |
| `@supabase/supabase-js` | ^2.118.0 | Live conversation data (realtime) |
| `@trigger.dev/sdk` | ^4.7.6 | Starts the `send-human-reply` task |
| `tailwindcss`, `@tailwindcss/postcss` *(dev)* | ^4 | Styling |
| `typescript`, `@types/*` *(dev)* | ^5 / ^19 / ^20 | Types |

No HTTP client library is used: all external calls (WhatsApp Graph API, Google Calendar API, Trigger.dev REST) use native `fetch`.

## Environment variables

| Variable | Used by | Where to get it |
|---|---|---|
| `OPENAI_API_KEY` | Trigger.dev tasks | OpenAI → API keys |
| `OPENAI_MODEL` | Trigger.dev tasks | Model name (default `gpt-6-luna`) |
| `WHATSAPP_ACCESS_TOKEN` | Tasks | Meta Business Settings → System users → generate token |
| `WHATSAPP_PHONE_NUMBER_ID` | Tasks | Meta app → WhatsApp → API Setup |
| `WHATSAPP_APP_SECRET` | Edge Function | Meta app → Settings → Basic |
| `WHATSAPP_VERIFY_TOKEN` | Edge Function | You invent it; paste the same value into Meta |
| `WHATSAPP_GRAPH_VERSION` | Tasks | Default `v23.0` |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | Tasks | Service account JSON key → `client_email` |
| `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` | Tasks | Service account JSON key → `private_key` |
| `GOOGLE_CALENDAR_ID` | Tasks | Your calendar's ID (usually your Gmail address) |
| `MEET_LINK` | Tasks | A reusable Google Meet link |
| `BUSINESS_NAME`, `BUSINESS_TIMEZONE`, `BUSINESS_TZ_LABEL` | Tasks | Your business details (IANA timezone, e.g. `Africa/Lagos`) |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Tasks, Edge Function (auto), dashboard | Supabase → Project Settings → API |
| `TRIGGER_SECRET_KEY` | Edge Function, dashboard | Trigger.dev → API keys (`tr_dev_…` / `tr_prod_…`) |
| `RESET_KEYWORD` | Edge Function | You choose it (testing aid) |
| `DEMO_VERIFY_TOKEN` *(optional)* | `demo-webhook` Edge Function | You invent it |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Dashboard | Supabase → Project Settings → API |
| `NEXT_PUBLIC_BUSINESS_TIMEZONE`, `NEXT_PUBLIC_BUSINESS_TZ_LABEL` | Dashboard | Same as above |
| `TRIGGER_ACCESS_TOKEN` *(optional)* | GitHub Actions secret | Trigger.dev → Personal access tokens |

Task variables must be in **both** `.env` (local dev) **and** the Trigger.dev dashboard → Environment Variables (production). Edge Function variables are set with `npx supabase secrets set`. Dashboard variables go in `dashboard/.env.local`.

## Running costs

Rough figures at small-business volume. Check each provider's pricing page, because prices change.

- **OpenAI**: the only real variable cost. A typical conversation is a few short turns. With the last 20 messages as context it usually costs a few cents or less, depending on the model.
- **WhatsApp**: replies to customers who messaged you first, inside Meta's 24-hour customer-service window, are currently free. Template messages you start yourself are charged per message, by country.
- **Trigger.dev, Supabase, Google Calendar**: free tiers cover a small business. Upgrade only at scale.
