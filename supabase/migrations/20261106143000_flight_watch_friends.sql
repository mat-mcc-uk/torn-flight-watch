-- Track our own faction's members too, so the script can warn mates flying into danger.
alter table public.flight_watch_members add column if not exists side text not null default 'enemy';

create or replace function public.flight_watch_read(p_token text)
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

  -- Cloudflare's cf-connecting-ip can't be forged by the client; fall back to Supabase's header,
  -- then the LAST x-forwarded-for entry (the first is whatever the client sent).
  v_xff := string_to_array(replace(coalesce(v_h ->> 'x-forwarded-for', ''), ' ', ''), ',');
  v_ip := coalesce(
    nullif(v_h ->> 'cf-connecting-ip', ''),
    nullif(v_h ->> 'sb-forwarded-for', ''),
    nullif(v_xff[array_length(v_xff, 1)], ''),
    'unknown'
  );

  select window_start, n into v_start, v_n from flight_watch_hits where ip = v_ip for update;
  if v_start is not null and v_start > now() - c_win then
    if v_n >= c_max then
      return jsonb_build_object('throttled', true, 'retry_in', ceil(extract(epoch from (v_start + c_win - now()))));
    end if;
    update flight_watch_hits set n = n + 1, last_at = now() where ip = v_ip;
  else
    insert into flight_watch_hits (ip, last_at, window_start, n) values (v_ip, now(), now(), 1)
      on conflict (ip) do update set last_at = excluded.last_at, window_start = excluded.window_start, n = 1;
  end if;

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
      from flight_watch_members where kind <> 'torn' and side = 'enemy'), '[]'::jsonb),
    'friends', coalesce((
      select jsonb_agg(jsonb_build_object(
        'player_id', player_id, 'name', name, 'level', level, 'kind', kind, 'country', country,
        'plane', plane, 'hosp', hosp, 'depart_at', depart_at, 'eta', eta, 'biz_eta', biz_eta))
      from flight_watch_members where kind <> 'torn' and side = 'friend'), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.flight_watch_read(text) from public;
grant execute on function public.flight_watch_read(text) to anon, authenticated;
