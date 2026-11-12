-- Keep Torn's hospital reason (status.details) and log each distinct wording seen,
-- so self-hospitalisation (Ipecac, wrong blood type) can be told apart from attacks.
alter table public.flight_watch_members add column if not exists details text;

create table if not exists public.flight_watch_hosp_reasons (
  details     text primary key,
  sample_id   bigint,
  sample_name text,
  seen_count  integer not null default 1,
  first_seen  bigint not null,
  last_seen   bigint not null
);
alter table public.flight_watch_hosp_reasons enable row level security;

create or replace function public.flight_watch_log_hosp(p_rows jsonb)
returns void language sql security definer set search_path = public as $$
  insert into flight_watch_hosp_reasons (details, sample_id, sample_name, first_seen, last_seen)
  select r->>'details', (r->>'id')::bigint, r->>'name', (r->>'t')::bigint, (r->>'t')::bigint
  from jsonb_array_elements(p_rows) r
  where coalesce(r->>'details', '') <> ''
  on conflict (details) do update
    set seen_count = flight_watch_hosp_reasons.seen_count + 1,
        last_seen  = excluded.last_seen,
        sample_id  = excluded.sample_id,
        sample_name = excluded.sample_name;
$$;
revoke all on function public.flight_watch_log_hosp(jsonb) from public, anon, authenticated;
