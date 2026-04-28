# Solar Hub — Pending Improvements

This file tracks pending fixes and improvements that have been identified but not yet implemented. Add new items as they come up; remove (or move to a "Done" section) as they ship. The point is durability — anything captured here survives across AI chat sessions.

## UI / UX

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

### Negative airflow value displayed on room cards
**Reported:** 2026-04-28
**Status:** Open

Lounge zone card was observed showing "AIRFLOW -15%". Negative airflow values shouldn't be possible — airflow percentage should be clamped to 0-100. Likely a calculation or rendering bug where a delta or signed value is being shown instead of the absolute airflow percentage.

Touchpoint: airflow rendering inside `buildThermoCard` in `solar-hub/public/index.html`. Search for "AIRFLOW" or the airflow percentage display logic.

Investigation steps:
- Confirm what value the bridge returns for that zone (should be 0-100)
- Check if Solar Hub is computing a delta or applying any transformation before display
- Add clamping `Math.max(0, Math.min(100, value))` at the render site as a safety net

### Time in dashboard header doesn't match local Melbourne time
**Reported:** 2026-04-28
**Status:** Open

Dashboard header shows e.g. "DROMANA · 13:56" when actual local time was approximately 11:50. Roughly 2 hours ahead, which suggests UTC offset handling is wrong (UTC+10 AEST vs being interpreted differently) or DST handling is off.

Touchpoint: clock rendering in `solar-hub/public/index.html`. Search for the time format string under the DROMANA header.

Investigation steps:
- Check whether time uses `new Date()` directly or applies a manual offset
- Verify the timezone in use — should be `Australia/Melbourne` to handle AEST/AEDT switching automatically
- Use `toLocaleTimeString('en-AU', { timeZone: 'Australia/Melbourne', hour: '2-digit', minute: '2-digit', hour12: false })` if not already

## Done

### Room card power button — rotate 90° clockwise
**Reported:** 2026-04-27
**Done:** 2026-04-28 — commit `13da34c`

Root cause was a descendant selector on line 1171: `.dial svg { transform: rotate(-90deg); }` was matching both the dial gauge SVG (intentional) and the per-zone power button SVG (unintentional). Fix was changing to direct-child combinator `.dial > svg` so only the gauge gets rotated. All previous inline rotation experiments were fighting this rule. Per-zone SVG inline style attribute was already removed in d4b4c5c so no further change there.
