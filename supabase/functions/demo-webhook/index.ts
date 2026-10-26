// Demo-only webhook for the YouTube walkthrough. Completely separate from Ava:
// it answers Meta's verification handshake and logs incoming test events. No replies.
// Every request is recorded in demo_webhook_hits so verification problems can be diagnosed.
//
// Deploy:  npx supabase functions deploy demo-webhook --no-verify-jwt
// Secret:  npx supabase secrets set DEMO_VERIFY_TOKEN=...

import { createClient } from "npm:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

async function record(req: Request, url: URL, result: string) {
  try {
    await db.from("demo_webhook_hits").insert({
      method: req.method,
      path: url.pathname,
      params: Object.fromEntries(url.searchParams),
      user_agent: req.headers.get("user-agent"),
      result,
    });
  } catch (err) {
    console.error("could not record hit", String(err));
  }
}

Deno.serve(async (req) => {
  const url = new URL(req.url);

  if (req.method === "GET") {
    // Lenient on purpose (demo only): ignore stray spaces/quotes from copy-paste.
    const clean = (s: string | null | undefined) => (s ?? "").trim().replace(/^["']|["']$/g, "");
    const expected = clean(Deno.env.get("DEMO_VERIFY_TOKEN"));
    const got = clean(url.searchParams.get("hub.verify_token"));
    const ok = Boolean(expected) && url.searchParams.get("hub.mode") === "subscribe" && got === expected;
    await record(req, url, ok ? "verified" : "rejected");
    return ok
      ? new Response(url.searchParams.get("hub.challenge") ?? "", { status: 200, headers: { "Content-Type": "text/plain" } })
      : new Response("Forbidden", { status: 403 });
  }

  if (req.method === "POST") {
    await record(req, url, "event");
    console.log("demo webhook event received:", (await req.text()).slice(0, 2000));
    return new Response("ok", { status: 200 });
  }

  await record(req, url, "other method");
  return new Response("Method not allowed", { status: 405 });
});
