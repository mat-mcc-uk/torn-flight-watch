-- Use the IP Cloudflare sets (clients can't forge cf-connecting-ip; Cloudflare rejects it),
-- then Supabase's own header, then the LAST x-forwarded-for entry. The first entry is
-- whatever the client sent, which is how the old version could be dodged.
create or replace function public.flight_watch_read(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_h    jsonb := coalesce(current_setting('request.headers', true)::jsonb, '{}'::jsonb);
  v_xff  text[];
  v_ip   text;
  v_last timestamptz;
begin
  if p_token is null or p_token <> (select read_token from flight_watch_secrets where id = 1) then
    return jsonb_build_object('error', 'bad token');
  end if;

  v_xff := string_to_array(replace(coalesce(v_h ->> 'x-forwarded-for', ''), ' ', ''), ',');
  v_ip := coalesce(
    nullif(v_h ->> 'cf-connecting-ip', ''),
    nullif(v_h ->> 'sb-forwarded-for', ''),
    nullif(v_xff[array_length(v_xff, 1)], ''),
    'unknown'
  );

  -- One fresh read per IP every 10 seconds. Faster callers get a tiny reply.
  select last_at into v_last from flight_watch_hits where ip = v_ip;
  if v_last is not null and v_last > now() - interval '10 seconds' then
    return jsonb_build_object('throttled', true, 'retry_in', ceil(extract(epoch from (v_last + interval '10 seconds' - now()))));
  end if;
  insert into flight_watch_hits (ip, last_at) values (v_ip, now())
    on conflict (ip) do update set last_at = excluded.last_at;

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
