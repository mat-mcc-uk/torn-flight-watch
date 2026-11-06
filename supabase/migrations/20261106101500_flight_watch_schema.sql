create extension if not exists pg_cron;
create extension if not exists pg_net;
create extension if not exists pgcrypto;

create table public.flight_watch_members (
  player_id    bigint primary key,
  faction_id   bigint not null,
  faction_name text,
  name         text,
  level        int,
  state        text,
  description  text,
  kind         text not null,          -- out | there | back | torn
  country      text,
  plane        text,
  hosp         boolean not null default false,
  hosp_until   bigint,
  depart_at    bigint,                 -- unix seconds, estimated takeoff
  eta          bigint,
  biz_eta      bigint,
  seen_at      bigint not null,
  changed_at   bigint not null
);
create index flight_watch_members_faction_idx on public.flight_watch_members (faction_id);

create table public.flight_watch_meta (
  id              int primary key default 1 check (id = 1),
  own_faction_id  bigint,
  enemies         jsonb not null default '[]'::jsonb,
  war_checked_at  bigint not null default 0,
  last_poll       bigint not null default 0,
  last_error      text
);
insert into public.flight_watch_meta (id) values (1);

create table public.flight_watch_secrets (
  id          int primary key default 1 check (id = 1),
  cron_token  text not null default encode(gen_random_bytes(24), 'hex'),
  read_token  text not null default encode(gen_random_bytes(12), 'hex')
);
insert into public.flight_watch_secrets (id) values (1);

-- No policies: only the service role (edge functions) can touch these.
alter table public.flight_watch_members enable row level security;
alter table public.flight_watch_meta    enable row level security;
alter table public.flight_watch_secrets enable row level security;
revoke all on public.flight_watch_members, public.flight_watch_meta, public.flight_watch_secrets from anon, authenticated;
