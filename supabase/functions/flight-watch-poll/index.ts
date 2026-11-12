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
const MAX_GAP = 90; // seconds, three 30-second runs

// Traveller scan (mugging): page through /user/search?filters=traveling a few pages per run,
// continuing from the last run's cursor. The list holds ~7,500 players (about half of them flying
// home), so a pass takes ~25 minutes. 15 pages a run (30 calls a minute) hit Torn's 100-a-minute
// account limit alongside the key owner's other tools, so it stays at 6.
const SCAN_FILTERS = "traveling,lastActionNow,level:>=:10";
const SCAN_PAGES_PER_RUN = 6;     // 25 players per page; 12 API calls a minute at a 30 s cron
const SCAN_EXPIRE = 45 * 60;      // hard limit; normally rows go when a full pass misses them

// The travel icon (id 71) names the trip: "Traveling from Torn to Japan", "Traveling from Japan to
// Torn", or "Hiding out in Japan" / "In Japan" when they're already there.
function parseTravelIcon(title: string): { kind: "out" | "there" | "back"; country: string } | null {
  const t = title.toLowerCase();
  const ft = t.match(/from\s+(.+?)\s+to\s+(.+?)\s*$/);
  if (ft) {
    const [, from, to] = ft;
    if (/\btorn\b/.test(to)) {
      const c = findCountry(from);
      return c ? { kind: "back", country: c } : null;
    }
    const c = findCountry(to);
    return c ? { kind: "out", country: c } : null;
  }
  const c = findCountry(t);
  return c ? { kind: "there", country: c } : null;
}

async function scanTravellers(db: any, key: string, t: number) {
  const { data: meta } = await db.from("flight_watch_meta").select("scan_cursor, scan_pass_started").eq("id", 1).single();
  let url: string | null = meta?.scan_cursor || null;
  let passStarted = meta?.scan_pass_started || t;
  if (!url) {
    url = `https://api.torn.com/v2/user/search?filters=${SCAN_FILTERS}`;
    passStarted = t;
  }
  const rows: any[] = [];
  const backIds: number[] = [];
  const hospIcons: any[] = [];
  let finished = false;
  for (let i = 0; i < SCAN_PAGES_PER_RUN && url; i++) {
    const r = await fetch(`${url}${url.includes("?") ? "&" : "?"}key=${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(10000) });
    const j = await r.json();
    if (j?.error) throw new Error(`scan: Torn API ${j.error.code}: ${j.error.error}`);
    for (const u of j?.search ?? []) {
      const icons = u.icons ?? [];
      // Hospital icon (15): its description is the reason, e.g. "Mugged by X" or Ipecac.
      const hIcon = icons.find((ic: any) => ic.id === 15);
      const hosp = hIcon ? hospCause(hIcon.description) : null;
      // Log wordings we don't recognise yet, so new self-hosp methods can be added.
      if (hosp && hosp.cause === "other") hospIcons.push({ details: `[scan] ${hosp.by}`, id: u.id, name: u.name, t });
      const trip = icons.find((ic: any) => ic.id === 71);
      const loc = trip ? parseTravelIcon(String(trip.title ?? "")) : null;
      if (!loc) continue;
      if (loc.kind === "back") {
        backIds.push(u.id);
        continue;
      }
      const has = (id: number) => icons.some((ic: any) => ic.id === id);
      rows.push({
        player_id: u.id,
        name: u.name,
        level: u.level,
        faction_id: u.faction_id || null,
        online: u.online ?? null,
        kind: loc.kind,
        country: loc.country,
        bazaar: has(35),
        donator: has(3) || has(4),
        bounty: has(13),
        director: has(73),
        hosp_cause: hosp?.cause ?? null,
        hosp_by: hosp?.by ?? null,
        seen_at: t,
      });
    }
    url = j?._metadata?.links?.next ?? null;
    if (!url) finished = true;
  }
  if (rows.length) {
    // Keep first_seen while a player stays on the same trip or in the same country.
    const { data: prev } = await db.from("flight_watch_scan").select("player_id, kind, country, first_seen").in("player_id", rows.map((r) => r.player_id));
    const prevById = new Map<number, any>((prev ?? []).map((p: any) => [Number(p.player_id), p]));
    for (const r of rows) {
      const p = prevById.get(Number(r.player_id));
      r.first_seen = p && p.kind === r.kind && p.country === r.country ? p.first_seen : t;
      // Still "flying" after longer than the slowest ticket takes: that trip ended and this is a
      // new one we didn't see start (a quick round trip between passes). Restart the clock.
      if (r.kind === "out" && t - r.first_seen > DESTS[r.country].t[0] * 60 + 120) r.first_seen = t;
    }
    const { error } = await db.from("flight_watch_scan").upsert(rows, { onConflict: "player_id" });
    if (error) throw new Error(`scan upsert: ${error.message}`);
  }
  if (hospIcons.length) {
    const { error } = await db.rpc("flight_watch_log_hosp", { p_rows: hospIcons });
    if (error) console.error("scan hosp log", error.message);
  }
  if (backIds.length) await db.from("flight_watch_scan").delete().in("player_id", backIds);
  await db.from("flight_watch_scan").delete().lt("seen_at", t - SCAN_EXPIRE);
  const update: any = { scan_cursor: finished ? null : url, scan_pass_started: passStarted, scan_error: null };
  if (finished) {
    // Anyone this whole pass didn't return has gone inactive, landed back in Torn or stopped
    // travelling, so drop them now instead of leaving them listed as flying.
    await db.from("flight_watch_scan").delete().lt("seen_at", passStarted - 60);
    const { count } = await db.from("flight_watch_scan").select("player_id", { count: "exact", head: true });
    update.scan_last_pass = t;
    update.scan_total = count ?? 0;
  }
  await db.from("flight_watch_meta").update(update).eq("id", 1);
  return rows.length;
}

// Torn's hospital reason (status.details, or the hospital icon on search results).
// Self-inflicted: "Severe emesis following Ipecac Syrup ingestion", "Suffering from an acute
// hemolytic transfusion reaction". Otherwise "Mugged by X", "Attacked by X", "Lost to X".
function hospCause(text: unknown): { cause: string; by: string | null } | null {
  const s = String(text ?? "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
  if (!s) return null;
  if (/ipecac/i.test(s)) return { cause: "ipecac", by: null };
  if (/transfusion|hemolytic|haemolytic/i.test(s)) return { cause: "blood", by: null };
  const m = s.match(/^(mugged by|attacked by|hospitali[sz]ed by|lost to)\s*(.*)$/i);
  if (m) {
    const verb = m[1].toLowerCase();
    const cause = verb.startsWith("mugged") ? "mugged" : verb.startsWith("lost") ? "lost" : "attacked";
    const by = m[2] && !/^someone$/i.test(m[2]) ? m[2].slice(0, 40) : null;
    return { cause, by };
  }
  return { cause: "other", by: s.slice(0, 80) };
}

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
  const r = await fetch(`https://api.torn.com/v2/${path}${path.includes("?") ? "&" : "?"}key=${encodeURIComponent(key)}`, {
    signal: AbortSignal.timeout(10000),
  });
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

    // Enemy factions, plus our own faction (side 'friend') so the script can warn mates flying into danger.
    const targets = [
      ...enemies.map((e) => ({ id: e.id, name: e.name, side: "enemy" })),
      ...(ownId ? [{ id: ownId, name: "own", side: "friend" }] : []),
    ];
    const lists = await Promise.all(
      targets.map((f) => torn(f.side === "friend" ? "faction/members?striptags=true" : `faction/${f.id}/members?striptags=true`, key)),
    );

    const { data: existing } = await db.from("flight_watch_members").select("*");
    const prevById = new Map<number, any>((existing ?? []).map((r: any) => [Number(r.player_id), r]));

    const rows: any[] = [];
    lists.forEach((data, i) => {
      const fac = targets[i];
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
            // Took off since the last poll. If that poll was recent, split the difference.
            // After a long gap (missed runs) the takeoff time is unknown, so don't guess.
            const gap = t - Number(prev.seen_at);
            depart_at = gap <= MAX_GAP ? t - Math.round(gap / 2) : null;
          } else if (prev && !moved) {
            depart_at = prev.depart_at;
          }
        }
        const idx = plane && plane in PLANE_INDEX ? PLANE_INDEX[plane] : null;
        const mins = loc.country && idx !== null ? DESTS[loc.country].t[idx] : null;
        const eta = loc.kind === "out" ? (s.until && s.until > t ? s.until : depart_at && mins ? depart_at + mins * 60 : null) : null;
        const biz_eta = loc.kind === "out" && plane === "airliner" && depart_at ? depart_at + DESTS[loc.country!].t[3] * 60 : null;
        const hc = String(s.state ?? "").toLowerCase() === "hospital" ? hospCause(s.details) : null;

        rows.push({
          side: fac.side,
          player_id: m.id,
          faction_id: fac.id,
          faction_name: fac.name,
          name: m.name,
          level: m.level,
          state: s.state ?? null,
          description: s.description ?? null,
          details: s.details ?? null,
          kind: loc.kind,
          country: loc.country,
          plane,
          hosp: !!loc.hosp,
          hosp_until: loc.hosp ? s.until ?? null : null,
          hosp_cause: hc?.cause ?? null,
          hosp_by: hc?.by ?? null,
          depart_at,
          eta,
          biz_eta,
          seen_at: t,
          changed_at: moved ? t : prev.changed_at,
        });
      }
    });

    // Log hospital wordings we don't recognise yet, once per stay.
    const hospLog = rows
      .filter((r) => r.hosp_cause === "other" && r.details)
      .filter((r) => prevById.get(Number(r.player_id))?.details !== r.details)
      .map((r) => ({ details: r.details, id: r.player_id, name: r.name, t }));
    if (hospLog.length) {
      const { error } = await db.rpc("flight_watch_log_hosp", { p_rows: hospLog });
      if (error) console.error("hosp log", error.message);
    }

    if (rows.length) {
      const { error } = await db.from("flight_watch_members").upsert(rows, { onConflict: "player_id" });
      if (error) throw new Error(error.message);
    }
    // Drop members of factions we no longer watch, and anyone who left a watched faction.
    const keep = new Set(rows.map((r) => Number(r.player_id)));
    const gone = [...prevById.keys()].filter((id) => !keep.has(id));
    if (gone.length) await db.from("flight_watch_members").delete().in("player_id", gone);

    await db.from("flight_watch_meta").update({ last_poll: t, last_error: null }).eq("id", 1);

    // Traveller scan runs after the war tracking and can't break it.
    let scanned = 0;
    let scanError: string | null = null;
    try {
      scanned = await scanTravellers(db, key, t);
    } catch (e) {
      scanError = String((e as Error).message ?? e);
      await db.from("flight_watch_meta").update({ scan_error: scanError }).eq("id", 1);
    }
    return new Response(JSON.stringify({ ok: true, enemies: enemies.length, rows: rows.length, scanned, scanError }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    await db.from("flight_watch_meta").update({ last_poll: t, last_error: String((e as Error).message ?? e) }).eq("id", 1);
    return new Response(String(e), { status: 500 });
  }
});
