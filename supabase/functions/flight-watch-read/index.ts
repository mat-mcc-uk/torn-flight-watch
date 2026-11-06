// Returns the tracked enemy positions to the userscript. Requires the faction's read token.
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "x-fw-token, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: sec } = await db.from("flight_watch_secrets").select("read_token").eq("id", 1).single();
  const token = req.headers.get("x-fw-token") ?? new URL(req.url).searchParams.get("token");
  if (!sec || !token || token !== sec.read_token) {
    return new Response(JSON.stringify({ error: "bad token" }), { status: 403, headers: { ...CORS, "Content-Type": "application/json" } });
  }

  const [{ data: meta }, { data: members }] = await Promise.all([
    db.from("flight_watch_meta").select("enemies, last_poll, last_error").eq("id", 1).single(),
    db.from("flight_watch_members")
      .select("player_id, faction_id, faction_name, name, level, state, description, kind, country, plane, hosp, hosp_until, depart_at, eta, biz_eta, seen_at, changed_at"),
  ]);

  return new Response(JSON.stringify({ now: Math.floor(Date.now() / 1000), meta, members: members ?? [] }), {
    headers: { ...CORS, "Content-Type": "application/json" },
  });
});
