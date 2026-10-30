# Solar Hub — Project Scope and Decisions

This is the durable record of what Solar Hub is, what it's not, and the key decisions
that shape it. If anything in this file conflicts with what an AI assistant remembers
from a chat session, this file wins. AI memory across sessions is unreliable; commit
your decisions here.

## Mission

Solar Hub is a single-page web app that gives Matt unified visibility and control
over his home energy systems (solar, AC, eventually battery + EV charger).

## Core economic decision: third-party wireless sensors, NOT iZone wired sensors

Matt was quoted **$1000 for 2 iZone wired room sensors** — approximately $500/room
installed. For 6 rooms that would be ~$3000.

This is rejected.

The agreed approach is **cheap third-party wireless sensors (~$10/unit) per room**,
talking to Solar Hub via the Pi bridge. Total target: <$200 for all 6 rooms
including any required hub/dongle.

This is the entire economic justification for the project. Without this approach,
the project doesn't make sense.

## Architecture: Solar Hub is the SMART LAYER

iZone hardware in Matt's home is intentionally minimal:
- One master AC setpoint for the whole system
- No per-zone sensors (`SensorFault: 1` everywhere, all `Temp` fields return 0)
- Per-zone control limited to OPEN (Mode 1) or CLOSED (Mode 2) — no per-zone
  setpoint, no per-zone temp tracking

Solar Hub adds the intelligence iZone lacks:
- Reads room temperatures from third-party wireless sensors (via Pi bridge)
- Stores per-room target temperatures locally (in browser localStorage)
- Decides which zones to open and close to achieve those targets
- Sends ZoneMode commands to iZone via the Pi bridge

Solar Hub does NOT send per-zone setpoints to iZone — those return `{ERROR}`
because the iZone hardware doesn't support them.

## What "ready for sensors" means

When Solar Hub is ready for sensors:
1. Per-room power buttons send real ZoneMode commands to iZone (DONE — Phase 2b)
2. Per-room target +/- updates local state only (DONE)
3. The Pi bridge is reliable (DONE — bulk endpoint with retries + cache)
4. The orchestration logic exists, even if it's a no-op without real temps
5. Cards visually indicate when no sensor is fitted

## Out of scope

- Sending per-zone setpoints to iZone (hardware doesn't support)
- Native iZone wired sensors (cost-prohibitive)
- Cloud-dependent sensor solutions (Govee cloud, Tuya cloud) — too fragile
- Any approach that requires installer involvement or wiring

## Hardware in play

- GoodWe GW10K-MS-30 inverter
- 30 × LONGi panels (13.2 kW DC)
- 2023 Hyundai IONIQ 5
- iZone Genius AC controller at 192.168.1.208 (no native sensors)
- Raspberry Pi `eaglecam` at 192.168.1.225 running the bridge
- Tailscale Funnel exposing the bridge to the internet

## Pending decisions (as of 2026-04-27)

- [x] Specific sensor product: ESP32-C3 Super Mini + AHT20 (temp + humidity). Pilot 2 units before scaling to 6.
- [x] Hub/dongle on the Pi: ESPHome service + Mosquitto MQTT broker on existing eaglecam Pi. WiFi-based — no Zigbee/BLE dongle needed.
- [x] Order sequence: Pilot Master + Office first (~$55 from Core Electronics), validate end-to-end, then bulk order remaining 4.

## Pilot scope agreed (sensors)

- 2 sensors first — Master and Office — to validate end-to-end before scaling
- Hardware: ESP32-C3 Super Mini + AHT20 module per sensor (~$22 each from Core Electronics)
- AC powered via USB-C (every room has power points)
- ESP32 connects to home WiFi → MQTT broker on Pi → bridge exposes data via /api/sensors/temps endpoint → Solar Hub displays per-room temp/humidity
- Future expansion: same ESP32 board can later add motion sensors (PIR or LD2410 mmWave), air quality (BME680), CO2, etc. via spare GPIO pins
- 3D printed case with airflow holes is the chosen housing approach (Thingiverse 7263708 — purpose-built for this hardware combo)
- Pilot rooms (Master + Office) chosen to test WiFi range across the house

## Done as of 2026-04-27

- Solar Hub dashboard live at solarhubdromana.netlify.app
- iZone master AC controls (power, mode, fan, setpoint) wired end-to-end
- Per-zone power buttons wired end-to-end (Phase 2b)
- Pi bridge with bulk fetch endpoint, retry/backoff, cache fallback
- Reliability: ~10/10 successful 6-zone reads, command path retries silently

## How to run a Solar Hub session with an AI assistant

1. AI reads this file FIRST
2. AI summarises the current state back to Matt
3. Matt confirms or corrects
4. THEN work begins

If the AI claims to remember something not in this file or in committed code,
treat that memory as suspect. Update this file as decisions are made.

## EV solar charging (added 2026-10-29)

Goal: charge the car from spare solar during the day, full rate on the cheap
overnight window, never relying on any data from the car itself. Two cars
(IONIQ 5, Kia EV5) share one charger; whichever is plugged in gets charged.

Rules agreed with Matt:
- 12am-6am: full 32 A whenever something is plugged in (AGL 8c off-peak).
- Daytime: match current to spare solar, 6-32 A. Solar only: pause below 6 A
  (about 1.4 kW) after riding out short dips for 5 min.
- Evening (9pm-12am): off.
- Manual override always wins: any session the controller did not start
  (charger button, EVSEMaster app START CHARGING, the charger's own schedule)
  gets full 32 A and is left alone until it ends or the car is unplugged.
  When idle the limit is reset to 32 A so a button press is always full rate.

Hardware facts (verified 2026-10-28/29):
- Charger: EVSE4280 reports as "BS20", 32 A max, single-phase, at 192.168.1.45.
  Controlled locally over the EVSEMaster UDP protocol (python `evsemaster`).
  The library drops single-phase status packets; the controller decodes them.
  A start is ignored while a finished session is held; stop first.
  The phone app and the controller can be connected at the same time.
- Inverter: live PV readable locally via Modbus TCP 192.168.1.155:502
  (WiFi/LAN Kit-20, python `goodwe`, family DT). No local meter data.
- House load comes from SEMS (cloud, lagged a few minutes), in watts.
- Live test 2026-10-29: car follows current changes within ~10 s.

Where it runs: Pi `eaglecam`, ~/solar-hub-pi/ev_solar.py, systemd ev-solar,
venv ~/solar-hub-pi/evtest. Live (DRY_RUN=0) since 2026-10-29 20:11 with Matt's approval.
Logs: ~/solar-hub-pi/ev_solar.log (JSON lines), ev_state.json (latest).

## SEMS endpoint change (2026-10-29)

After GoodWe moved the account to SEMS+, GetMonitorDetailByPowerstationId
returns code 0 with empty data, so Solar Hub showed zeros. Live data now comes
from v2/PowerStation/GetPowerflow (gridStatus -1 = import, 1 = export) and
today's generation from v3/PowerStation/GetPlantDetailByPowerstationId.

## Home Overview wall display (added 2026-10-30)

Goal: one always-on screen that joins up weather, the WS90, rain radar, solar
and EV charging, and links through to the EV page and the main app.

Decisions agreed with Matt:
- Lives at `public/home.html` on the same Netlify site. Read-only; controls stay
  on ev.html and index.html. Linked from the main nav ("Wall Overview") and
  from ev.html ("Overview ›").
- Primary device is an always-on landscape tablet or wall screen: dark by
  default, no scrolling at 1280x800 and up, stacks and scrolls on phones.
- Radar is RainViewer (free Weather Maps API). Free tier since 1 Jan 2026:
  past 2 hours only (10-minute frames, no nowcast), Universal Blue colour
  scheme only, max native zoom 7 (overzoomed on the map), 100 requests per IP
  per minute. A "BoM radar" link opens the Melbourne loop for detail.
- No new data plumbing: reuses `ev`, `sems`, `ecowitt` and `forecast`
  functions. Live PV prefers the inverter Modbus reading (`pv_live_w` in the
  controller state) when fresh, falling back to SEMS.
- Wall behaviour: screen wake lock, dims 10pm-6am (tap to brighten for a
  minute, `?dim=off` disables), small layout shift every 4 min against burn-in,
  full reload every 6 h, polling pauses when the tab is hidden.
- Heads-up notes are rule-based (station rain, forecast rain within 6 h, gusts
  >= 55 km/h, solar left vs car plugged in, tomorrow's solar after 5pm, high UV,
  Pi unreachable). Max three shown.

Revision 2 (2026-10-30, Matt's feedback):
- Basemap moved from CARTO to Esri Canvas (dark grey base plus a labels layer
  above the radar). CARTO stopped serving keyless tiles in 2026; they come back
  watermarked "API KEY REQUIRED", which made the radar look broken.
- Weather tile retitled "Weather" (title is ready to link to a detail page via
  WX_DETAIL_URL). Outside and inside temps shown at the same size. Shows
  feels like, humidity, next-12-hour high/low with times, wind, rain today, UV.
  Removed: pressure, monthly rain, dew point, sunlight W/m2. The gust warning
  (>= 55 km/h in the next 12 h) lives in this tile, not the header.
- Today chart removed. "Energy now" replaced by an Energy flow diagram (solar,
  grid, house, car, animated direction, % of solar going each way) and a
  "Today's electricity" tile with two donuts: where it came from (solar, grid
  off-peak, grid peak, with cost) and where it went (house, car, exported).
  Totals come from the controller's 5-minute series. Allocation: solar serves
  the house first, then the car, the rest is exported.
- Excess solar alert: live spare solar >= 1.4 kW (one 6 A charge) with no car
  charging, sustained for 30 min in the 5-minute series, shows "Excess solar -
  Suggest Car Charging" in the flow tile and the header.

Revision 3 (2026-10-30, Matt's feedback):
- Layout: weather and forecast stacked on the left, radar over today's
  electricity in the middle, energy flow over a new Car charging tile on the
  right. Header notes: "Excess solar - Suggest Car Charging" first and bold,
  then gusts (>= 55 km/h in 12 h, back in the header), then the rest.
- Weather tile decluttered into one clean grid (feels like, humidity, wind,
  rain today, UV, next-12-hour high/low with times).
- Radar looks like BoM: RainViewer's Universal Blue colours are converted back
  to dBZ (their published colour table), then to rain rate with Z = 200R^1.6,
  and repainted in the Bureau's mm/h colour steps from 0.2 mm/h. Unsmoothed
  tiles (0_0) so every pixel is an exact palette colour. Esri Ocean basemap
  (blue sea, pale land) with labels above the rain. Zoom 8 centred to take in
  Dromana, Melbourne and Geelong. Shows "No rain in view" when the latest
  frame is dry, so an empty map doesn't look broken.
- Car charging tile, same logic as ev.html: which car is on the charger (Pi
  tag from kia_poll, else IONIQ 5 when the EV5 says it isn't plugged in), EV5
  battery % and charge limit from Kia Connect, IONIQ 5 "% added since plugged
  in" from kWh / 72.6. While charging: kW, amps, charging since (start of the
  current run in the 5-minute series, or the plug-in time if it ran past
  midnight) and how long. Today's charge time and kWh per car. Links to ev.html.
- Internet pill in the header from UniFi Site Manager (new `unifi` function):
  online, latency, download/upload from the 5-minute ISP metrics, devices.
  Site: UniFi Dream Router (UDR), Aussie Broadband. Needs Netlify env var
  UNIFI_API_KEY; the pill stays hidden until it's set.

Revision 4 (2026-10-30, Matt's feedback):
- Notes moved to their own full-width strip under the clock (up to two rows),
  in this order: official warnings (emergency / watch and act / BoM severe),
  excess solar (bold), wind, UV, advice warnings, which car is plugged in (or
  "No car plugged in"), rain, solar outlook, nearby incidents, Pi offline.
  Warning notes link to the BoM or VicEmergency page.
- Warnings come from the VicEmergency public feed (new `warnings` function):
  BoM weather warnings, fires, floods, EMV advice and planned burns. A warning
  counts when its map area covers Dromana (point-in-polygon) or it's statewide;
  a point incident counts within 15 km (planned burns 8 km). BoM's own app API
  (api.weather.bom.gov.au) carries a "must not use" notice, so it isn't used.
- Wind over 50 km/h (speed or gust, station or next-12-hour forecast) and UV
  of 6 or more go red, bold and bigger: in the weather tile and as red notes.

- Day verdicts match ev.html exactly: same weather labels and the same 1-10
  solar score (8+ good, 5-7 fair, under 5 poor). The "tomorrow" note and the
  forecast rows show that score, so the two pages can't disagree.

Function changes made for it (2026-10-30):
- `ecowitt.js`: zero readings are now 0 instead of null; reads the WS90's
  `rainfall_piezo` block (falls back to `rainfall`); adds feels like, dew point,
  gust, rain event/hourly/weekly/monthly/yearly and station time.
- `forecast.js`: adds hourly wind speed and gusts, daily min/max temperature,
  max rain probability and max gust. Existing fields unchanged.

End of file.
