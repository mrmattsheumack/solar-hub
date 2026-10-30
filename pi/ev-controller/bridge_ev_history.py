# ---------------------------------------------------------------------------
# EV all-time history (added 2026-10-30)
#   GET /api/ev/history -- bearer; one row per day from ev_solar.log:
#     car kWh split solar / off-peak grid / daytime grid, plus solar and house kWh.
#   Finished days are cached in ev_daily_cache.json so the log is only read once.
# ---------------------------------------------------------------------------
EV_DAILY_CACHE = os.path.join(EV_DIR, "ev_daily_cache.json")


def _ev_day_summary(rows: list[dict]) -> dict:
    t_prev = None
    out = {"car_solar_kwh": 0.0, "car_offpeak_kwh": 0.0, "car_grid_day_kwh": 0.0,
           "solar_kwh": 0.0, "house_kwh": 0.0, "export_kwh": 0.0, "import_kwh": 0.0}
    for r in rows:
        try:
            t = time.mktime(time.strptime(r["ts"][:19], "%Y-%m-%dT%H:%M:%S"))
        except (KeyError, ValueError):
            continue
        if t_prev is not None and 0 < t - t_prev < 300:
            h = (t - t_prev) / 3600
            c = r.get("charger") or {}
            car = float(c.get("power_w") or 0)
            pv = r.get("pv_live_w")
            if pv is None and r.get("pv_kw") is not None:
                pv = r["pv_kw"] * 1000
            pv = float(pv or 0) if r.get("window") == "day" else 0.0
            house = r.get("house_w")
            if house is None:
                house = max(0.0, float(r.get("home_kw") or 0) * 1000 - car)
            house = float(house)
            from_solar = min(car, max(0.0, pv - house)) if r.get("window") == "day" else 0.0
            if r.get("window") == "offpeak":
                out["car_offpeak_kwh"] += car / 1000 * h
            else:
                out["car_solar_kwh"] += from_solar / 1000 * h
                out["car_grid_day_kwh"] += (car - from_solar) / 1000 * h
            out["solar_kwh"] += pv / 1000 * h
            out["house_kwh"] += house / 1000 * h
            net = pv - house - car
            out["export_kwh" if net > 0 else "import_kwh"] += abs(net) / 1000 * h
        t_prev = t
    return {k: round(v, 2) for k, v in out.items()}


@app.get("/api/ev/history")
def ev_history():
    _require_bearer()
    today = time.strftime("%Y-%m-%d")
    try:
        with open(EV_DAILY_CACHE) as f:
            cache = json.load(f)
    except (FileNotFoundError, ValueError):
        cache = {}
    by_day: dict[str, list] = {}
    try:
        with open(EV_LOG) as f:
            for line in f:
                d = line[8:18]          # line starts {"ts": "YYYY-MM-DD
                if d in cache and d != today:
                    continue
                try:
                    r = json.loads(line)
                except ValueError:
                    continue
                by_day.setdefault(r["ts"][:10], []).append(r)
    except FileNotFoundError:
        pass
    changed = False
    for d, rows in by_day.items():
        cache[d] = _ev_day_summary(rows)
        if d != today:
            changed = True
    if changed:
        tmp = EV_DAILY_CACHE + ".tmp"
        with open(tmp, "w") as f:
            json.dump({k: v for k, v in cache.items() if k != today}, f)
        os.replace(tmp, EV_DAILY_CACHE)
    days = [{"date": d, **cache[d]} for d in sorted(cache)]
    return jsonify({"days": days, "server_time": time.strftime("%Y-%m-%dT%H:%M:%S%z")})


