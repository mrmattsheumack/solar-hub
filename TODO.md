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
