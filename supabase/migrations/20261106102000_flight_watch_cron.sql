-- Replace the project ref in the URL if you deploy this to another project.
select cron.schedule(
  'flight-watch-poll',
  '30 seconds',
  $$
  select net.http_post(
    url := 'https://lwqcyivwyebhnqwubhuy.supabase.co/functions/v1/flight-watch-poll',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-token', (select cron_token from public.flight_watch_secrets where id = 1)
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 25000
  );
  $$
);
