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

End of file.
