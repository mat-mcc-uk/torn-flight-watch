-- Traveller scan: players found through /user/search?filters=traveling, with where they are or
-- where they're flying, and a few public profile icons used as filters.
create table if not exists public.flight_watch_scan (
  player_id   bigint primary key,
  name        text,
  level       int,
  faction_id  bigint,
  online      text,                -- Online / Idle / Offline at scan time
  kind        text not null,       -- out | there
  country     text,
  bazaar      boolean not null default false,
  donator     boolean not null default false,   -- donator or subscriber
  bounty      boolean not null default false,
  director    boolean not null default false,   -- company director
  first_seen  bigint not null,     -- first scan that saw this kind+country
  seen_at     bigint not null
);
create index if not exists flight_watch_scan_country_idx on public.flight_watch_scan (country, kind);
alter table public.flight_watch_scan enable row level security;
revoke all on public.flight_watch_scan from anon, authenticated;

alter table public.flight_watch_meta add column if not exists scan_cursor text;
alter table public.flight_watch_meta add column if not exists scan_pass_started bigint not null default 0;
alter table public.flight_watch_meta add column if not exists scan_last_pass bigint not null default 0;
alter table public.flight_watch_meta add column if not exists scan_total int not null default 0;
alter table public.flight_watch_meta add column if not exists scan_error text;

-- One country's scanned travellers (flying there or already there), rate-limited like flight_watch_read.
create or replace function public.flight_watch_scan_read(p_token text, p_country text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_h     jsonb := coalesce(current_setting('request.headers', true)::jsonb, '{}'::jsonb);
  v_xff   text[];
  v_ip    text;
  v_start timestamptz;
  v_n     int;
  c_max   constant int := 4;
  c_win   constant interval := interval '10 seconds';
begin
  if p_token is null or p_token <> (select read_token from flight_watch_secrets where id = 1) then
    return jsonb_build_object('error', 'bad token');
  end if;
  v_xff := string_to_array(replace(coalesce(v_h ->> 'x-forwarded-for', ''), ' ', ''), ',');
  v_ip := 'scan:' || coalesce(
    nullif(v_h ->> 'cf-connecting-ip', ''),
    nullif(v_h ->> 'sb-forwarded-for', ''),
    nullif(v_xff[array_length(v_xff, 1)], ''),
    'unknown'
  );
  select window_start, n into v_start, v_n from flight_watch_hits where ip = v_ip for update;
  if v_start is not null and v_start > now() - c_win then
    if v_n >= c_max then
      return jsonb_build_object('throttled', true);
    end if;
    update flight_watch_hits set n = n + 1, last_at = now() where ip = v_ip;
  else
    insert into flight_watch_hits (ip, last_at, window_start, n) values (v_ip, now(), now(), 1)
      on conflict (ip) do update set last_at = excluded.last_at, window_start = excluded.window_start, n = 1;
  end if;

  return jsonb_build_object(
    'now', extract(epoch from now())::bigint,
    'meta', (select jsonb_build_object('last_pass', scan_last_pass, 'total', scan_total, 'error', scan_error) from flight_watch_meta where id = 1),
    'players', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', player_id, 'name', name, 'level', level, 'faction_id', faction_id, 'online', online,
        'kind', kind, 'bazaar', bazaar, 'donator', donator, 'bounty', bounty, 'director', director,
        'first_seen', first_seen, 'seen_at', seen_at) order by kind, first_seen desc)
      from (select * from flight_watch_scan where country = p_country and kind in ('out', 'there') limit 600) s), '[]'::jsonb)
  );
end;
$$;
revoke all on function public.flight_watch_scan_read(text, text) from public;
grant execute on function public.flight_watch_scan_read(text, text) to anon, authenticated;
