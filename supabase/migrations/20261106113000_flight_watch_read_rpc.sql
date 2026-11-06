-- Read path for the userscript. Runs through PostgREST instead of an edge function,
-- so reads don't count against the edge function invocation quota.
create table public.flight_watch_hits (
  ip       text primary key,
  last_at  timestamptz not null
);
alter table public.flight_watch_hits enable row level security;
revoke all on public.flight_watch_hits from anon, authenticated;

create or replace function public.flight_watch_read(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ip   text;
  v_last timestamptz;
begin
  if p_token is null or p_token <> (select read_token from flight_watch_secrets where id = 1) then
    return jsonb_build_object('error', 'bad token');
  end if;

  -- One fresh read per IP every 10 seconds. Faster callers get a tiny reply.
  v_ip := coalesce(
    split_part(coalesce(current_setting('request.headers', true)::jsonb ->> 'x-forwarded-for', ''), ',', 1),
    'unknown'
  );
  select last_at into v_last from flight_watch_hits where ip = v_ip;
  if v_last is not null and v_last > now() - interval '10 seconds' then
    return jsonb_build_object('throttled', true, 'retry_in', ceil(extract(epoch from (v_last + interval '10 seconds' - now()))));
  end if;
  insert into flight_watch_hits (ip, last_at) values (v_ip, now())
    on conflict (ip) do update set last_at = excluded.last_at;

  -- Housekeeping so the table stays small.
  delete from flight_watch_hits where last_at < now() - interval '1 hour';

  return jsonb_build_object(
    'now', extract(epoch from now())::bigint,
    'meta', (select jsonb_build_object('enemies', enemies, 'last_poll', last_poll, 'last_error', last_error)
             from flight_watch_meta where id = 1),
    'members', coalesce((
      select jsonb_agg(jsonb_build_object(
        'player_id', player_id, 'faction_id', faction_id, 'faction_name', faction_name,
        'name', name, 'level', level, 'kind', kind, 'country', country, 'plane', plane,
        'hosp', hosp, 'hosp_until', hosp_until, 'depart_at', depart_at, 'eta', eta,
        'biz_eta', biz_eta, 'seen_at', seen_at))
      from flight_watch_members where kind <> 'torn'), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.flight_watch_read(text) from public;
grant execute on function public.flight_watch_read(text) to anon, authenticated;
