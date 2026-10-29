#!/usr/bin/env python3
"""iZone bridge: authenticated HTTPS front-end for the local iZone controller.

Endpoints:
  GET  /health              -- unauthenticated liveness probe
  POST /api/izone/query     -- bearer; forwards body to <izone>/iZoneRequestV2
  POST /api/izone/command   -- bearer; forwards body to <izone>/iZoneCommandV2
  POST /api/izone/zones     -- bearer; bulk-fetches all 6 zones, returns
                               {"zones": [...], "missing": [int], "stale": [int]}
  GET  /api/ev/state        -- bearer; EV controller state, today series, decisions
  POST /api/ev/mode         -- bearer; {"mode": "auto"|"full"|"off"}
  GET  /api/sensors/temps   -- bearer; returns per-room sensor cache,
                               {"rooms": {...}, "expectedRooms": [...]}

Config via env vars (see .env, loaded by systemd unit):
  BEARER_TOKEN   required; shared secret between Solar Hub and this bridge
  IZONE_BASE     default http://192.168.1.208
  PORT           default 8080
  BIND           default 127.0.0.1  (Cloudflare Tunnel connects locally)
  CORS_ORIGIN    default https://solarhubdromana.netlify.app
  IZONE_TIMEOUT  default 8 (seconds)
"""
from __future__ import annotations

import hmac
import json
import logging
import os
import threading
import time
from collections import defaultdict  # noqa: F401  reserved for future MQTT subscriber

import requests
from flask import Flask, abort, jsonify, request
from flask_cors import CORS

IZONE_BASE = os.environ.get("IZONE_BASE", "http://192.168.1.208").rstrip("/")
BEARER_TOKEN = os.environ.get("BEARER_TOKEN")
PORT = int(os.environ.get("PORT", "8080"))
BIND = os.environ.get("BIND", "127.0.0.1")
CORS_ORIGIN = os.environ.get("CORS_ORIGIN", "https://solarhubdromana.netlify.app")
TIMEOUT = float(os.environ.get("IZONE_TIMEOUT", "8"))

# Single iZone Genius can't handle parallel requests — Flask's threaded=True
# would otherwise let two browser-side polls race each other through the bridge.
# Serialise all outbound iZone traffic with this lock, and reuse a Session so
# the underlying TCP connection stays warm.
_izone_lock = threading.Lock()
_izone_session = requests.Session()

# Last-known good ZonesV2 payload per index. Updated whenever a zone fetch
# returns valid data. Used as a fallback when retries can't get a fresh value
# from iZone, so the bulk endpoint can always return 6 zones (some may be stale).
_zone_cache: dict[int, dict] = {}

# Sensor cache — populated by the (future) MQTT subscriber when ESP32-C3 +
# AHT20 sensors come online. Keyed by room id (master, lounge, charlie,
# mila, office, bath). Each entry: {temp: float, humidity: float, last_update_iso: str}.
_sensor_cache: dict[str, dict] = {}
_sensor_cache_lock = threading.Lock()

if not BEARER_TOKEN:
    raise SystemExit("BEARER_TOKEN env var not set; refusing to start.")

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s"
)
log = logging.getLogger("izone-bridge")

app = Flask(__name__)
CORS(
    app,
    resources={
        r"/api/*": {
            "origins": CORS_ORIGIN,
            "allow_headers": ["Authorization", "Content-Type"],
            "methods": ["GET", "POST", "OPTIONS"],
        },
        r"/health": {
            "origins": CORS_ORIGIN,
            "methods": ["GET", "OPTIONS"],
        },
    },
)


def _require_bearer() -> None:
    header = request.headers.get("Authorization", "")
    if not header.startswith("Bearer "):
        abort(401)
    supplied = header.split(" ", 1)[1]
    if not hmac.compare_digest(supplied, BEARER_TOKEN):
        abort(401)


def _post_with_retry(url, payload):
    """POST to iZone with retries on `{ERROR}` responses.
    Returns (status_code, content_bytes, content_type) or raises
    requests.Timeout / requests.ConnectionError. Retries on `{ERROR}` body
    with backoff 400ms / 800ms / 1600ms (max 3 retries; 4 attempts total).

    Caller is expected to hold _izone_lock — the helper itself does not."""
    backoffs = (0.0, 0.4, 0.8, 1.6)  # first attempt has no pre-sleep
    last_resp = None
    for attempt, sleep_for in enumerate(backoffs):
        if sleep_for > 0:
            time.sleep(sleep_for)
        resp = _izone_session.post(url, json=payload, timeout=TIMEOUT)
        last_resp = resp
        body_text = resp.content.decode("utf-8", errors="replace").strip()
        if body_text != "{ERROR}":
            return (
                resp.status_code,
                resp.content,
                resp.headers.get("Content-Type", "application/json"),
            )
        log.warning("iZone returned {ERROR} on attempt %d for %s", attempt + 1, url)
    log.warning("iZone returned {ERROR} %d times for %s; giving up", len(backoffs), url)
    return (
        last_resp.status_code,
        last_resp.content,
        last_resp.headers.get("Content-Type", "application/json"),
    )


def _forward(path: str):
    payload = request.get_json(force=True, silent=True)
    if payload is None:
        return jsonify({"error": "invalid or missing JSON body"}), 400
    url = f"{IZONE_BASE}{path}"
    with _izone_lock:
        try:
            status, content, ct = _post_with_retry(url, payload)
        except requests.Timeout:
            log.warning("iZone timeout on %s", path)
            return jsonify({"error": "iZone timeout"}), 504
        except requests.ConnectionError as exc:
            log.warning("iZone unreachable (%s): %s", path, exc)
            return jsonify({"error": "iZone unreachable"}), 502
    log.info("%s -> %s (%d bytes)", path, status, len(content))
    # Decode leniently just to test validity — iZone responses can contain
    # stray non-UTF-8 bytes (e.g. in LockCode), but the JSON structure itself
    # is fine. Pass the original bytes through untouched when it parses.
    try:
        json.loads(content.decode("utf-8", errors="replace"))
    except ValueError:
        # iZone replies to some commands with an empty body or bare text
        # like `{OK}` / `{ERROR}`. Wrap so the browser JSON parser doesn't choke.
        raw = content.decode("utf-8", errors="replace").strip()
        return jsonify({"status": "ok", "raw": raw}), 200
    return content, status, {"Content-Type": ct}


@app.get("/health")
def health():
    return jsonify({"status": "ok", "izone_base": IZONE_BASE})


@app.post("/api/izone/query")
def izone_query():
    _require_bearer()
    return _forward("/iZoneRequestV2")


@app.post("/api/izone/command")
def izone_command():
    _require_bearer()
    return _forward("/iZoneCommandV2")


@app.get("/api/sensors/temps")
def sensor_temps():
    """Return current room sensor readings.

    Today returns empty `rooms` (no sensors connected yet).
    Once ESP32 sensors come online and the MQTT subscriber populates
    _sensor_cache, this returns real per-room temp/humidity/lastUpdate data."""
    _require_bearer()
    with _sensor_cache_lock:
        rooms = dict(_sensor_cache)
    return jsonify({
        "rooms": rooms,
        "expectedRooms": ["master", "lounge", "charlie", "mila", "office", "bath"],
    })


def _fetch_one_zone(i: int):
    """Fetch zone i from iZone. Returns the ZonesV2 dict on success, None on
    any error (including iZone's `{ERROR}` rate-limit reply, which fails JSON parse).
    On success, also updates _zone_cache so future bulk fetches can fall back."""
    try:
        resp = _izone_session.post(
            f"{IZONE_BASE}/iZoneRequestV2",
            json={"iZoneV2Request": {"Type": 2, "No": i, "No1": 0}},
            timeout=TIMEOUT,
        )
        data = json.loads(resp.content.decode("utf-8", errors="replace"))
        z = data.get("ZonesV2")
        if z is not None:
            _zone_cache[i] = z
        return z
    except (requests.Timeout, requests.ConnectionError, ValueError) as exc:
        log.warning("zone %d fetch failed: %s", i, exc)
        return None


# Pre-pass backoffs (seconds). Three retry passes total. iZone's `{ERROR}` reply
# means it's still recovering; widening the gap each time gives it longer to settle.
_RETRY_BACKOFFS = (0.4, 0.8, 1.6)


@app.post("/api/izone/zones")
def izone_zones():
    """Bulk fetch all 6 real zones in one call.

    Sequential, lock-protected, session-reused. After the initial sweep, retry any
    missing zones up to 3 times with growing backoff. Anything still missing falls
    back to the in-memory _zone_cache (marked `_stale: true`) so the response
    always contains 6 zones when the bridge has ever seen them.

    Response shape: {"zones": [...], "missing": [int], "stale": [int]}.
      missing — zones that failed every retry AND have no cached value yet.
      stale   — zones served from cache (each carries `_stale: true`)."""
    _require_bearer()
    zones_by_index: dict[int, dict] = {}
    with _izone_lock:
        # Initial sweep
        missing: list[int] = []
        for i in range(6):
            z = _fetch_one_zone(i)
            if z is not None:
                zones_by_index[i] = z
            else:
                missing.append(i)
            if i < 5:
                time.sleep(0.2)
        # Retry passes — only re-poll zones still missing.
        for attempt, backoff in enumerate(_RETRY_BACKOFFS, start=1):
            if not missing:
                break
            time.sleep(backoff)
            still_missing: list[int] = []
            for j, i in enumerate(missing):
                z = _fetch_one_zone(i)
                if z is not None:
                    zones_by_index[i] = z
                else:
                    log.warning("zone %d still missing after attempt %d", i, attempt)
                    still_missing.append(i)
                if j < len(missing) - 1:
                    time.sleep(0.2)
            missing = still_missing
        # Cache fallback: any still-missing zone we've seen before is served stale.
        stale: list[int] = []
        for i in list(missing):
            cached = _zone_cache.get(i)
            if cached is None:
                continue
            zones_by_index[i] = {**cached, "_stale": True}
            stale.append(i)
            missing.remove(i)
    zones = [zones_by_index[i] for i in sorted(zones_by_index)]
    return jsonify({"zones": zones, "missing": missing, "stale": stale}), 200


# ---------------------------------------------------------------------------
# EV charging (added 2026-10-30). Reads what ev_solar.py writes next door.
#   GET  /api/ev/state  -- bearer; latest controller state, today's 5-min
#                          series, recent decisions and today's totals
#   POST /api/ev/mode   -- bearer; {"mode": "auto"|"full"|"off"}
# ---------------------------------------------------------------------------
EV_DIR = os.path.expanduser("~/solar-hub-pi")
EV_STATE = os.path.join(EV_DIR, "ev_state.json")
EV_LOG = os.path.join(EV_DIR, "ev_solar.log")
EV_MODE = os.path.join(EV_DIR, "ev_mode.json")


def _ev_tail_rows(max_bytes: int = 4_000_000) -> list[dict]:
    """Last few MB of the JSON-lines log (about a day and a half of rows)."""
    try:
        with open(EV_LOG, "rb") as f:
            f.seek(0, 2)
            size = f.tell()
            f.seek(max(0, size - max_bytes))
            chunk = f.read().decode("utf-8", errors="replace")
    except FileNotFoundError:
        return []
    rows = []
    for line in chunk.splitlines()[1:] if size > max_bytes else chunk.splitlines():
        try:
            rows.append(json.loads(line))
        except ValueError:
            pass
    return rows


def _ev_mode() -> str:
    try:
        with open(EV_MODE) as f:
            m = json.load(f).get("mode", "auto")
        return m if m in ("auto", "full", "off") else "auto"
    except (FileNotFoundError, ValueError):
        return "auto"


@app.get("/api/ev/state")
def ev_state():
    _require_bearer()
    try:
        with open(EV_STATE) as f:
            latest = json.load(f)
    except (FileNotFoundError, ValueError):
        latest = None
    rows = _ev_tail_rows()
    today = time.strftime("%Y-%m-%d")
    rows = [r for r in rows if str(r.get("ts", "")).startswith(today)]

    # 5-minute series and energy totals
    buckets: dict[str, dict] = {}
    totals = {"car_kwh": 0.0, "car_offpeak_kwh": 0.0, "car_solar_kwh": 0.0, "car_grid_day_kwh": 0.0}
    prev_t = None
    for r in rows:
        c = r.get("charger") or {}
        car_w = float(c.get("power_w") or 0)
        pv_w = r.get("pv_live_w")
        if pv_w is None and r.get("pv_kw") is not None:
            pv_w = r["pv_kw"] * 1000
        pv_w = float(pv_w or 0) if r.get("window") == "day" else 0.0
        home_w = float(r.get("home_kw") or 0) * 1000
        hh, mm = r["ts"][11:13], int(r["ts"][14:16])
        key = f"{hh}:{mm - mm % 5:02d}"
        b = buckets.setdefault(key, {"t": key, "pv": [], "home": [], "car": [], "target": 0})
        b["pv"].append(pv_w); b["home"].append(home_w); b["car"].append(car_w)
        b["target"] = r.get("target_a") or 0
        try:
            t = time.mktime(time.strptime(r["ts"][:19], "%Y-%m-%dT%H:%M:%S"))
        except ValueError:
            continue
        if prev_t is not None and 0 < t - prev_t < 300:
            h = (t - prev_t) / 3600
            e = car_w / 1000 * h
            totals["car_kwh"] += e
            if r.get("window") == "offpeak":
                totals["car_offpeak_kwh"] += e
            elif r.get("window") == "day":
                house_w = max(0.0, home_w - car_w)
                from_solar = min(car_w, max(0.0, pv_w - house_w))
                totals["car_solar_kwh"] += from_solar / 1000 * h
                totals["car_grid_day_kwh"] += (car_w - from_solar) / 1000 * h
        prev_t = t
    avg = lambda xs: round(sum(xs) / len(xs)) if xs else 0
    series = [{"t": b["t"], "pv": avg(b["pv"]), "home": avg(b["home"]), "car": avg(b["car"]), "target": b["target"]}
              for b in (buckets[k] for k in sorted(buckets))]

    # Decisions: rows where what the controller wants, or the charger's state, changed
    decisions, last = [], None
    for r in rows:
        c = r.get("charger") or {}
        sig = (r.get("target_a"), c.get("state"), r.get("override"), r.get("window"))
        if sig != last:
            decisions.append({"ts": r["ts"], "window": r.get("window"), "target_a": r.get("target_a"),
                              "state": c.get("state"), "override": r.get("override"), "reason": r.get("reason")})
            last = sig
    return jsonify({
        "latest": latest,
        "mode": _ev_mode(),
        "series": series,
        "decisions": decisions[-40:],
        "totals": {k: round(v, 2) for k, v in totals.items()},
        "server_time": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    })


@app.post("/api/ev/mode")
def ev_set_mode():
    _require_bearer()
    body = request.get_json(silent=True) or {}
    mode = body.get("mode")
    if mode not in ("auto", "full", "off"):
        return jsonify({"error": "mode must be auto, full or off"}), 400
    tmp = EV_MODE + ".tmp"
    with open(tmp, "w") as f:
        json.dump({"mode": mode, "set_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "set_by": "solar-hub"}, f)
    os.replace(tmp, EV_MODE)
    log.info("EV mode set to %s", mode)
    return jsonify({"mode": mode})



if __name__ == "__main__":
    log.info("iZone bridge starting on %s:%d -> %s", BIND, PORT, IZONE_BASE)
    app.run(host=BIND, port=PORT, threaded=True)
