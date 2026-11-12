-- One batch can hold the same wording twice (two players, same reason). Collapse duplicates
-- first so ON CONFLICT doesn't touch a row twice.
create or replace function public.flight_watch_log_hosp(p_rows jsonb)
returns void language sql security definer set search_path = public as $$
  insert into flight_watch_hosp_reasons (details, sample_id, sample_name, seen_count, first_seen, last_seen)
  select details, (array_agg(id))[1], (array_agg(name))[1], count(*), max(t), max(t)
  from (
    select r->>'details' details, (r->>'id')::bigint id, r->>'name' name, (r->>'t')::bigint t
    from jsonb_array_elements(p_rows) r
    where coalesce(r->>'details', '') <> ''
  ) x
  group by details
  on conflict (details) do update
    set seen_count = flight_watch_hosp_reasons.seen_count + excluded.seen_count,
        last_seen  = excluded.last_seen,
        sample_id  = excluded.sample_id,
        sample_name = excluded.sample_name;
$$;
revoke all on function public.flight_watch_log_hosp(jsonb) from public, anon, authenticated;
