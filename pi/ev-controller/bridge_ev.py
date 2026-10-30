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
        "decisions": decisions[-600:],
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


