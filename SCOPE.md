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
venv ~/solar-hub-pi/evtest. DRY_RUN=1 (watch only) until Matt approves live.
Logs: ~/solar-hub-pi/ev_solar.log (JSON lines), ev_state.json (latest).

## SEMS endpoint change (2026-10-29)

After GoodWe moved the account to SEMS+, GetMonitorDetailByPowerstationId
returns code 0 with empty data, so Solar Hub showed zeros. Live data now comes
from v2/PowerStation/GetPowerflow (gridStatus -1 = import, 1 = export) and
today's generation from v3/PowerStation/GetPlantDetailByPowerstationId.

End of file.
