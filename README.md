# Torn Flight Watch

A Tampermonkey userscript for Torn City. It tracks the members of the factions you're at war with, marks each country as safe or risky, and sends alerts when enemies fly to, land in, or leave the country you're in or heading to.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) in your browser.
2. Open the [raw script](https://raw.githubusercontent.com/mat-mcc-uk/torn-flight-watch/main/torn-flight-watch.user.js) and click Install.
3. Load any torn.com page, tap the **Fly** button in the bottom-left corner, open **Settings** and paste in a Public API key.

Tampermonkey checks this repo for updates on its own schedule.

**Torn PDA:** add the script under Settings > Userscripts using the raw link. PDA fills in your API key automatically. PDA keeps its own settings, separate from your browser.

## What it does

**Enemy factions**
- Auto mode watches whoever your faction is at war with: the ranked war opponent (from the moment the war is matched), plus raids and territory wars if you tick that option.
- Fixed mode takes one or more faction IDs, comma separated.

**Country board**
- Lists all 11 destinations, each tagged SAFE or RISKY.
- A country is risky when any enemy is there, in hospital there, or flying there. Enemies flying back to Torn don't count.
- Tap a risky country to see names, plane types and landing countdowns.

**Your location**
- The script reads your own status, so it always knows the country you're in or flying to.
- The button turns green or red for that country and shows how many enemies are there or on the way.
- In Torn, the button shows how many countries are risky.

**Alerts** (only for the country you're in or flying to)
- Safe/risky summary when you take off somewhere
- Enemy takes off for your country, with plane type and estimated landing time
- Enemy about to land (5 minutes before by default)
- Enemy landed
- Enemy leaves your country (off by default)

Alerts appear as browser notifications and an on-page toast, and can also post to a Discord webhook.

## How landing times are worked out

The Torn API doesn't give another player's arrival time, but it does say which plane they're on (`plane_image_type`):

| Plane | Travel type |
| --- | --- |
| `light_aircraft` | Airstrip |
| `private_jet` | Private (WLT) |
| `airliner` | Standard or business class |

The script records when it first sees someone take off and adds that country's flight time. Business class uses the same airliner image as standard, so airliner flights show both countdowns. The landing alert still catches business-class arrivals.

Accuracy depends on the poll interval. At the default 30 seconds, takeoff times can be off by up to about 15 seconds. Anyone already in the air when the script starts shows without an ETA.

Flight times live in the `DESTS` table at the top of the script.

## Server (optional)

Without the server, a flight only gets an ETA if someone's script saw it take off. The server closes that gap. It runs on Supabase and polls the enemy factions every 30 seconds around the clock, recording takeoff times.

- `supabase/functions/flight-watch-poll`: called by `pg_cron` every 30 seconds. It works out who the faction is at war with, fetches their members and stores each player's location and estimated takeoff time.
- `flight_watch_read` (database function, in `supabase/migrations`): returns that data to the userscript through Supabase's REST API. It checks the faction read token and allows one fresh read per IP every 10 seconds. Reads this way don't count against the edge function quota.
- `supabase/functions/flight-watch-read`: retired, kept only to tell old script versions to update.
- `supabase/migrations`: the tables, the read function and the cron job.

The script ships with the read token and the project's publishable key built in, so nobody has to set anything up. The token only unlocks enemy positions, which all come from the public Torn API. To rotate it, run `update flight_watch_secrets set read_token = encode(gen_random_bytes(12), 'hex');`, then put the new value in `SERVER_TOKEN` and bump the version. Until people update, they can paste the new token into **Server token override** in Settings.

The server uses one Public Torn API key, stored as the `TORN_API_KEY` edge function secret. The key must belong to a member of your faction, because it decides which wars count. The tables have row level security on and no public policies, so only the server functions can read them.

Flights the server timed show `(srv)` next to their countdown.

## API usage

Everything works with a Public access key. Each poll makes one call for your own status plus one per enemy faction. The war lookup runs every 5 minutes. A single ranked war at the default 30-second poll uses about 5 calls a minute, well under Torn's 100-per-minute limit.

Only one Torn tab polls at a time, so several open tabs don't double up the calls or the alerts.

## Troubleshooting

Tap **Raw statuses** at the bottom of the panel. It shows how many members were fetched for each watched faction, plus the exact state and description the API returned for every enemy who isn't sitting in Torn, next to how the script read it. If an enemy shows up there as `torn` when they're actually abroad or flying, the text didn't match a country.

## Known gaps

- The script only runs while a Torn tab is open.
- The words used to spot enemies in hospital abroad ("In a Japanese hospital" and similar) are a best guess. They're in the `adj` lists in `DESTS` if any need fixing.

## Author

Ripcorder [4252513]
