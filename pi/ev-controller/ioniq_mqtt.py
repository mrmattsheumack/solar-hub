#!/usr/bin/env python3
"""IONIQ 5 readings from the WiCAN (OBD-II to WiFi) via the local MQTT broker.

The WiCAN publishes its vehicle-profile results (JSON) to a topic under wican/.
This keeps the latest values in ev_ioniq.json for the dashboard and kia_poll.py.
Labels only: nothing here ever controls the charger."""
import json, os, time, logging
from datetime import datetime
from pathlib import Path
import paho.mqtt.client as mqtt

D = Path.home() / "solar-hub-pi"
OUT = D / "ev_ioniq.json"
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("ioniq")
cfg = dict(l.strip().split("=", 1) for l in (D / ".mqtt").read_text().splitlines() if "=" in l)
state = json.loads(OUT.read_text()) if OUT.exists() else {}

def iso(): return datetime.now().astimezone().isoformat(timespec="seconds")
def save():
    tmp = OUT.with_suffix(".tmp"); tmp.write_text(json.dumps(state)); os.replace(tmp, OUT)
def num(v):
    try: return float(v)
    except (TypeError, ValueError): return None

def on_connect(c, u, flags, rc, props=None):
    log.info("connected to broker (rc=%s), subscribing to wican/#", rc)
    c.subscribe("wican/#")

def on_message(c, u, m):
    payload = m.payload.decode(errors="replace").strip()
    if m.topic.endswith("/status") or payload in ("online", "offline"):
        state["wican_status"] = payload; state["status_at"] = iso(); save(); return
    try:
        d = json.loads(payload)
    except ValueError:
        return
    if not isinstance(d, dict): return
    if isinstance(d.get("autopid_data"), dict): d = d["autopid_data"]
    got = {}
    soc_d, soc = num(d.get("SOC_D")), num(d.get("SOC"))
    if soc_d is not None and 0 <= soc_d <= 100: got["soc"] = round(soc_d, 1)        # the % the dash shows
    elif soc is not None and 0 <= soc <= 100: got["soc"] = round(soc, 1)
    if soc is not None and 0 <= soc <= 100: got["soc_bms"] = round(soc, 1)
    for k_in, k_out in (("CHARGING", "charging"), ("CHARGING_DC", "charging_dc")):
        v = num(d.get(k_in))
        if v is not None: got[k_out] = bool(v)
    for k_in, k_out in (("KWH_CHARGED", "kwh_charged_total"), ("KWH_DISCHARGED", "kwh_discharged_total"),
                        ("SOH", "soh"), ("HV_V", "hv_volts"), ("AUX_V", "aux_volts"), ("BATT_12V", "aux_volts")):
        v = num(d.get(k_in))
        if v is not None: got[k_out] = round(v, 2)
    if not got: return
    state.update(got); state["updated_at"] = iso(); state["topic"] = m.topic
    save()
    log.info("IONIQ 5: %s", got)

c = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="solar-hub-ioniq")
c.username_pw_set(cfg["MQTT_USER"], cfg["MQTT_PASSWORD"])
c.on_connect, c.on_message = on_connect, on_message
while True:
    try:
        c.connect("127.0.0.1", 1883, 60); c.loop_forever()
    except Exception as e:
        log.warning("mqtt error: %s", e); time.sleep(30)
