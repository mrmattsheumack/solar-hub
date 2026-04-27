# Solar Hub — Pending Improvements

This file tracks pending fixes and improvements that have been identified but not yet implemented. Add new items as they come up; remove (or move to a "Done" section) as they ship. The point is durability — anything captured here survives across AI chat sessions.

## UI / UX

### Room card power button — rotate 90° clockwise
**Reported:** 2026-04-27
**Status:** Open

The power symbol icon on each room card currently appears sideways. The path inside the SVG (the C-arc with the vertical line) is rotated incorrectly. Rotating it 90° to the right (clockwise) makes it look correct.

Touchpoint: `buildThermoCard` in `solar-hub/public/index.html` — search for the SVG inside the per-room power button (around line 3632 currently). The fix is most likely a `transform="rotate(90)"` on the path or `<svg>` element, or swapping the path data for the standard power-glyph orientation.

### Damper slider on dashboard cards (no need to drill in)
**Reported:** 2026-04-27
**Status:** Open

Currently the damper position slider only appears in the focused room detail overlay. Goal: surface the same slider directly on each room card on the home dashboard so the user can adjust airflow per room without clicking into individual room views.

Touchpoint: `buildThermoCard` in `solar-hub/public/index.html`. The detail overlay already has a damper slider implemented; lift the same control onto the card. Considerations:
- Card real estate is tight — slider must be compact (probably a thin horizontal bar, not the bigger overlay version)
- The control needs to write to climate.rooms[id].damper AND send the corresponding command to iZone (likely a SysSetpoint-style command on the zone — verify this is supported on Matt's hardware before wiring; iZone Genius accepts MaxAir per zone via ZoneMode override but may not accept per-zone setpoint adjustments — same constraint as setpoint)
- Quick gotcha: if iZone returns {ERROR} on the command (per the per-zone setpoint constraint we already documented), then this becomes "local only" — store in localStorage but don't send to iZone, until a real test confirms. Verify on the Pi before wiring up.

### Slow first-load — rooms appear off for up to 20 seconds before iZone state syncs
**Reported:** 2026-04-27
**Status:** Open — needs diagnosis

After deploying the isOpen=false flicker fix (commit 70e46c4), Matt observed that on a fresh page load (incognito), rooms remain off for up to 20 seconds before the actual iZone-on rooms light up. Expected sync time after the fix is 2-5 seconds, so 20s indicates something is slower than it should be.

**Suspected causes:**
1. fetchSensors call (added in eb0c8a8) is in series with the iZone fetch inside fetchIzone — adds latency to room render
2. Bridge cold start — Tailscale Funnel and bridge requests session may take longer on first request
3. iZone returning {ERROR} on first call, triggering retry chain (400+800+1600ms = 2.8s extra delay)
4. Some part of the page-load chain is blocking on a slow non-essential request

**How to diagnose next session:**
1. Open Solar Hub in incognito Chrome
2. Open dev console BEFORE page settles (or paste timing trace immediately)
3. Trace fetchIzone start-to-end timing using performance.now()
4. Identify whether iZone fetch, sensors fetch, or bridge round-trip is the bottleneck

**Possible fixes (apply after diagnosis confirms cause):**
- Run fetchSensors in parallel with iZone fetch instead of sequential (Promise.all)
- Skip fetchSensors entirely on the first sync — only run it from sync-2 onward
- Render rooms immediately on first iZone success without waiting for sensor fetch

Touchpoint: `fetchIzone` and `fetchSensors` in `solar-hub/public/index.html` (around lines 4395 and 4282).
