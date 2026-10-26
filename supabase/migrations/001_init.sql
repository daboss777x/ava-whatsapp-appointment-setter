-- Ava appointment setter — demo schema
-- Run in Supabase → SQL Editor (or `npx supabase db push`).

-- ============ customers ============
-- One row per WhatsApp phone number. This is the identity anchor.
create table if not exists customers (
  id              uuid primary key default gen_random_uuid(),
  wa_phone        text unique not null,          -- E.164, e.g. +15551234567
  wa_profile_name text,                          -- name WhatsApp reports
  display_name    text,                          -- name the agent learned/confirmed
  email           text,
  timezone        text default 'America/New_York',
  status          text default 'active' check (status in ('active','blocked','archived')),
  first_seen_at   timestamptz default now(),
  last_seen_at    timestamptz default now(),
  created_at      timestamptz default now()
);
create index if not exists customers_last_seen_idx on customers (last_seen_at desc);

-- ============ conversations ============
create table if not exists conversations (
  id                 uuid primary key default gen_random_uuid(),
  customer_id        uuid not null references customers(id) on delete cascade,
  status             text default 'open' check (status in ('open','closed','needs_human')),
  handled_by         text default 'ai' check (handled_by in ('ai','human')),
  handoff_reason     text,
  window_expires_at  timestamptz,               -- WhatsApp 24h free-form window
  last_processed_at  timestamptz,               -- Ava has replied to every customer msg up to here
  last_message_at    timestamptz default now(), -- drives inbox ordering
  opened_at          timestamptz default now(),
  closed_at          timestamptz
);
create index if not exists conversations_customer_idx on conversations (customer_id, opened_at desc);
create index if not exists conversations_last_msg_idx on conversations (last_message_at desc);

-- ============ messages ============
create table if not exists messages (
  id               uuid primary key default gen_random_uuid(),
  conversation_id  uuid not null references conversations(id) on delete cascade,
  customer_id      uuid not null references customers(id) on delete cascade,
  role             text not null check (role in ('customer','assistant','human_agent','system')),
  body             text,
  wa_message_id    text unique,                 -- Meta's id; UNIQUE = duplicate-delivery guard
  media_type       text,                        -- set when the customer sent non-text
  tool_calls       jsonb,                       -- what Ava did on this turn
  tokens_in        int,
  tokens_out       int,
  model            text,
  latency_ms       int,
  created_at       timestamptz default now()
);
create index if not exists messages_conv_idx on messages (conversation_id, created_at);
create index if not exists messages_customer_idx on messages (customer_id, created_at desc);

-- ============ customer_facts ============
-- Long-term memory: durable things Ava learned about a customer.
create table if not exists customer_facts (
  id           uuid primary key default gen_random_uuid(),
  customer_id  uuid not null references customers(id) on delete cascade,
  key          text not null,
  value        text not null,
  source       text default 'agent',
  updated_at   timestamptz default now(),
  unique (customer_id, key)
);

-- ============ appointments ============
create table if not exists appointments (
  id               uuid primary key default gen_random_uuid(),
  customer_id      uuid not null references customers(id) on delete cascade,
  conversation_id  uuid references conversations(id) on delete set null,
  gcal_event_id    text unique,
  service          text,
  starts_at        timestamptz not null,
  ends_at          timestamptz not null,
  timezone         text not null,
  meet_link        text,
  attendee_email   text,
  status           text default 'confirmed' check (status in ('confirmed','cancelled','completed','no_show')),
  notes            text,
  created_at       timestamptz default now(),
  updated_at       timestamptz default now()
);
create index if not exists appointments_starts_idx on appointments (starts_at);
create index if not exists appointments_customer_idx on appointments (customer_id, starts_at desc);

-- ============ realtime for the dashboard ============
alter publication supabase_realtime add table messages;
alter publication supabase_realtime add table conversations;
alter publication supabase_realtime add table appointments;

-- ============ row level security ============
-- Trigger.dev and the Edge Function use the service-role key, which bypasses RLS.
-- DEMO ONLY: the localhost dashboard reads with the anon key, so anon may SELECT.
-- Remove these policies (and add real auth) before this ever faces the internet.
alter table customers       enable row level security;
alter table conversations   enable row level security;
alter table messages        enable row level security;
alter table customer_facts  enable row level security;
alter table appointments    enable row level security;

create policy "demo anon read customers"     on customers     for select to anon using (true);
create policy "demo anon read conversations" on conversations for select to anon using (true);
create policy "demo anon read messages"      on messages      for select to anon using (true);
create policy "demo anon read appointments"  on appointments  for select to anon using (true);
