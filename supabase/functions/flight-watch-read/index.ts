// Retired: the userscript now reads through the flight_watch_read database function
// (PostgREST), which doesn't use the edge function invocation quota.
Deno.serve(() =>
  new Response(JSON.stringify({ error: "retired, update Torn Flight Watch to v1.5.0 or later" }), {
    status: 410,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  })
);
