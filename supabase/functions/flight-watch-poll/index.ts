// Polls the enemy factions every run (pg_cron calls this every 30 seconds) and records
// estimated takeoff times so the userscript can show an ETA for every flight.
import { createClient } from "npm:@supabase/supabase-js@2";

const DESTS: Record<string, { t: number[]; adj: string[] }> = {
  "Mexico": { t: [26, 18, 13, 8], adj: ["mexican"] },
  "Cayman Islands": { t: [35, 25, 18, 11], adj: ["caymanian"] },
  "Canada": { t: [41, 29, 20, 12], adj: ["canadian"] },
  "Hawaii": { t: [134, 94, 67, 40], adj: ["hawaiian"] },
  "United Kingdom": { t: [159, 111, 80, 48], adj: ["british"] },
  "Argentina": { t: [167, 117, 83, 50], adj: ["argentinian", "argentine"] },
  "Switzerland": { t: [175, 123, 88, 53], adj: ["swiss"] },
  "Japan": { t: [225, 158, 113, 68], adj: ["japanese"] },
  "China": { t: [242, 169, 121, 72], adj: ["chinese"] },
  "UAE": { t: [271, 190, 135, 81], adj: ["emirati", "uae"] },
  "South Africa": { t: [297, 208, 149, 89], adj: ["south african"] },
};
const COUNTRIES = Object.keys(DESTS);
const NAMES: Record<string, string[]> = {
  "Cayman Islands": ["cayman"],
  "UAE": ["uae", "united arab emirates", "dubai"],
  "United Kingdom": ["united kingdom", "london"],
  "South Africa": ["south africa", "johannesburg"],
};
const PLANE_INDEX: Record<string, number> = { airliner: 0, light_aircraft: 1, private_jet: 2 };
const WAR_CHECK = 300;

const namesFor = (c: string) => NAMES[c] ?? [c.toLowerCase()];
const findCountry = (s: string) => COUNTRIES.find((c) => namesFor(c).some((n) => s.includes(n))) ?? null;

type Loc = { kind: "out" | "there" | "back" | "torn"; country: string | null; hosp?: boolean };

// Same rules as the userscript's parseLoc.
function parseLoc(s: any): Loc {
  const state = String(s?.state ?? "").toLowerCase();
  const desc = String(s?.description ?? "").toLowerCase();
  const text = `${desc} ${String(s?.details ?? "").toLowerCase()}`;
  if (state === "traveling" || state === "travelling") {
    const ft = desc.match(/from\s+(.+?)\s+to\s+(.+?)\s*$/);
    if (ft) {
      const [, from, to] = ft;
      if (/\btorn\b/.test(to)) {
        const c = findCountry(from);
        return c ? { kind: "back", country: c } : { kind: "torn", country: null };
      }
      const c = findCountry(to);
      return c ? { kind: "out", country: c } : { kind: "torn", country: null };
    }
    const c = findCountry(text);
    if (!c) return { kind: "torn", country: null };
    return /return/.test(desc) ? { kind: "back", country: c } : { kind: "out", country: c };
  }
  for (const c of COUNTRIES) {
    const hit = namesFor(c).some((n) => text.includes(n));
    if (state === "abroad" && hit) return { kind: "there", country: c };
    if (state === "hospital" && DESTS[c].adj.some((a) => text.includes(`${a} hospital`))) {
      return { kind: "there", country: c, hosp: true };
    }
  }
  return { kind: "torn", country: null };
}

async function torn(path: string, key: string) {
  const r = await fetch(`https://api.torn.com/v2/${path}${path.includes("?") ? "&" : "?"}key=${encodeURIComponent(key)}`);
  const j = await r.json();
  if (j?.error) throw new Error(`Torn API ${j.error.code}: ${j.error.error}`);
  return j;
}

Deno.serve(async (req) => {
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const { data: sec } = await db.from("flight_watch_secrets").select("cron_token").eq("id", 1).single();
  if (!sec || req.headers.get("x-cron-token") !== sec.cron_token) {
    return new Response("forbidden", { status: 403 });
  }

  const key = Deno.env.get("TORN_API_KEY");
  const t = Math.floor(Date.now() / 1000);
  if (!key) {
    await db.from("flight_watch_meta").update({ last_error: "TORN_API_KEY secret not set", last_poll: t }).eq("id", 1);
    return new Response("no key", { status: 500 });
  }

  try {
    const { data: meta } = await db.from("flight_watch_meta").select("*").eq("id", 1).single();
    let enemies: { id: number; name: string; type: string; start: number }[] = meta?.enemies ?? [];
    let ownId: number | null = meta?.own_faction_id ?? null;

    // Refresh who we're at war with every few minutes.
    if (!meta || t - meta.war_checked_at >= WAR_CHECK) {
      const [basic, wars] = await Promise.all([torn("faction/basic", key), torn("faction/wars", key)]);
      ownId = basic?.basic?.id ?? null;
      const w = wars?.wars ?? {};
      const live = (war: any) => !war.end || war.end > t;
      const found = new Map<number, { id: number; name: string; type: string; start: number }>();
      const add = (war: any, type: string) => {
        for (const f of war.factions ?? []) {
          if (f.id !== ownId && !found.has(f.id)) found.set(f.id, { id: f.id, name: f.name, type, start: war.start });
        }
      };
      if (w.ranked && live(w.ranked) && !w.ranked.winner) add(w.ranked, "ranked");
      (w.raids ?? []).filter(live).forEach((r: any) => add(r, "raid"));
      (w.territory ?? []).filter(live).forEach((r: any) => add(r, "territory"));
      enemies = [...found.values()];
      await db.from("flight_watch_meta").update({ own_faction_id: ownId, enemies, war_checked_at: t }).eq("id", 1);
    }

    const lists = await Promise.all(enemies.map((e) => torn(`faction/${e.id}/members?striptags=true`, key)));

    const { data: existing } = await db.from("flight_watch_members").select("*");
    const prevById = new Map<number, any>((existing ?? []).map((r: any) => [Number(r.player_id), r]));

    const rows: any[] = [];
    lists.forEach((data, i) => {
      const fac = enemies[i];
      const raw = data?.members ?? [];
      const members = Array.isArray(raw) ? raw : Object.entries(raw).map(([id, m]: any) => ({ id: Number(id), ...m }));
      for (const m of members) {
        const s = m.status ?? {};
        const loc = parseLoc(s);
        const prev = prevById.get(Number(m.id));
        const moved = !prev || prev.kind !== loc.kind || prev.country !== loc.country;
        const plane = s.plane_image_type ?? (loc.kind === "out" && prev?.kind === "out" ? prev.plane : null);

        let depart_at: number | null = null;
        if (loc.kind === "out") {
          if (prev && moved) {
            // Took off since the last poll: split the difference, capped so a long gap doesn't skew it.
            depart_at = t - Math.round(Math.min(t - Number(prev.seen_at), 120) / 2);
          } else if (prev && !moved) {
            depart_at = prev.depart_at;
          }
        }
        const idx = plane && plane in PLANE_INDEX ? PLANE_INDEX[plane] : null;
        const mins = loc.country && idx !== null ? DESTS[loc.country].t[idx] : null;
        const eta = loc.kind === "out" ? (s.until && s.until > t ? s.until : depart_at && mins ? depart_at + mins * 60 : null) : null;
        const biz_eta = loc.kind === "out" && plane === "airliner" && depart_at ? depart_at + DESTS[loc.country!].t[3] * 60 : null;

        rows.push({
          player_id: m.id,
          faction_id: fac.id,
          faction_name: fac.name,
          name: m.name,
          level: m.level,
          state: s.state ?? null,
          description: s.description ?? null,
          kind: loc.kind,
          country: loc.country,
          plane,
          hosp: !!loc.hosp,
          hosp_until: loc.hosp ? s.until ?? null : null,
          depart_at,
          eta,
          biz_eta,
          seen_at: t,
          changed_at: moved ? t : prev.changed_at,
        });
      }
    });

    if (rows.length) {
      const { error } = await db.from("flight_watch_members").upsert(rows, { onConflict: "player_id" });
      if (error) throw new Error(error.message);
    }
    // Drop members of factions we no longer watch, and anyone who left a watched faction.
    const keep = new Set(rows.map((r) => Number(r.player_id)));
    const gone = [...prevById.keys()].filter((id) => !keep.has(id));
    if (gone.length) await db.from("flight_watch_members").delete().in("player_id", gone);

    await db.from("flight_watch_meta").update({ last_poll: t, last_error: null }).eq("id", 1);
    return new Response(JSON.stringify({ ok: true, enemies: enemies.length, members: rows.length }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    await db.from("flight_watch_meta").update({ last_poll: t, last_error: String((e as Error).message ?? e) }).eq("id", 1);
    return new Response(String(e), { status: 500 });
  }
});
