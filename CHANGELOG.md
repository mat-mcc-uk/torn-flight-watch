# Changelog

## 1.15 (12 November 2026)

**Mug tab shows only rows it's confident about.** A scan sighting now counts for 30% of the flight time to the chosen country (at least 5 minutes): about 8 minutes for Mexico, 90 for South Africa. Older rows, and inbound players past the latest time they could land, are hidden behind "Show N stale". Inbound rows show "lands by HH:MM" (the latest possible landing) instead of how long ago the scan saw them. Live checks with your key now go to the rows closest to expiring, abroad players included, and a confirmed row gets a green edge and "✓ live" for 3 minutes. A summary line counts confirmed, scanned and hidden rows. The filter is renamed "Live checks + landing alerts".

## 1.14 (12 November 2026)

- 1.14.2: drug overdoses get their own amber badge, e.g. "overdose (Xanax)", separate from self-hospitalisation.
- 1.14.1: the Mug tab no longer lists players as flying long after they must have landed. The server now drops anyone a full scan pass didn't find (they went inactive, landed back in Torn or stopped travelling) instead of keeping them for 45 minutes. A flight that has outlasted the slowest ticket restarts its "seen" clock as a new trip, and the script hides any leftover that's overdue.

**Hospital reasons.** Players in hospital abroad now show why: a purple "self-hosp (Ipecac)" or "self-hosp (blood bag)" badge for self-hospitalisation, or a red "mugged by X", "hospitalised by X" or "lost to X" badge. The badges appear on the War board and in the Mug tab, and the Warn message says "self-hospitalised" for those players. The Mug filters gain "Hide in hospital". The server reads the reason from Torn's `status.details` for factions and from the hospital icon on player search results, so this costs no extra API calls. Wording it doesn't recognise is logged on the server so new methods can be added.

## 1.13.1 (12 November 2026)

Added the API key and data disclosure required by Torn's API Terms of Service: a table in the README and under the API key field in Settings.

## 1.13 (10 November 2026)

**Draggable button.** Drag the Flight Watch button anywhere; the position is remembered per device and survives rotation. The panel opens next to the button (above it in the lower half of the screen, below it in the upper half). A tap still opens the panel, including on touch screens that don't send a click after a drag. Settings has a link to put the button back in the corner.

## 1.12 (10 November 2026)

**Mug tab.** Shows active players flying to, or already in, a country you pick, from a server scan of Torn's player search. Each player has level, FFScouter estimate, online status, tags (no faction, bazaar, donator, bounty, director) and an Attack link. Filters cover level, max stats, online, no faction, bazaar and donator. The script checks the live status of the longest-flying inbound players and alerts the moment one lands.

## 1.11 (7 November 2026)

**Tap a safe country to fly there.** The safe flags in the panel open Torn's travel agency with that destination selected. You pick the ticket and press Travel yourself.
- 1.11.6: when the Warn fill-in fails, a Message page report is saved in Raw statuses. After writing, the script reads the message box back before saying it worked.
- 1.11.5: uses the controls of Torn's real travel page: the map pins, then the destination dropdown if a pin doesn't take. It ignores other scripts' country pickers on the same page.
- 1.11.4: fixed PDA always selecting the previously tapped country. The choice now travels in the link instead of slow storage. The script also reads the selector back and only says "selected" when it really is.
- 1.11.2: fixed the whole travel page being ruled out as "sidebar". The script also searches shadow roots and frames, and the travel report gives more detail.
- 1.11.1: handles the "Torn → destination" selector. Adds the travel page report.

## 1.10 (6 November 2026)

**Warnings name the enemies**, with landing times and FFScouter battle stat estimates. Estimates also show in the panel.
- 1.10.1: the message fill-in only writes inside Torn's "Send a Message" box, and never over existing text. Earlier versions could write into the sidebar Notes box.

## 1.9 (6 November 2026)

**Warn writes the message for you.** The subject and warning are filled into Torn's message form, and you press Send.

## 1.8 (6 November 2026)

**New panel.** Flags for every country, risky countries as cards with counts and the next landing time, and safe countries folded into a row.
**Faction mates at risk.** The server also tracks your own faction, and the panel lists mates in or flying to a risky country, with a Warn button.

## 1.7 (6 November 2026)

On PDA 3.15+, data is saved in PDA's native storage instead of the shared browser storage.

## 1.6 (6 November 2026)

When the server is up, the board and alerts are built from the server's data, and your key only checks your own status. This halves API use.
- 1.6.5 / 1.6.4: copes with a full browser storage on torn.com: keeps working from memory, saves far less, and frees the old copy before retrying.
- 1.6.3: a newer copy takes over polling from an older one, and the panel warns about duplicate installs.
- 1.6.2: the panel shows the running version and a server data summary.
- 1.6.1: PDA's Torn calls go through PDA's own request handler. The server allows 4 reads per IP every 10 seconds, so a PC and phone on one connection don't throttle each other.

## 1.5 (6 November 2026)

The server token is built in, so there's nothing to set up. Reads go through a rate-limited database function.
- 1.5.3 / 1.5.1: server reads go through Tampermonkey's and PDA's own request functions, which aren't blocked by torn.com's page rules.
- 1.5.2: takeoff times aren't guessed after a long gap, polls can't overlap, and every request has a 10-second timeout.
- The rate limit uses the IP Cloudflare attaches to the request, which can't be faked.

## 1.4 (6 November 2026)

**24/7 server on Supabase.** It records enemy takeoff times even when nobody has Torn open, so every flight gets a landing countdown, marked `(srv)`.

## 1.3 (6 November 2026)

First release on GitHub. Safe/risky board for all 11 countries, auto-detection of the enemy faction from your faction's wars, alerts for the country you're in or flying to, and the Raw statuses view.
- 1.3.2: reads Torn's "Traveling from X to Y" status wording.
- 1.3.1: Torn PDA support.
