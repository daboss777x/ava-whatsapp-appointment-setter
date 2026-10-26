-- Optional: only used by the demo-webhook Edge Function (Meta webhook setup walkthrough).
-- Records every request so a failing verification handshake can be diagnosed.
create table if not exists demo_webhook_hits (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  method      text,
  path        text,
  params      jsonb,
  user_agent  text,
  result      text
);

-- Service role only (the Edge Function); no anon access.
alter table demo_webhook_hits enable row level security;
