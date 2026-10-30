#!/usr/bin/env python3
"""Kia Connect poller: works out which car is on the charger and reads the EV5's battery.

Labels only. It never touches the charger: ev_solar.py reads ev_car.json to tag each
log row with the car, and the bridge serves it to the dashboard.

  plug-in seen     -> wake the EV5 for a fresh status (falls back to the stored one)
                      EV5 plugged in and at home -> "ev5", otherwise -> "ioniq5"
  EV5 on charger   -> stored status every 15 min, a fresh wake every 2 h while charging
  otherwise        -> stored status hourly, so the page knows the EV5's battery anyway
  unplugged        -> tag cleared
A manual pick on the dashboard (ev_car_manual.json) wins for the current plug-in.
Wakes are capped per day to stay well inside Kia's request limits."""
import json, logging, math, os, time
from datetime import datetime, timezone
from pathlib import Path
from hyundai_kia_connect_api import VehicleManager

D = Path.home() / "solar-hub-pi"
STATE, OUT, MANUAL, HOME = D / "ev_state.json", D / "ev_car.json", D / "ev_car_manual.json", D / ".kia_home.json"
CFG = {"loop_s": 60, "cached_on_s": 900, "cached_off_s": 3600, "force_charging_s": 7200,
       "force_retry_s": 300, "force_per_day": 10, "home_m": 300, "fresh_slack_s": 600}
PLUGGED = ("plugged", "plugged_locked")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("kia")
logging.getLogger("hyundai_kia_connect_api").setLevel(logging.WARNING)


def now(): return time.time()
def iso(t=None): return datetime.fromtimestamp(t or now()).astimezone().isoformat(timespec="seconds")
def read_json(p, default=None):
    try: return json.loads(p.read_text())
    except (FileNotFoundError, ValueError): return default
def write_json(p, obj):
    tmp = p.with_suffix(".tmp"); tmp.write_text(json.dumps(obj)); os.replace(tmp, p)
def dist_m(a, b):
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 6371000 * 2 * math.asin(math.sqrt(h))


class Kia:
    def __init__(self):
        cfg = {}
        for line in (D / ".kia").read_text().splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                k, v = line.split("=", 1); cfg[k.strip()] = v.strip().strip("'\"")
        self.vm = VehicleManager(region=5, brand=1, username=cfg["KIA_USERNAME"],
                                 password=cfg["KIA_PASSWORD"], pin=cfg.get("KIA_PIN", ""))
        self.home = read_json(HOME)
        self.forces, self.force_day = 0, ""

    def read(self, force=False):
        """Returns (ev5 dict, forced_ok)."""
        self.vm.check_and_refresh_token()
        forced = False
        if force:
            day = time.strftime("%Y-%m-%d")
            if day != self.force_day: self.force_day, self.forces = day, 0
            if self.forces < CFG["force_per_day"]:
                self.forces += 1
                try:
                    for vid in self.vm.vehicles: self.vm.force_refresh_vehicle_state(vid)
                    forced = True
                except Exception as e:
                    log.warning("wake failed (%s), using stored status", str(e)[:120])
            else:
                log.info("daily wake budget used, using stored status")
        self.vm.update_all_vehicles_with_cached_state()
        v = next(iter(self.vm.vehicles.values()))
        at_home = None
        if self.home and v.location_latitude is not None:
            at_home = dist_m((self.home["lat"], self.home["lon"]), (v.location_latitude, v.location_longitude)) < CFG["home_m"]
        st = v.last_updated_at.timestamp() if v.last_updated_at else None
        return {"soc": v.ev_battery_percentage, "plugged": bool(v.ev_battery_is_plugged_in),
                "charging": bool(v.ev_battery_is_charging), "limit_ac": getattr(v, "ev_charge_limits_ac", None),
                "range_km": v.ev_driving_range, "at_home": at_home,
                "status_time": iso(st) if st else None, "_st": st}, forced


def main():
    kia = Kia()
    out = read_json(OUT, {}) or {}
    out.setdefault("car", None)
    plug_since = None           # local timestamp the current plug-in was first seen
    was_plugged = None
    last_cached = last_force = 0.0
    need_identify = False
    while True:
        try:
            st = read_json(STATE, {}) or {}
            c = st.get("charger") or {}
            plug = c.get("plug")
            plugged = plug in PLUGGED if plug else was_plugged     # no status: keep what we had
            charging = float(c.get("power_w") or 0) > 500
            t = now()
            if plugged and not was_plugged:
                plug_since = t if was_plugged is False else (t if not out.get("car_since") else
                             datetime.fromisoformat(out["car_since"]).timestamp())
                need_identify = was_plugged is False or not out.get("car")
                log.info("plug-in seen (%s)", "new" if was_plugged is False else "already plugged at start")
            if was_plugged and plugged is False:
                log.info("unplugged, clearing car tag")
                out.update({"car": None, "car_since": None, "car_how": None})
                try: MANUAL.unlink()
                except FileNotFoundError: pass
                need_identify = False
            was_plugged = plugged

            manual = read_json(MANUAL)
            if plugged and manual and manual.get("car") in ("ev5", "ioniq5"):
                if out.get("car") != manual["car"] or out.get("car_how") != "manual":
                    out.update({"car": manual["car"], "car_how": "manual", "car_since": out.get("car_since") or iso(plug_since)})
                    log.info("manual tag: %s", manual["car"])
                need_identify = False

            do_force = (need_identify and t - last_force > CFG["force_retry_s"]) or \
                       (plugged and out.get("car") == "ev5" and charging and t - last_force > CFG["force_charging_s"])
            gap = CFG["cached_on_s"] if plugged else CFG["cached_off_s"]
            if do_force or t - last_cached > gap:
                ev5, forced = kia.read(force=do_force)
                last_cached = t
                if do_force: last_force = t
                fresh = forced or (ev5["_st"] and plug_since and ev5["_st"] >= plug_since - CFG["fresh_slack_s"])
                if need_identify and fresh:
                    car = "ev5" if ev5["plugged"] and ev5["at_home"] is not False else "ioniq5"
                    out.update({"car": car, "car_how": "kia_connect" if car == "ev5" else "elimination",
                                "car_since": iso(plug_since)})
                    need_identify = False
                    log.info("car on charger: %s (EV5 plugged=%s at_home=%s)", car, ev5["plugged"], ev5["at_home"])
                elif plugged and out.get("car") == "ioniq5" and out.get("car_how") != "manual" and fresh \
                        and ev5["plugged"] and ev5["charging"] and ev5["at_home"] and charging:
                    out.update({"car": "ev5", "car_how": "kia_connect"})      # corrected by a later reading
                    log.info("re-tagged as ev5")
                ev5.pop("_st", None)
                out["ev5"] = ev5
                out["checked_at"] = iso(t)
                out["last_error"] = None
            write_json(OUT, out)
        except Exception as e:
            log.warning("poll error: %s", str(e)[:200])
            out["last_error"] = str(e)[:200]
            try: write_json(OUT, out)
            except Exception: pass
            time.sleep(120)
        time.sleep(CFG["loop_s"])


if __name__ == "__main__":
    main()
