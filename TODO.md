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

## Performance

### Adaptive iZone polling frequency
**Reported:** 2026-04-28
**Status:** Open

The 30-second background poll runs constantly regardless of whether the user is looking at the page or whether anything is changing. Each poll costs 3-6 seconds of network on 4G and ~2 seconds on WiFi.

Improvements to consider:
1. **Pause polling when tab hidden**: Use `document.visibilityState === 'hidden'` to skip the interval. Resume on visibility change. Easy win.
2. **Adaptive frequency**: Poll every 30s when AC system is active (any zone open), every 90s or 120s when system is off. Lower-priority polish.
3. **Skip poll when no recent user interaction**: After 5 minutes of no interaction, drop to slow poll (60-90s). User sees fresh state when they come back via on-focus poll.

Touchpoint: `setInterval(() => fetchIzone()...)` in the DOMContentLoaded handler around line 4585.

Investigation steps:
- Add a single `document.addEventListener('visibilitychange', ...)` handler that pauses/resumes the interval
- Verify polling resumes immediately on tab refocus by triggering a one-shot fetchIzone() on visibilitychange to "visible"

## Done

### Room card power button — rotate 90° clockwise
**Reported:** 2026-04-27
**Done:** 2026-04-28 — root cause identified and fixed in commit `dd890a3` (after several superseded attempts in 13da34c, 5d6ac46, fdc716d, d4b4c5c)

Root cause was a descendant selector on line 1171: `.dial svg { transform: rotate(-90deg); }` was matching both the dial gauge SVG (intentional) and the per-zone power button SVG (unintentional). Fix was changing to direct-child combinator `.dial > svg` so only the gauge gets rotated. All previous inline rotation experiments were fighting this rule. Per-zone SVG inline style attribute was already removed in d4b4c5c so no further change there.

### Diagnose 20s slow first-load
**Reported:** 2026-04-27
**Done:** 2026-04-28 — instrumented and measured in commit `7b0c5d4`, closed as not reproducible

Added [PERF] markers across the page-load chain (sysQuery, izBulkZones, fetchSensors, syncRoomsFromIzone, first-render) and measured actual load times:

- WiFi cold load: 2.4-2.9 seconds total
- 4G cold load: 4.95 seconds total
- 30-second background poll on 4G: 3-6 seconds per cycle (variable)

Dominant cost is izBulkZones (1.8s WiFi, 2.8-5s on 4G) which is the 6-zone sequential fetch with intentional inter-zone delay (commit 976be97) to prevent iZone overload. Tradeoff is correct.

The original "20 second" perception could not be reproduced. Likely was a worst-case combination of cold Pi + cold Tailscale Funnel + cellular handshake + iZone retry chain on a particular day. Closing this entry.

[PERF] markers should be removed in a follow-up cleanup since they served their purpose and add console noise in production.

### Remove [PERF] instrumentation
**Reported:** 2026-04-28
**Done:** 2026-04-28

Removed all [PERF] console.log markers and associated performance.now() timing variables added in commit `7b0c5d4` for slow-load diagnosis. Production console is clean again.
