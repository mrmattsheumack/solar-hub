"""Solar Hub EV charging controller (runs on the Pi).

Rules (agreed with Matt, 2026-10-28):
  * 00:00-06:00  Off-peak (8c). Charge at full rate whenever something is plugged in.
  * Daytime      Match charge current to spare solar. Solar only: pause below 6 A.
  * Evening      Off (peak rate, no sun).
  * No car data is used. Only solar (SEMS), the charger's own plug/state, and time.

Modes (ev_mode.json, "mode"): "auto" (default) | "full" | "off".
DRY_RUN=1 (default) logs decisions without commanding the charger.
"""
from __future__ import annotations
import asyncio, json, logging, math, os, time, urllib.request
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
from evsemaster import evse_protocol as ep
import goodwe

TZ = ZoneInfo("Australia/Melbourne")
HOME = os.path.expanduser("~/solar-hub-pi")
CFG = {
    "charger_host": "192.168.1.45",
    "sems_url": "https://solarhubdromana.netlify.app/.netlify/functions/sems",
    "loop_s": 30,
    "sems_every_s": 60,
    "offpeak_start": 0, "offpeak_end": 6,      # hours, local
    "min_amps": 6, "max_amps": 32,
    "start_hold_s": 180,   # surplus must hold >= min_amps this long before starting
    "stop_hold_s": 300,    # surplus must stay below min_amps this long before pausing
    "ramp_up_max": 4,      # max amps increase per loop (ramp down is immediate)
    "headroom_w": 150,     # keep a little export so we don't creep onto the grid
    "sems_stale_s": 600,   # no good solar data for this long -> fail safe (pause in daytime)
    "start_backoff_s": 1800,  # car didn't draw after a start -> wait before retrying
    "sems_lag_s": 360,
    "inverter_host": "192.168.1.155", "inverter_port": 502,   # GoodWe WiFi/LAN Kit-20, Modbus TCP
    "inverter_stale_s": 120,
    "house_floor_w": 400,
    "house_fallback_w": 1500,  # no trustworthy house reading (SEMS down or all zeros): assume a busy house  # SEMS sometimes reports 0 house load (dawn, gaps); never assume less than base load     # SEMS cloud data lags; average car draw over this window when netting it out
}
DRY_RUN = os.environ.get("DRY_RUN", "1") != "0"
LOG_PATH = os.path.join(HOME, "ev_solar.log")
STATE_PATH = os.path.join(HOME, "ev_state.json")
MODE_PATH = os.path.join(HOME, "ev_mode.json")

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("ev_solar")
logging.getLogger("evsemaster").setLevel(logging.ERROR)

PLUG = {1: "unplugged", 2: "plugged", 4: "plugged_locked"}
STATE = {1: "fault", 2: "fault", 3: "fault", 10: "wait_swipe", 11: "wait_button", 12: "not_connected",
         13: "ready", 14: "charging", 15: "complete", 17: "full", 20: "reserved"}


def read_password() -> str:
    for line in open(os.path.join(HOME, ".evse")):
        if line.startswith("EVSE_PASSWORD="):
            return line.split("=", 1)[1].strip()
    raise SystemExit("No EVSE_PASSWORD in ~/solar-hub-pi/.evse")


def read_offpeak() -> bool:
    """Off-peak (12-6 am) charging on/off. Default on."""
    try:
        return bool(json.load(open(MODE_PATH)).get("offpeak", True))
    except Exception:
        return True


def read_mode() -> str:
    try:
        m = json.load(open(MODE_PATH)).get("mode", "auto")
        return m if m in ("auto", "full", "off") else "auto"
    except Exception:
        return "auto"


class Charger:
    """Wraps evsemaster. Decodes the single-phase status packet the library drops."""

    def __init__(self, host, pw):
        self.host, self.pw = host, pw
        self.evse = None
        self.status = None          # dict, updated by every status packet
        self.status_at = 0.0

    def _parse(self, proto, d):
        n = d.length()
        b = bytes(d.get_buffer(0, n))
        if n < 21:
            return
        g = lambda o, l: int.from_bytes(b[o:o + l], "big")
        self.status = {
            "volts": g(1, 2) / 10, "amps": g(3, 2) / 100, "power_w": g(5, 4),
            "total_kwh": g(9, 4) / 100, "plug": PLUG.get(b[18], b[18]),
            "output": b[19], "state": STATE.get(b[20], b[20]), "errors": g(21, 4) if n >= 25 else 0,
        }
        self.status_at = time.time()

    async def ensure(self) -> bool:
        if self.evse and self.evse.is_logged_in:
            return True
        if self.evse:
            try:
                await self.evse.disconnect()
            except Exception:
                pass
            await asyncio.sleep(5)
        self.evse = ep.SimpleEVSEProtocol(self.host, self.pw)
        me = self
        self.evse._parse_status_response = lambda d: me._parse(None, d)
        ok = await self.evse.login()
        log.info("charger login %s", "ok" if ok else "FAILED")
        return ok

    async def refresh(self):
        await self.evse.request_status()
        await asyncio.sleep(3)

    @property
    def limit(self):
        i = self.evse.get_latest_device_info() if self.evse else None
        return i.configured_max_amps if i else None

    async def set_amps(self, a):
        await self.evse.set_output_amperage(int(a))

    async def start(self, a, minutes=None):
        st = (self.status or {}).get("state")
        if st in ("complete", "full", "reserved"):
            # charger ignores a start while it still holds a finished session; clear it first
            await self.evse.stop_charging()
            await asyncio.sleep(6)
        await self.evse.start_charging(max_amps=int(a), duration_minutes=minutes)

    async def stop(self):
        await self.evse.stop_charging()


class Solar:
    def __init__(self, url):
        self.url = url
        self.data = None
        self.ok_at = 0.0
        self.tried_at = 0.0
        self.zero = False

    def poll(self, every):
        if time.time() - self.tried_at < every:
            return
        self.tried_at = time.time()
        try:
            with urllib.request.urlopen(self.url, timeout=25) as r:
                d = json.load(r)
            if "pvPower" in d:
                # SEMS sometimes answers with every field zero (dongle not reporting to the cloud).
                # Keep the data for the log but don't count it as a fresh house reading.
                self.zero = not any(d.get(k) for k in ("pvPower", "homePower", "exportPower", "importPower"))
                self.data = d
                if not self.zero:
                    self.ok_at = time.time()
        except Exception as e:
            log.warning("SEMS fetch failed: %s", e)


class Inverter:
    """Live PV straight from the inverter (no cloud lag). Dark at night, so failures are normal then."""

    def __init__(self, host, port):
        self.host, self.port = host, port
        self.inv = None
        self.pv_w = None
        self.ok_at = 0.0

    async def poll(self):
        try:
            if self.inv is None:
                self.inv = await goodwe.connect(self.host, port=self.port, family="DT", timeout=4, retries=1)
            d = await self.inv.read_runtime_data()
            pv = d.get("total_inverter_power", d.get("ppv"))
            if pv is not None:
                self.pv_w, self.ok_at = float(pv), time.time()
        except Exception as e:
            self.inv = None
            log.debug("inverter read failed: %s", e)


class Controller:
    def __init__(self):
        self.charger = Charger(CFG["charger_host"], read_password())
        self.solar = Solar(CFG["sems_url"])
        self.inverter = Inverter(CFG["inverter_host"], CFG["inverter_port"])
        self.above_since = None
        self.below_since = None
        self.backoff_until = 0.0
        self.last_start = 0.0
        self.target = 0
        self.car_hist = []   # (ts, watts) so we can net the car out of lagged SEMS data
        self.override = False
        self.session_owner = None
        self.pv_source = None
        self.house_source = None
        self.last_house_w = None   # house load excluding the car (what the controller nets out)
        self.last_pv_w = None

    def window(self, now):
        if CFG["offpeak_start"] <= now.hour < CFG["offpeak_end"]:
            return "offpeak"
        return "day" if 6 <= now.hour < 21 else "evening"

    def spare_amps(self, st):
        d = self.solar.data
        volts = (st or {}).get("volts") or 240
        # SEMS homePower includes the car, but lags by several minutes. Net out the car's
        # AVERAGE draw over that lag window, not its live draw, or we chase our own tail.
        t = time.time()
        recent = [w for ts, w in self.car_hist if t - ts <= CFG["sems_lag_s"]]
        car_w = sum(recent) / len(recent) if recent else ((st or {}).get("power_w") or 0)
        sems_ok = not self.solar.zero and t - self.solar.ok_at <= CFG["sems_stale_s"]
        if sems_ok:
            house_w = max(CFG["house_floor_w"], d["homePower"] - car_w)   # SEMS feed is in watts
            self.house_source = "sems"
        else:
            house_w = CFG["house_fallback_w"]
            self.house_source = "fallback"
        live = self.inverter.pv_w is not None and t - self.inverter.ok_at <= CFG["inverter_stale_s"]
        pv_w = self.inverter.pv_w if live else (d["pvPower"] if sems_ok else 0)
        self.pv_source = "inverter" if live else "sems"
        spare_w = pv_w - house_w - CFG["headroom_w"]
        self.last_house_w, self.last_pv_w = round(house_w), round(pv_w)
        return spare_w, max(0, math.floor(spare_w / volts))

    async def act(self, what, fn):
        log.info("%s %s", "WOULD" if DRY_RUN else "DO", what)
        if not DRY_RUN:
            await fn()

    async def step(self):
        now = datetime.now(TZ)
        mode = read_mode()
        offpeak_on = read_offpeak()
        win = self.window(now)
        self.solar.poll(CFG["sems_every_s"])
        if win == "day":
            await self.inverter.poll()
        if not await self.charger.ensure():
            return self.record(now, mode, win, None, None, "charger unreachable")
        await self.charger.refresh()
        st = self.charger.status
        if st:
            self.car_hist.append((time.time(), st.get("power_w") or 0))
            self.car_hist = [h for h in self.car_hist if time.time() - h[0] <= 900]
        plugged = st and st["plug"] in ("plugged", "plugged_locked")
        charging = st and st["state"] == "charging"
        reason = ""

        # ---- manual override ----
        # Any session we did not start ourselves (charger button, EVSEMaster app, the
        # charger's own schedule) wins: full rate, hands off until it ends or is unplugged.
        sess = self.charger.evse.get_latest_charging_status()
        owner = getattr(sess, "user_id", None) if sess else None
        self.session_owner = owner
        skip_schedule = (not offpeak_on and owner == "Clock" and mode != "full")
        if charging and skip_schedule:
            self.override = False
            await self.act("stop the charger's own off-peak schedule (off-peak turned off)", self.charger.stop)
            return self.record(now, mode, win, st, 0, "off-peak turned off: skipped the charger's own midnight schedule")
        if charging and owner and owner != self.charger.evse.user_id:
            self.override = True
        elif not charging or not plugged:
            self.override = False
        if self.override:
            if self.charger.limit != CFG["max_amps"]:
                await self.act(f"override: set limit {self.charger.limit} -> {CFG['max_amps']} A",
                               lambda: self.charger.set_amps(CFG["max_amps"]))
            self.target = CFG["max_amps"]
            return self.record(now, mode, win, st, CFG["max_amps"],
                               f"MANUAL OVERRIDE (session started by '{owner}'), full rate, hands off")
        desired = 0  # amps; 0 = not charging

        if mode == "off":
            desired, reason = 0, "mode off"
        elif win == "offpeak" and mode != "full" and not offpeak_on:
            desired, reason = 0, "off-peak turned off, waiting for solar"
        elif mode == "full" or win == "offpeak":
            desired, reason = CFG["max_amps"], "mode full" if mode == "full" else "off-peak window"
        elif win == "evening":
            desired, reason = 0, "evening peak, no solar"
        else:
            solar_age = time.time() - self.solar.ok_at
            inv_live = self.inverter.pv_w is not None and time.time() - self.inverter.ok_at <= CFG["inverter_stale_s"]
            if not inv_live and (self.solar.data is None or self.solar.zero or solar_age > CFG["sems_stale_s"]):
                desired, reason = 0, f"fail-safe: no solar data for {int(solar_age)}s"
            else:
                spare_w, amps = self.spare_amps(st)
                t = time.time()
                if amps >= CFG["min_amps"]:
                    self.below_since = None
                    self.above_since = self.above_since or t
                    held = t - self.above_since
                    if charging or held >= CFG["start_hold_s"]:
                        cap = (self.target or CFG["min_amps"]) + CFG["ramp_up_max"] if charging else amps
                        desired = min(amps, cap, CFG["max_amps"])
                        reason = f"spare {spare_w:.0f} W -> {desired} A"
                    else:
                        desired = 0
                        reason = f"spare {spare_w:.0f} W, holding {int(held)}/{CFG['start_hold_s']}s before start"
                else:
                    self.above_since = None
                    self.below_since = self.below_since or t
                    held = t - self.below_since
                    if charging and held < CFG["stop_hold_s"]:
                        desired = CFG["min_amps"]
                        reason = f"spare {spare_w:.0f} W low, riding at min {int(held)}/{CFG['stop_hold_s']}s"
                    else:
                        desired, reason = 0, f"spare {spare_w:.0f} W below {CFG['min_amps']} A"

        # ---- apply ----
        if not plugged:
            reason += " | nothing plugged in"
        else:
            if desired == 0 and charging:
                await self.act("stop charging", self.charger.stop)
            if desired == 0 and self.charger.limit not in (None, CFG["max_amps"]):
                await self.act(f"idle: reset limit {self.charger.limit} -> {CFG['max_amps']} A so the button gives full rate",
                               lambda: self.charger.set_amps(CFG["max_amps"]))
            elif desired > 0:
                if self.charger.limit != desired:
                    await self.act(f"set limit {self.charger.limit} -> {desired} A", lambda: self.charger.set_amps(desired))
                if not charging:
                    if time.time() < self.backoff_until:
                        reason += " | start backoff (car didn't draw last time)"
                    else:
                        mins = None
                        if win == "offpeak" and mode != "full":
                            end = now.replace(hour=CFG["offpeak_end"], minute=0, second=0, microsecond=0)
                            mins = max(1, int((end - now).total_seconds() // 60))
                        await self.act(f"start charging at {desired} A" + (f" for {mins} min" if mins else ""),
                                       lambda: self.charger.start(desired, mins))
                        self.last_start = time.time()
                elif self.last_start and time.time() - self.last_start > 120 and (st or {}).get("power_w", 0) < 200:
                    # session open but car not drawing (likely full): back off so we don't spam starts
                    self.backoff_until = time.time() + CFG["start_backoff_s"]
                    self.last_start = 0
        self.target = desired
        self.record(now, mode, win, st, desired, reason)

    def record(self, now, mode, win, st, desired, reason):
        d = self.solar.data or {}
        row = {
            "ts": now.isoformat(timespec="seconds"), "dry_run": DRY_RUN, "mode": mode, "window": win,
            "offpeak": read_offpeak(),
            "pv_kw": round(d["pvPower"] / 1000, 3) if d.get("pvPower") is not None else None,
            "pv_live_w": self.inverter.pv_w if hasattr(self, "inverter") else None, "pv_source": self.pv_source, "house_source": self.house_source,
            "house_w": self.last_house_w if win == "day" else None, "home_kw": round(d["homePower"] / 1000, 3) if d.get("homePower") is not None else None,
            "export_kw": round(d.get("exportPower", 0) / 1000, 3), "import_kw": round(d.get("importPower", 0) / 1000, 3),
            "solar_age_s": int(time.time() - self.solar.ok_at) if self.solar.ok_at else None,
            "charger": st, "limit_a": self.charger.limit if self.charger.evse else None,
            "target_a": desired, "reason": reason,
            "override": self.override, "session_owner": self.session_owner,
        }
        log.info("%s | %s | target %s A | %s", win, mode, desired, reason)
        with open(LOG_PATH, "a") as f:
            f.write(json.dumps(row) + "\n")
        tmp = STATE_PATH + ".tmp"
        json.dump(row, open(tmp, "w"))
        os.replace(tmp, STATE_PATH)

    async def run(self, once=False):
        log.info("EV solar controller starting (DRY_RUN=%s)", DRY_RUN)
        while True:
            try:
                await self.step()
            except Exception as e:
                log.exception("loop error: %s", e)
            if once:
                break
            await asyncio.sleep(CFG["loop_s"])


if __name__ == "__main__":
    import sys
    asyncio.run(Controller().run(once="--once" in sys.argv))
